import { describe, expect, it } from "vitest";
import { MantleMcpError } from "@0xwh1sker/mantle-core/errors.js";
import { getChainInfo, getChainStatus } from "@0xwh1sker/mantle-core/tools/chain.js";

describe("chain tools", () => {
  it("returns mainnet chain info by default", async () => {
    const result = await getChainInfo({});
    expect(result.chain_id).toBe(5000);
    expect(result.rpc_url).toBe("https://rpc.mantle.xyz");
    expect(result.native_token.symbol).toBe("MNT");
  });

  it("returns chain status from client", async () => {
    const result = await getChainStatus(
      { network: "mainnet" },
      {
        getClient: () => ({
          getChainId: async () => 5000,
          getBlockNumber: async () => 12345678n,
          getGasPrice: async () => 20_000_000n
        }),
        now: () => "2026-02-28T00:00:00.000Z"
      }
    );

    expect(result.chain_id).toBe(5000);
    expect(result.block_number).toBe(12345678);
    expect(result.gas_price_wei).toBe("20000000");
    expect(result.gas_price_gwei).toBe("0.02");
    expect(result.timestamp_utc).toBe("2026-02-28T00:00:00.000Z");
  });

  it("throws UNSUPPORTED_NETWORK for unknown network", async () => {
    await expect(getChainInfo({ network: "devnet" })).rejects.toMatchObject({
      code: "UNSUPPORTED_NETWORK"
    });
  });
});
