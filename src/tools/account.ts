import { formatUnits, getAddress, isAddress } from "viem";
import { MantleMcpError } from "../errors.js";
import { getPublicClient } from "../lib/clients.js";
import { ERC20_ABI } from "../lib/erc20.js";
import { normalizeNetwork } from "../lib/network.js";
import { resolveTokenInput as resolveTokenInputFromRegistry } from "../lib/token-registry.js";
import { findRegistryByAddress } from "../lib/registry.js";
import type { ResolvedTokenInput } from "../lib/token-registry.js";
import type { Tool } from "../types.js";

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
      throw new MantleMcpError(
        "CLIENT_ERROR",
        "readContract not implemented on client.",
        "Verify the RPC client supports contract reads.",
        { method: "balanceOf" }
      );
    }
    return (await client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [owner as `0x${string}`]
    })) as bigint;
  },
  readTokenAllowance: async (client, tokenAddress, owner, spender) => {
    if (!client.readContract) {
      throw new MantleMcpError(
        "CLIENT_ERROR",
        "readContract not implemented on client.",
        "Verify the RPC client supports contract reads.",
        { method: "allowance" }
      );
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
      : Promise.reject(
          new MantleMcpError(
            "CLIENT_ERROR",
            "getBalance not implemented on client.",
            "Verify the RPC client supports balance queries.",
            { method: "getBalance" }
          )
        ),
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
  const balances = await Promise.all(
    tokens.map(async (rawToken) => {
      const token = String(rawToken);
      try {
        const resolved = await resolvedDeps.resolveTokenInput(token, network);
        if (resolved.address === "native") {
          throw new MantleMcpError(
            "UNSUPPORTED_TOKEN",
            "Native token is not supported in token balance reads.",
            "Use mantle_getBalance for native MNT balance.",
            { token, resolved_address: "native" }
          );
        }
        const balanceRaw = await resolvedDeps.readTokenBalance(client, resolved.address, address);
        return {
          token_address: resolved.address,
          symbol: resolved.symbol,
          decimals: resolved.decimals,
          balance_raw: balanceRaw.toString(),
          balance_normalized:
            resolved.decimals == null ? null : formatUnits(balanceRaw, resolved.decimals),
          error: null
        };
      } catch (error) {
        return {
          token_address: null,
          symbol: null,
          decimals: null,
          balance_raw: "0",
          balance_normalized: null,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );
  const partial = balances.some((entry) => entry.error !== null);

  return {
    address,
    network,
    balances,
    block_number: Number(blockNumber),
    collected_at_utc: resolvedDeps.now(),
    partial
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
          throw new MantleMcpError(
            "UNSUPPORTED_TOKEN",
            "Native token has no allowance mapping.",
            "Allowances apply only to ERC-20 tokens, not native MNT.",
            { token: tokenInput, resolved_address: "native" }
          );
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
  getBalance: {
    name: "mantle_getBalance",
    description:
      "Get native MNT balance for an address. Examples: address=0x458F293454fE0d67EC0655f3672301301DD51422 -> balance_mnt='1.5' before contract operations.",
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
