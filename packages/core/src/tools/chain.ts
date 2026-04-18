import { formatUnits, isAddress, isHex } from "viem";
import { TransactionReceiptNotFoundError } from "viem";
import { CHAIN_CONFIGS } from "../config/chains.js";
import { MantleMcpError } from "../errors.js";
import { getPublicClient } from "../lib/clients.js";
import { normalizeNetwork } from "../lib/network.js";
import { decodeRevertFromError, revertInfoToDetails } from "../lib/revert-decoder.js";
import type { Tool } from "../types.js";

interface ChainStatusClient {
  getChainId: () => Promise<number | bigint>;
  getBlockNumber: () => Promise<number | bigint>;
  getGasPrice: () => Promise<bigint>;
}

interface ChainStatusDeps {
  getClient: (network: "mainnet" | "sepolia") => ChainStatusClient;
  now: () => string;
}

const defaultDeps: ChainStatusDeps = {
  getClient: getPublicClient,
  now: () => new Date().toISOString()
};

export async function getChainInfo(args: Record<string, unknown>): Promise<any> {
  const { network } = normalizeNetwork(args);
  return CHAIN_CONFIGS[network];
}

export async function getChainStatus(
  args: Record<string, unknown>,
  deps: ChainStatusDeps = defaultDeps
): Promise<any> {
  const { network } = normalizeNetwork(args);
  const client = deps.getClient(network);
  const expectedChainId = CHAIN_CONFIGS[network].chain_id;

  try {
    const [chainId, blockNumber, gasPrice] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
      client.getGasPrice()
    ]);

    if (Number(chainId) !== expectedChainId) {
      throw new MantleMcpError(
        "CHAIN_ID_MISMATCH",
        `RPC chain ID ${String(chainId)} does not match requested ${expectedChainId}.`,
        "Check RPC endpoint configuration for the requested network.",
        { expected_chain_id: expectedChainId, actual_chain_id: Number(chainId) }
      );
    }

    return {
      chain_id: Number(chainId),
      block_number: Number(blockNumber),
      gas_price_wei: gasPrice.toString(),
      gas_price_gwei: formatUnits(gasPrice, 9),
      timestamp_utc: deps.now(),
      syncing: false
    };
  } catch (error) {
    if (error instanceof MantleMcpError) {
      throw error;
    }
    throw new MantleMcpError(
      "RPC_ERROR",
      error instanceof Error ? error.message : String(error),
      "Retry or verify the configured RPC endpoint.",
      { retryable: true, raw_error: error instanceof Error ? error.message : String(error) }
    );
  }
}

export async function getTransactionReceipt(args: Record<string, unknown>): Promise<any> {
  const { network } = normalizeNetwork(args);
  const hash = typeof args.hash === "string" ? args.hash.trim() : "";

  if (!hash || !isHex(hash) || hash.length !== 66) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "Transaction hash must be a 66-character hex string (0x + 64 hex chars).",
      "Provide a valid transaction hash, e.g. 0xabc123...def456.",
      { field: "hash", value: hash || null }
    );
  }

  const client = getPublicClient(network);

  try {
    const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });

    // Also fetch the transaction to get value, from, to, input
    let txData: any = null;
    try {
      txData = await client.getTransaction({ hash: hash as `0x${string}` });
    } catch {
      // Non-critical — proceed without tx data
    }

    return {
      hash: receipt.transactionHash,
      status: receipt.status === "success" ? "success" : "reverted",
      block_number: Number(receipt.blockNumber),
      from: receipt.from,
      to: receipt.to,
      gas_used: receipt.gasUsed.toString(),
      effective_gas_price_wei: receipt.effectiveGasPrice.toString(),
      effective_gas_price_gwei: formatUnits(receipt.effectiveGasPrice, 9),
      fee_mnt: formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18),
      value_wei: txData?.value?.toString() ?? null,
      value_mnt: txData?.value != null ? formatUnits(txData.value, 18) : null,
      input_data: txData?.input ?? null,
      logs_count: receipt.logs.length,
      contract_address: receipt.contractAddress ?? null
    };
  } catch (error) {
    if (error instanceof MantleMcpError) throw error;

    // Use viem's typed error for precise classification — not string matching.
    if (error instanceof TransactionReceiptNotFoundError) {
      throw new MantleMcpError(
        "TX_NOT_FOUND",
        `Transaction ${hash} not found or not yet mined.`,
        "Verify the hash is correct and the transaction has been included in a block. If recently broadcast, wait a few seconds and retry.",
        { hash, network }
      );
    }

    // Infrastructure / RPC failure — do not mask as "not found"
    const errMsg = error instanceof Error ? error.message : String(error);
    throw new MantleMcpError(
      "RPC_ERROR",
      `Failed to query transaction ${hash}: ${errMsg}`,
      "This is an RPC connectivity issue, not a missing transaction. Retry the query or check the RPC endpoint.",
      { hash, network, retryable: true, raw_error: errMsg }
    );
  }
}

