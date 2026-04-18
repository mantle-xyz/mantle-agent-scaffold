import { describe, expect, it } from "vitest";
import { MantleMcpError } from "@mantleio/mantle-core/errors.js";
import { resolveAddress, validateAddress } from "@mantleio/mantle-core/tools/registry.js";
import { MANTLE_TOKENS } from "@mantleio/mantle-core/config/tokens.js";
import { getAddress } from "viem";

describe("registry tools", () => {
  it("resolves a known token from registry", async () => {
    const result = await resolveAddress({ identifier: "USDC", network: "mainnet" });
    expect(result.address).toBe("0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9");
    expect(result.confidence).toBe("high");
    expect(result.category).toBe("token");
    expect(result.decimals).toBe(6);
  });

  it("supports legacy environment=testnet alias", async () => {
    const result = await resolveAddress({ identifier: "WMNT", environment: "testnet" });
    expect(result.network).toBe("sepolia");
    expect(result.warnings.join(" ")).toContain("deprecated");
  });

  it("throws ADDRESS_NOT_FOUND on unknown identifier", async () => {
    await expect(resolveAddress({ identifier: "NOT_REAL", network: "mainnet" })).rejects.toMatchObject({
      code: "ADDRESS_NOT_FOUND"
    });
  });

  it("validates address format and checks code when requested", async () => {
    const result = await validateAddress(
      {
        address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8",
        check_code: true,
        network: "mainnet"
      },
      {
        getClient: () => ({
          getBytecode: async () => "0x1234"
        })
      }
    );

    expect(result.valid_format).toBe(true);
    expect(result.has_code).toBe(true);
    expect(result.registry_match).toBeTruthy();
  });

  it("returns null decimals for non-token categories", async () => {
    const result = await resolveAddress({ identifier: "AGNI_ROUTER", network: "mainnet" });
    expect(result.category).toBe("defi");
    expect(result.decimals).toBeNull();
  });

  it("resolves every ERC-20 in tokens.ts with matching decimals/address", async () => {
    for (const [network, tokens] of Object.entries(MANTLE_TOKENS)) {
      for (const [key, token] of Object.entries(tokens)) {
        if (token.address === "native") continue; // native MNT is not in registry by design
        const result = await resolveAddress({ identifier: key, network });
        expect(result.category, `${network}/${key} category`).toBe("token");
        expect(result.address, `${network}/${key} address`).toBe(getAddress(token.address));
        expect(result.decimals, `${network}/${key} decimals`).toBe(token.decimals);
      }
    }
  });
});
