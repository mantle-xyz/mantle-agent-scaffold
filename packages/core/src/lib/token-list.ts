import { createHash } from "node:crypto";

export interface TokenListEntry {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
  name?: string;
}

export interface TokenListSnapshot {
  version: string | null;
  tokens: TokenListEntry[];
}

const DEFAULT_TOKEN_LIST_URL = "https://token-list.mantle.xyz/mantle.tokenlist.json";
const DEFAULT_TTL_SECONDS = 300;

let cached: { expiresAt: number; snapshot: TokenListSnapshot } | null = null;

function hashPayload(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

export async function fetchTokenListSnapshot(): Promise<TokenListSnapshot> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.snapshot;
  }

  const url = process.env.MANTLE_TOKEN_LIST_URL ?? DEFAULT_TOKEN_LIST_URL;
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Token list fetch failed: ${response.status}`);
  }

  const body = await response.text();
  const json = JSON.parse(body) as {
    tokens?: TokenListEntry[];
    name?: string;
    timestamp?: string;
  };

  const hash = hashPayload(body);
  const etag = response.headers.get("etag");
  const version = etag ?? json.timestamp ?? hash;

  const pinHash = process.env.MANTLE_TOKEN_LIST_PIN_HASH;
  if (pinHash && pinHash !== hash && pinHash !== version) {
    throw new Error("Pinned token-list hash mismatch.");
  }

  const snapshot: TokenListSnapshot = {
    version,
    tokens: Array.isArray(json.tokens) ? json.tokens : []
  };

  const ttlSeconds = Number(process.env.MANTLE_TOKEN_LIST_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : DEFAULT_TTL_SECONDS * 1000;
  cached = {
    expiresAt: now + ttlMs,
    snapshot
  };
  return snapshot;
}

export function clearTokenListCache(): void {
  cached = null;
}