export async function estimateGas(args: Record<string, unknown>): Promise<any> {
  const { network } = normalizeNetwork(args);

  const to = typeof args.to === "string" && isAddress(args.to, { strict: false }) ? args.to : null;
  if (!to) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "Target address (to) is required for gas estimation.",
      "Provide the 'to' address from the unsigned_tx object.",
      { field: "to" }
    );
  }

  const from = typeof args.from === "string" && isAddress(args.from, { strict: false }) ? args.from : null;
  const data = typeof args.data === "string" && args.data.length > 0 ? args.data : null;
  const value = typeof args.value === "string" ? args.value : "0x0";

  const client = getPublicClient(network);
  const warnings: string[] = [];

  // Detect if target is a contract — if so, calldata is essential
  if (!data || data === "0x") {
    try {
      const code = await client.getCode({ address: to as `0x${string}` });
      if (code && code !== "0x" && code.length > 2) {
        if (!data || data === "0x") {
          throw new MantleMcpError(
            "MISSING_CALLDATA",
            `Target ${to} is a contract, but no calldata (data) was provided. ` +
              `Estimating gas with empty calldata will simulate a fallback/receive call, not the intended operation.`,
            "Provide the 'data' field from the unsigned_tx object for accurate contract call estimation.",
            { to, network }
          );
        }
      }
    } catch (e) {
      if (e instanceof MantleMcpError) throw e;
      // Cannot determine if contract — proceed with warning
      if (!data || data === "0x") {
        warnings.push(
          "No calldata (data) provided. If the target is a contract, this estimates a plain transfer/fallback call, not the intended operation."
        );
      }
    }
  }

  if (!from) {
    warnings.push(
      "No sender address (from) provided. Gas estimation may be inaccurate for transactions that " +
      "depend on msg.sender (swaps, Aave operations, approvals). Provide --from for reliable estimates."
    );
  }

  try {
    const estimateParams: Record<string, unknown> = {
      to: to as `0x${string}`,
      data: (data ?? "0x") as `0x${string}`,
      value: BigInt(value)
    };
    if (from) {
      estimateParams.account = from as `0x${string}`;
    }

    const [gasEstimate, gasPrice] = await Promise.all([
      client.estimateGas(estimateParams as any),
      client.getGasPrice()
    ]);

    const feeWei = gasEstimate * gasPrice;

    return {
      gas_limit: gasEstimate.toString(),
      gas_price_wei: gasPrice.toString(),
      gas_price_gwei: formatUnits(gasPrice, 9),
      estimated_fee_wei: feeWei.toString(),
      estimated_fee_mnt: formatUnits(feeWei, 18),
      from: from ?? "not specified (estimate may be inaccurate)",
      network,
      warnings
    };
  } catch (error) {
    if (error instanceof MantleMcpError) throw error;
    const revertInfo = decodeRevertFromError(error);
    const revertDetails = revertInfoToDetails(revertInfo);
    const baseMessage = `Gas estimation failed: ${error instanceof Error ? error.message : String(error)}`;
    const enrichedMessage = revertInfo?.message
      ? `${baseMessage} [revert: ${revertInfo.message}]`
      : baseMessage;
    throw new MantleMcpError(
      "GAS_ESTIMATION_FAILED",
      enrichedMessage,
      "The transaction may revert on-chain. Inspect `revert_raw` (always set when the call " +
        "reverted, even as `0x`) and `revert_selector` (the 4-byte custom error id, set when " +
        "the revert returned ≥4 bytes) in details. `revert_message` decodes Error(string) and " +
        "Panic(uint256) automatically; custom errors outside that set are surfaced raw. Provide " +
        "--from for context-aware estimation.",
      { to, from: from ?? null, network, ...revertDetails }
    );
  }
}

