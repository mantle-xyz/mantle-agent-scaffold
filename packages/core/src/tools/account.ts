import { formatUnits, getAddress, isAddress } from "viem";
import { MantleMcpError } from "../errors.js";
import { getPublicClient } from "../lib/clients.js";
import { ERC20_ABI } from "../lib/abis/erc20.js";
import { normalizeNetwork } from "../lib/network.js";
import { resolveTokenInput as resolveTokenInputFromRegistry } from "../lib/token-registry.js";
import { findRegistryByAddress } from "../lib/registry.js";
import type { ResolvedTokenInput } from "../lib/token-registry.js";
import type { Tool } from "../types.js";

type BatchResult =
  | { status: "success"; balance: bigint }
  | { status: "failure"; error: string };

interface AccountDeps {
  getClient: (network: "mainnet" | "sepolia") => any;
  now: () => string;
  resolveTokenInput: (
    token: string,
    network?: "mainnet" | "sepolia"
  ) => Promise<ResolvedTokenInput> | ResolvedTokenInput;
  readTokenBalance: (
    client: any,
    tokenAddress: string,
    owner: string
  ) => Promise<bigint>;
  readTokenBalancesBatch: (
    client: any,
    tokenAddresses: string[],
    owner: string
  ) => Promise<BatchResult[]>;
  readTokenAllowance: (
    client: any,
    tokenAddress: string,
    owner: string,
    spender: string
  ) => Promise<bigint>;
  resolveSpenderLabel: (network: "mainnet" | "sepolia", spender: string) => string | null;
}

const defaultDeps: AccountDeps = {
  getClient: getPublicClient,
  now: () => new Date().toISOString(),
  resolveTokenInput: (token, network) => resolveTokenInputFromRegistry(token, network ?? "mainnet"),
  readTokenBalance: async (client, tokenAddress, owner) => {
    if (!client.readContract) {
      throw new Error("readContract not implemented on client");
    }
    return (await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner as `0x${string}`]
    })) as bigint;
  },
  readTokenBalancesBatch: async (client, tokenAddresses, owner) => {
    if (!client.multicall) {
      throw new Error("multicall not implemented on client");
    }
    const contracts = tokenAddresses.map((addr) => ({
      address: addr as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf" as const,
      args: [owner as `0x${string}`],
    }));
    const results = await client.multicall({ contracts });
    return results.map((r: { status: string; result?: unknown; error?: any }) => {
      if (r.status === "success") {
        return { status: "success" as const, balance: r.result as bigint };
      }
      return {
        status: "failure" as const,
        error: r.error?.message ?? "multicall read failed",
      };
    });
  },
  readTokenAllowance: async (client, tokenAddress, owner, spender) => {
    if (!client.readContract) {
      throw new Error("readContract not implemented on client");
    }
    return (await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner as `0x${string}`, spender as `0x${string}`]
    })) as bigint;
  },
  resolveSpenderLabel: (network, spender) => findRegistryByAddress(network, spender)?.label ?? null
};

function withDeps(overrides?: Partial<AccountDeps>): AccountDeps {
  return {
    ...defaultDeps,
    ...overrides
  };
}

function requireAddress(input: unknown, fieldName: string): string {
  if (typeof input !== "string" || !isAddress(input, { strict: false })) {
    throw new MantleMcpError(
      "INVALID_ADDRESS",
      `${fieldName} must be a valid address.`,
      "Provide an EIP-55 address string.",
      { field: fieldName, value: input ?? null }
    );
  }
  return getAddress(input);
}

export async function getNonce(
  args: Record<string, unknown>,
  deps?: Partial<AccountDeps>
): Promise<any> {
  const resolvedDeps = withDeps(deps);
  const { network } = normalizeNetwork(args);
  const address = requireAddress(args.address, "address");
  const client = resolvedDeps.getClient(network);

  const [pendingNonce, blockNumber] = await Promise.all([
    client.getTransactionCount
      ? client.getTransactionCount({ address: address as `0x${string}`, blockTag: "pending" })
      : Promise.reject(new Error("getTransactionCount not implemented on client")),
    client.getBlockNumber()
  ]);

  return {
    address,
    network,
    nonce: pendingNonce,
    block_number: Number(blockNumber),
    collected_at_utc: resolvedDeps.now()
  };
}

