import { describe, expect, it } from "vitest";
import { listResources, readResource } from "@0xwh1sker/mantle-mcp/resources.js";

describe("resources", () => {
  it("lists required v0.2 resources", () => {
    const uris = listResources().map((resource) => resource.uri).sort();
    expect(uris).toEqual([
      "mantle://chain/mainnet",
      "mantle://chain/sepolia",
      "mantle://docs/network-basics",
      "mantle://docs/risk-checklist",
      "mantle://registry/capabilities",
      "mantle://registry/contracts",
      "mantle://registry/protocols",
      "mantle://registry/tokens"
    ]);
  });

  it("returns mainnet chain config resource payload", () => {
    const result = readResource("mantle://chain/mainnet");
    expect(result).not.toBeNull();
    const payload = JSON.parse(result!.content);
    expect(payload.chain_id).toBe(5000);
    expect(payload.native_token.symbol).toBe("MNT");
  });

  it("returns protocol registry with Ondo marked planned", () => {
    const result = readResource("mantle://registry/protocols");
    expect(result).not.toBeNull();
    const payload = JSON.parse(result!.content);
    expect(payload.mainnet.ondo.status).toBe("planned");
  });

  it("returns network basics and risk checklist docs", () => {
    const basics = readResource("mantle://docs/network-basics");
    const checklist = readResource("mantle://docs/risk-checklist");
    expect(basics).not.toBeNull();
    expect(checklist).not.toBeNull();
    expect(basics!.mimeType).toBe("text/markdown");
    expect(checklist!.mimeType).toBe("text/markdown");
    expect(basics!.content).toContain("Mantle Network Basics");
    expect(checklist!.content).toContain("Risk Checklist");
  });
});