export const chainTools: Record<string, Tool> = {
  getChainInfo: {
    name: "mantle_getChainInfo",
    description:
      "Return static chain configuration for mainnet or sepolia (Mantle native gas token is MNT). Examples: mainnet chain_id=5000 with WMNT=0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8; sepolia chain_id=5003 with WMNT=0x19f5557E23e9914A18239990f6C70D68FDF0deD5.",
    inputSchema: {
      type: "object",
      properties: {
        network: {
          type: "string",
          description: "Network name (mainnet, sepolia).",
          enum: ["mainnet", "sepolia"]
        }
      },
      required: []
    },
    handler: getChainInfo
  },
  getChainStatus: {
    name: "mantle_getChainStatus",
    description:
      "Return live block height and gas price from Mantle RPC. Examples: mainnet block_number=12345678 and gas_price_gwei=\"0.02\"; sepolia health check before running token workflows.",
    inputSchema: {
      type: "object",
      properties: {
        network: {
          type: "string",
          description: "Network name (mainnet, sepolia).",
          enum: ["mainnet", "sepolia"]
        }
      },
      required: []
    },
    handler: getChainStatus
  },
  getTransactionReceipt: {
    name: "mantle_getTransactionReceipt",
    description:
      "Fetch on-chain transaction receipt by hash: status (success/reverted), gas used, " +
      "fee in MNT, value transferred, from/to addresses, and log count. " +
      "Use this to verify transaction results — NEVER manually call eth_getTransactionReceipt " +
      "or parse raw RPC responses.\n\n" +
      "Examples:\n" +
      "- Check swap result: hash='0x...'\n" +
      "- Verify transfer: hash='0x...'",
    inputSchema: {
      type: "object",
      properties: {
        hash: {
          type: "string",
          description: "Transaction hash (0x-prefixed, 66 chars)."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["hash"]
    },
    handler: getTransactionReceipt
  },
  estimateGas: {
    name: "mantle_estimateGas",
    description:
      "Estimate gas cost for an unsigned transaction. Pass the to/data/value " +
      "fields from any unsigned_tx object. Provide 'from' (sender address) for " +
      "reliable estimates on DeFi transactions that depend on msg.sender.\n\n" +
      "Examples:\n" +
      "- Estimate swap cost: pass to, data, value, and from (sender wallet) from the unsigned_tx JSON output",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Target contract address from unsigned_tx.to."
        },
        from: {
          type: "string",
          description: "Sender wallet address. Recommended for accurate estimates on swaps, Aave, and LP operations."
        },
        data: {
          type: "string",
          description: "Calldata from unsigned_tx.data (hex string)."
        },
        value: {
          type: "string",
          description: "Value from unsigned_tx.value (hex string, default '0x0')."
        },
        network: {
          type: "string",
          description: "Network: 'mainnet' (default) or 'sepolia'."
        }
      },
      required: ["to"]
    },
    handler: estimateGas
  }
};