export async function getBalance(
  args: Record<string, unknown>,
  deps?: Partial<AccountDeps>
): Promise<any> {
  const resolvedDeps = withDeps(deps);
  const { network } = normalizeNetwork(args);
  const address = requireAddress(args.address, "address");
  const client = resolvedDeps.getClient(network);

  const [balanceWei, blockNumber] = await Promise.all([
    client.getBalance
      ? client.getBalance({ address: address as `0x${string}` })
      : Promise.reject(new Error("getBalance not implemented on client")),
    client.getBlockNumber()
  ]);

  return {
    address,
    network,
    balance_wei: balanceWei.toString(),
    balance_mnt: formatUnits(balanceWei, 18),
    block_number: Number(blockNumber),
    collected_at_utc: resolvedDeps.now()
  };
}

export async function getTokenBalances(
  args: Record<string, unknown>,
  deps?: Partial<AccountDeps>
): Promise<any> {
  const resolvedDeps = withDeps(deps);
  const { network } = normalizeNetwork(args);
  const address = requireAddress(args.address, "address");
  const tokens = Array.isArray(args.tokens) ? args.tokens : [];
  const client = resolvedDeps.getClient(network);
  const blockNumber = await client.getBlockNumber();

  // Phase 1: Resolve all token inputs in parallel
  const resolutions = await Promise.all(
    tokens.map(async (rawToken) => {
      const token = String(rawToken);
      try {
        const resolved = await resolvedDeps.resolveTokenInput(token, network);
        if (resolved.address === "native") {
          return { ok: false as const, token, error: "native token is not supported in token balance reads; use mantle_getBalance" };
        }
        return { ok: true as const, token, resolved };
      } catch (error) {
        return { ok: false as const, token, error: error instanceof Error ? error.message : String(error) };
      }
    })
  );

  // Phase 2: Batch multicall for all successfully-resolved tokens
  const successfulResolutions = resolutions.filter(
    (r): r is Extract<typeof r, { ok: true }> => r.ok
  );
  const tokenAddresses = successfulResolutions.map((r) => r.resolved.address);

  let batchResults: BatchResult[] = [];
  let batchError: string | null = null;
  if (tokenAddresses.length > 0) {
    try {
      batchResults = await resolvedDeps.readTokenBalancesBatch(client, tokenAddresses, address);
    } catch (error) {
      batchError = error instanceof Error ? error.message : String(error);
      batchResults = tokenAddresses.map(() => ({
        status: "failure" as const,
        error: batchError!,
      }));
    }
  }

  // Phase 3: Assemble results — map back from multicall to per-token output
  let batchIdx = 0;
  const balances = resolutions.map((resolution) => {
    if (!resolution.ok) {
      return {
        token_address: null,
        symbol: null,
        decimals: null,
        balance_raw: "0",
        balance_normalized: null,
        error: resolution.error,
      };
    }
    const { resolved } = resolution;
    const batchResult = batchResults[batchIdx++];
    if (batchResult.status === "failure") {
      return {
        token_address: resolved.address,
        symbol: resolved.symbol,
        decimals: resolved.decimals,
        balance_raw: "0",
        balance_normalized: null,
        error: batchResult.error,
      };
    }
    return {
      token_address: resolved.address,
      symbol: resolved.symbol,
      decimals: resolved.decimals,
      balance_raw: batchResult.balance.toString(),
      balance_normalized:
        resolved.decimals == null ? null : formatUnits(batchResult.balance, resolved.decimals),
      error: null,
    };
  });

  const partial = balances.some((entry) => entry.error !== null);

  return {
    address,
    network,
    balances,
    block_number: Number(blockNumber),
    collected_at_utc: resolvedDeps.now(),
    partial,
  };
}

