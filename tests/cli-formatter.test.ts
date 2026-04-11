import { describe, expect, it, vi, beforeEach } from "vitest";
import { formatKeyValue, formatJson, formatTable, formatError } from "@0xwh1sker/mantle-cli/formatter.js";

describe("formatJson", () => {
  it("outputs pretty-printed JSON to stdout", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    formatJson({ key: "value", num: 42 });
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ key: "value", num: 42 }, null, 2));
    spy.mockRestore();
  });

  it("handles null", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    formatJson(null);
    expect(spy).toHaveBeenCalledWith("null");
    spy.mockRestore();
  });
});

describe("formatKeyValue", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prints key-value pairs", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    formatKeyValue({ chain_id: 5000, name: "Mantle" }, {
      labels: { chain_id: "Chain ID", name: "Name" }
    });

    const output = logs.join("\n");
    expect(output).toContain("Chain ID");
    expect(output).toContain("5000");
    expect(output).toContain("Name");
    expect(output).toContain("Mantle");
  });

  it("respects order option", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    formatKeyValue({ b: "second", a: "first" }, {
      order: ["a", "b"],
      labels: { a: "Alpha", b: "Beta" }
    });

    const output = logs.join("\n");
    const alphaIdx = output.indexOf("Alpha");
    const betaIdx = output.indexOf("Beta");
    expect(alphaIdx).toBeLessThan(betaIdx);
  });
});

describe("formatTable", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("prints table with header and rows", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    formatTable(
      [
        { symbol: "MNT", price: 0.82 },
        { symbol: "USDC", price: 1.0 }
      ],
      [
        { key: "symbol", label: "Token" },
        { key: "price", label: "Price" }
      ]
    );

    const output = logs.join("\n");
    expect(output).toContain("Token");
    expect(output).toContain("Price");
    expect(output).toContain("MNT");
    expect(output).toContain("USDC");
  });

  it("shows 'No results' for empty rows", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    formatTable([], [{ key: "x", label: "X" }]);

    const output = logs.join("\n");
    expect(output).toContain("No results");
  });
});

describe("formatError", () => {
  it("prints error to stderr", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    formatError({ code: "TEST_ERR", message: "Something failed", suggestion: "Try again" });

    const output = spy.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
    expect(output).toContain("Something failed");
    expect(output).toContain("TEST_ERR");
    expect(output).toContain("Try again");
    spy.mockRestore();
  });
});
