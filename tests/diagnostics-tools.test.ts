import { describe, expect, it } from "vitest";
import { checkRpcHealth, probeEndpoint } from "@0xwh1sker/mantle-core/tools/diagnostics.js";

describe("diagnostics tools", () => {
  it("reports RPC health with matching chain id", async () => {
    const result = await checkRpcHealth(
      {
        network: "mainnet",
        rpc_url: "https://rpc.mantle.xyz"
      },
      {
        rpcCall: async (url, method) => {
          if (method === "eth_chainId") {
            return { jsonrpc: "2.0", id: 1, result: "0x1388" };
          }
          if (method === "eth_blockNumber") {
            return { jsonrpc: "2.0", id: 1, result: "0xbc614e" };
          }
          throw new Error(`unexpected method ${method} for ${url}`);
        },
        now: () => "2026-02-28T00:00:00.000Z"
      }
    );

    expect(result.reachable).toBe(true);
    expect(result.chain_id).toBe(5000);
    expect(result.chain_id_matches).toBe(true);
    expect(result.block_number).toBe(12345678);
  });

  it("probes endpoint method", async () => {
    const result = await probeEndpoint(
      {
        rpc_url: "https://rpc.mantle.xyz",
        method: "eth_blockNumber"
      },
      {
        rpcCall: async () => ({ jsonrpc: "2.0", id: 1, result: "0x10" }),
        now: () => "2026-02-28T00:00:00.000Z"
      }
    );

    expect(result.success).toBe(true);
    expect(result.result).toBe("0x10");
    expect(result.method).toBe("eth_blockNumber");
  });

  it("rejects invalid method at runtime", async () => {
    await expect(
      probeEndpoint(
        {
          rpc_url: "https://rpc.mantle.xyz",
          method: "eth_sendRawTransaction"
        },
        {
          rpcCall: async () => ({ jsonrpc: "2.0", id: 1, result: "0x10" }),
          now: () => "2026-02-28T00:00:00.000Z"
        }
      )
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects unsafe endpoint in probe", async () => {
    await expect(
      probeEndpoint({
        rpc_url: "http://169.254.169.254/latest/meta-data",
        method: "eth_chainId"
      })
    ).rejects.toMatchObject({ code: "ENDPOINT_NOT_ALLOWED" });
  });
});
