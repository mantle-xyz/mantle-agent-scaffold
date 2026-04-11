import { formatUnits } from "viem";
import { CHAIN_CONFIGS } from "../config/chains.js";
import { MantleMcpError } from "../errors.js";
import { getPublicClient } from "../lib/clients.js";
import { normalizeNetwork } from "../lib/network.js";
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
  }
};
