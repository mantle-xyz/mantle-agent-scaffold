import { describe, expect, it } from "vitest";
import {
  parseCommaList,
  parseJsonString,
  parseJsonArray,
  applyRpcOverride,
  parseIntegerOption,
  parseNumberOption
} from "@0xwh1sker/mantle-cli/utils.js";

describe("parseCommaList", () => {
  it("splits comma-separated values", () => {
    expect(parseCommaList("MNT,USDC,WETH")).toEqual(["MNT", "USDC", "WETH"]);
  });

  it("trims whitespace", () => {
    expect(parseCommaList(" MNT , USDC , WETH ")).toEqual(["MNT", "USDC", "WETH"]);
  });

  it("filters empty strings", () => {
    expect(parseCommaList("MNT,,USDC,")).toEqual(["MNT", "USDC"]);
  });

  it("handles single value", () => {
    expect(parseCommaList("MNT")).toEqual(["MNT"]);
  });

  it("returns empty array for empty string", () => {
    expect(parseCommaList("")).toEqual([]);
  });
});

describe("parseJsonString", () => {
  it("parses valid JSON object", () => {
    expect(parseJsonString('{"key":"value"}', "test")).toEqual({ key: "value" });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseJsonString("not-json", "test")).toThrow("must be valid JSON");
  });

  it("throws on JSON array", () => {
    expect(() => parseJsonString("[1,2,3]", "test")).toThrow("must be valid JSON");
  });

  it("throws on JSON primitive", () => {
    expect(() => parseJsonString('"string"', "test")).toThrow("must be valid JSON");
  });
});

describe("parseJsonArray", () => {
  it("parses valid JSON array", () => {
    expect(parseJsonArray('[1, "0x123"]', "test")).toEqual([1, "0x123"]);
  });

  it("throws on JSON object", () => {
    expect(() => parseJsonArray('{"a":1}', "test")).toThrow("must be a valid JSON array");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseJsonArray("nope", "test")).toThrow("must be a valid JSON array");
  });
});

describe("applyRpcOverride", () => {
  const originalMainnet = process.env.MANTLE_RPC_URL;
  const originalSepolia = process.env.MANTLE_SEPOLIA_RPC_URL;

  it("sets mainnet RPC URL", () => {
    applyRpcOverride("https://custom-rpc.example.com", "mainnet");
    expect(process.env.MANTLE_RPC_URL).toBe("https://custom-rpc.example.com");
    process.env.MANTLE_RPC_URL = originalMainnet;
  });

  it("sets sepolia RPC URL", () => {
    applyRpcOverride("https://custom-sepolia.example.com", "sepolia");
    expect(process.env.MANTLE_SEPOLIA_RPC_URL).toBe("https://custom-sepolia.example.com");
    process.env.MANTLE_SEPOLIA_RPC_URL = originalSepolia;
  });

  it("does nothing when rpcUrl is undefined", () => {
    const before = process.env.MANTLE_RPC_URL;
    applyRpcOverride(undefined, "mainnet");
    expect(process.env.MANTLE_RPC_URL).toBe(before);
  });
});

describe("parseIntegerOption", () => {
  it("parses integer strings", () => {
    expect(parseIntegerOption("42", "--test")).toBe(42);
  });

  it("throws on non-integer values", () => {
    expect(() => parseIntegerOption("abc", "--test")).toThrow("must be a valid integer");
  });

  it("throws on decimal values", () => {
    expect(() => parseIntegerOption("3.14", "--test")).toThrow("must be a valid integer");
  });
});

describe("parseNumberOption", () => {
  it("parses finite numbers", () => {
    expect(parseNumberOption("3.14", "--test")).toBe(3.14);
  });

  it("throws on non-numeric values", () => {
    expect(() => parseNumberOption("abc", "--test")).toThrow("must be a valid number");
  });
});
