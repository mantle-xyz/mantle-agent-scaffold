import { describe, expect, it } from "vitest";
import { MantleMcpError } from "@0xwh1sker/mantle-core/errors.js";
import { resolveAddress, validateAddress } from "@0xwh1sker/mantle-core/tools/registry.js";

describe("registry tools", () => {
  it("resolves a known token from registry", async () => {
    const result = await resolveAddress({ identifier: "USDC", network: "mainnet" });
    expect(result.address).toBe("0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9");
    expect(result.confidence).toBe("high");
    expect(result.category).toBe("token");
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
});
