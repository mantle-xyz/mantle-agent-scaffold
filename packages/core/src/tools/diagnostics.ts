import { CHAIN_CONFIGS } from "../config/chains.js";
import { MantleMcpError } from "../errors.js";
import { getRpcUrl } from "../lib/clients.js";
import { ensureEndpointSafe, safeFetchOptions } from "../lib/endpoint-policy.js";
import { normalizeNetwork } from "../lib/network.js";
import type { Tool } from "../types.js";

interface DiagnosticsDeps {
  rpcCall: (endpoint: string, method: string, params?: unknown[]) => Promise<any>;
  now: () => string;
}

const ALLOWED_PROBE_METHODS = ["eth_chainId", "eth_blockNumber", "eth_getBalance"] as const;

type ProbeMethod = (typeof ALLOWED_PROBE_METHODS)[number];

const defaultDeps: DiagnosticsDeps = {
  rpcCall: async (endpoint, method, params = []) => {
    const response = await fetch(endpoint, safeFetchOptions({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    }));
    const json = await response.json();
    if (json.error) {
      throw new Error(json.error.message ?? "RPC error");
    }
    return json;
  },
  now: () => new Date().toISOString()
};

function withDeps(overrides?: Partial<DiagnosticsDeps>): DiagnosticsDeps {
  return {
    ...defaultDeps,
    ...overrides
  };
}

function hexToNumber(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  if (!value.startsWith("0x")) {
    return null;
  }
  const parsed = Number.parseInt(value.slice(2), 16);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function checkRpcHealth(
  args: Record<string, unknown>,
  deps?: Partial<DiagnosticsDeps>
): Promise<any> {
  const resolvedDeps = withDeps(deps);
  const { network } = normalizeNetwork(args);
  const endpointInput = typeof args.rpc_url === "string" ? args.rpc_url : getRpcUrl(network);
  const endpoint = (await ensureEndpointSafe(endpointInput)).toString();

  const started = Date.now();
  try {
    const [chainIdRes, blockNumberRes] = await Promise.all([
      resolvedDeps.rpcCall(endpoint, "eth_chainId"),
      resolvedDeps.rpcCall(endpoint, "eth_blockNumber")
    ]);

    const chainId = hexToNumber(chainIdRes.result);
    const blockNumber = hexToNumber(blockNumberRes.result);
    const expectedChainId = CHAIN_CONFIGS[network].chain_id;

    return {
      endpoint,
      reachable: true,
      chain_id: chainId,
      chain_id_matches: chainId == null ? null : chainId === expectedChainId,
      block_number: blockNumber,
      latency_ms: Date.now() - started,
      error: null,
      checked_at_utc: resolvedDeps.now()
    };
  } catch (error) {
    return {
      endpoint,
      reachable: false,
      chain_id: null,
      chain_id_matches: null,
      block_number: null,
      latency_ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      checked_at_utc: resolvedDeps.now()
    };
  }
}

export async function probeEndpoint(
  args: Record<string, unknown>,
  deps?: Partial<DiagnosticsDeps>
): Promise<any> {
  const resolvedDeps = withDeps(deps);
  const endpointInput = typeof args.rpc_url === "string" ? args.rpc_url : "";
  if (!endpointInput) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "rpc_url is required.",
      "Provide rpc_url for mantle_probeEndpoint.",
      null
    );
  }

  const endpoint = (await ensureEndpointSafe(endpointInput)).toString();
  const methodInput =
    typeof args.method === "string" ? args.method : "eth_blockNumber";

  if (!ALLOWED_PROBE_METHODS.includes(methodInput as ProbeMethod)) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `Method not allowed: ${methodInput}`,
      `Use one of: ${ALLOWED_PROBE_METHODS.join(", ")}.`,
      { method: methodInput }
    );
  }

  const method = methodInput as ProbeMethod;
  const params = Array.isArray(args.params) ? args.params : undefined;

  const started = Date.now();
  try {
    const response = await resolvedDeps.rpcCall(endpoint, method, params);
    return {
      endpoint,
      method,
      success: true,
      result: response.result ?? null,
      error: null,
      latency_ms: Date.now() - started,
      probed_at_utc: resolvedDeps.now()
    };
  } catch (error) {
    throw new MantleMcpError(
      "ENDPOINT_UNREACHABLE",
      error instanceof Error ? error.message : String(error),
      "Verify endpoint URL and method parameters, then retry.",
      { endpoint, method, retryable: true }
    );
  }
}

export const diagnosticsTools: Record<string, Tool> = {
  checkRpcHealth: {
    name: "mantle_checkRpcHealth",
    description:
      "Check RPC endpoint health and chain-id consistency. Examples: mainnet https://rpc.mantle.xyz should match chain 5000 and support USDC workflows at 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9.",
    inputSchema: {
      type: "object",
      properties: {
        rpc_url: { type: "string", description: "Optional RPC URL to test." },
        network: {
          type: "string",
          enum: ["mainnet", "sepolia"],
          description: "Target network"
        }
      },
      required: []
    },
    handler: checkRpcHealth
  },
  probeEndpoint: {
    name: "mantle_probeEndpoint",
    description:
      "Probe a specific JSON-RPC endpoint with a minimal method call. Examples: eth_blockNumber against https://rpc.mantle.xyz for router checks near 0x319B69888b0d11cEC22caA5034e25FfFBDc88421.",
    inputSchema: {
      type: "object",
      properties: {
        rpc_url: { type: "string", description: "RPC endpoint to probe." },
        method: {
          type: "string",
          enum: ["eth_chainId", "eth_blockNumber", "eth_getBalance"],
          description: "RPC method"
        },
        params: { type: "array", description: "Optional method params." }
      },
      required: ["rpc_url"]
    },
    handler: probeEndpoint
  }
};