export async function getAllowances(
  args: Record<string, unknown>,
  deps?: Partial<AccountDeps>
): Promise<any> {
  const resolvedDeps = withDeps(deps);
  const { network } = normalizeNetwork(args);
  const owner = requireAddress(args.owner, "owner");
  const pairs = Array.isArray(args.pairs) ? args.pairs : [];
  const client = resolvedDeps.getClient(network);
  const blockNumber = await client.getBlockNumber();
  const allowances = await Promise.all(
    pairs.map(async (pairRaw) => {
      const pair = pairRaw as { token?: string; spender?: string };
      const tokenInput = String(pair.token ?? "");
      try {
        const spender = requireAddress(pair.spender, "spender");
        const token = await resolvedDeps.resolveTokenInput(tokenInput, network);
        if (token.address === "native") {
          throw new Error("native token has no allowance mapping");
        }
        const allowanceRaw = await resolvedDeps.readTokenAllowance(
          client,
          token.address,
          owner,
          spender
        );
        return {
          token_address: token.address,
          token_symbol: token.symbol,
          token_decimals: token.decimals,
          spender,
          spender_label: resolvedDeps.resolveSpenderLabel(network, spender),
          allowance_raw: allowanceRaw.toString(),
          allowance_normalized:
            token.decimals == null ? null : formatUnits(allowanceRaw, token.decimals),
          is_unlimited: allowanceRaw >= 2n ** 255n,
          error: null
        };
      } catch (error) {
        return {
          token_address: null,
          token_symbol: null,
          token_decimals: null,
          spender: pair.spender ?? null,
          spender_label: null,
          allowance_raw: "0",
          allowance_normalized: null,
          is_unlimited: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );
  const partial = allowances.some((entry) => entry.error !== null);

  return {
    owner,
    network,
    allowances,
    block_number: Number(blockNumber),
    collected_at_utc: resolvedDeps.now(),
    partial
  };
}

export const accountTools: Record<string, Tool> = {
  getNonce: {
    name: "mantle_getNonce",
    description:
      "Get the current pending nonce (transaction count) for an address. Use this when the user reports nonce errors during signing/broadcast, then pass the returned nonce value (including 0 for fresh accounts) to build tools via the nonce parameter. Use the returned nonce immediately — it reflects the mempool state at collected_at_utc and may become stale within seconds if other transactions are pending. Examples: address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 -> nonce=5 (pass as nonce param to build tools to avoid nonce conflicts).",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Wallet address to query nonce for." },
        network: { type: "string", enum: ["mainnet", "sepolia"], description: "Network." }
      },
      required: ["address"]
    },
    handler: getNonce
  },
  getBalance: {
    name: "mantle_getBalance",
    description:
      "Get native MNT balance for an address. Examples: address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 -> balance_mnt='1.5' before contract operations.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Wallet address." },
        network: { type: "string", enum: ["mainnet", "sepolia"], description: "Network." }
      },
      required: ["address"]
    },
    handler: getBalance
  },
  getTokenBalances: {
    name: "mantle_getTokenBalances",
    description:
      "Batch read ERC-20 token balances for an address. Examples: tokens=['USDC','WETH'] -> 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9 and 0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Wallet address." },
        tokens: { type: "array", description: "Token symbols or addresses." },
        network: { type: "string", enum: ["mainnet", "sepolia"], description: "Network." }
      },
      required: ["address", "tokens"]
    },
    handler: getTokenBalances
  },
  getAllowances: {
    name: "mantle_getAllowances",
    description:
      "Batch read ERC-20 allowances for token/spender pairs. Examples: pair {token:'USDC', spender:'0x319B69888b0d11cEC22caA5034e25FfFBDc88421'} for Agni Router.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Owner address." },
        pairs: { type: "array", description: "Allowance token/spender pairs." },
        network: { type: "string", enum: ["mainnet", "sepolia"], description: "Network." }
      },
      required: ["owner", "pairs"]
    },
    handler: getAllowances
  }
};
