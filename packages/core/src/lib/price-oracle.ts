import type { Network } from "../types.js";

const DEXSCREENER_API_BASE = "https://api.dexscreener.com";
const DEFILLAMA_PRICES_API_BASE = "https://coins.llama.fi/prices/current";
const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";
const COINGECKO_PRO_API_BASE = "https://pro-api.coingecko.com/api/v3";

export const PRICE_AGREE_PCT = 0.03;
export const PRICE_WARN_PCT = 0.15;

export interface PriceRawSources {
  coingecko: number | null;
  dexscreener: number | null;
  defillama: number | null;
}

export interface PriceValidation {
  price: number | null;
  source: "coingecko" | "dexscreener" | "defillama" | "aggregate" | "none";
  confidence: "high" | "medium" | "low";
  warnings: string[];
  price_sources: PriceRawSources;
}

export interface PriceOracleFetchers {
  coingecko: (network: Network, tokenAddress: string) => Promise<number | null>;
  dexscreener: (network: Network, tokenAddress: string) => Promise<number | null>;
  defillama: (network: Network, tokenAddress: string) => Promise<number | null>;
}

async function fetchJsonSafe(url: string, headers: Record<string, string> = {}, timeoutMs = 3000): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryable = false;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json", ...headers },
        signal: controller.signal
      });
      if (response.ok) return await response.json();
      if (response.status >= 400 && response.status < 500) return null;
      retryable = true;
    } catch {
      retryable = true;
    } finally {
      clearTimeout(timer);
    }
    if (!retryable || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
  }
  return null;
}

export async function fetchDexScreenerTokenPriceUsd(
  network: Network,
  tokenAddress: string
): Promise<number | null> {
  if (network !== "mainnet") return null;
  const payload = await fetchJsonSafe(`${DEXSCREENER_API_BASE}/tokens/v1/mantle/${tokenAddress}`);
  if (!Array.isArray(payload) || payload.length === 0) return null;

  const addrLower = tokenAddress.toLowerCase();
  const baseMatches = payload.filter(
    (pair: any) => pair.baseToken?.address?.toLowerCase() === addrLower
  );
  const candidates: any[] = baseMatches.length > 0 ? baseMatches : payload;
  const sorted = [...candidates].sort((a: any, b: any) => {
    const toNum = (value: unknown) => {
      const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
      return Number.isFinite(n) ? n : 0;
    };
    return toNum(b.liquidity?.usd) - toNum(a.liquidity?.usd);
  });

  for (const pair of sorted) {
    const price = typeof pair.priceUsd === "string" ? Number(pair.priceUsd) : null;
    if (price != null && Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

export async function fetchDefiLlamaTokenPriceUsd(
  network: Network,
  tokenAddress: string
): Promise<number | null> {
  if (network !== "mainnet") return null;
  const key = `mantle:${tokenAddress.toLowerCase()}`;
  const payload = await fetchJsonSafe(`${DEFILLAMA_PRICES_API_BASE}/${key}`);
  const price = payload?.coins?.[key]?.price;
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}

export async function fetchCoinGeckoTokenPriceUsd(
  network: Network,
  tokenAddress: string
): Promise<number | null> {
  if (network !== "mainnet") return null;
  const addr = tokenAddress.toLowerCase();
  const env = typeof process !== "undefined" ? process.env : undefined;
  const proKey = env?.COINGECKO_PRO_API_KEY;
  const demoKey = env?.COINGECKO_DEMO_API_KEY ?? env?.COINGECKO_API_KEY;
  const base = proKey ? COINGECKO_PRO_API_BASE : COINGECKO_API_BASE;
  const url = `${base}/simple/token_price/mantle?contract_addresses=${addr}&vs_currencies=usd`;
  const headers: Record<string, string> = {};
  if (proKey) headers["x-cg-pro-api-key"] = proKey;
  else if (demoKey) headers["x-cg-demo-api-key"] = demoKey;

  const payload = await fetchJsonSafe(url, headers);
  const price = payload?.[addr]?.usd;
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}

export function crossValidatePrices(
  coingecko: number | null,
  dexscreener: number | null,
  defillama: number | null
): PriceValidation {
  const price_sources: PriceRawSources = { coingecko, dexscreener, defillama };
  const fmt = (n: number) => `$${n.toPrecision(6)}`;
  const pct = (d: number) => `${(d * 100).toFixed(1)}%`;

  if (coingecko != null) {
    const secondaries = [
      { name: "DexScreener", value: dexscreener },
      { name: "DefiLlama", value: defillama }
    ].filter((s): s is { name: string; value: number } => s.value != null);

    if (secondaries.length === 0) {
      return {
        price: coingecko,
        source: "coingecko",
        confidence: "medium",
        warnings: ["CoinGecko price unverified — secondary sources returned no data."],
        price_sources
      };
    }

    const maxDev = Math.max(
      ...secondaries.map((s) => Math.abs(coingecko - s.value) / coingecko)
    );

    if (maxDev <= PRICE_AGREE_PCT) {
      return { price: coingecko, source: "coingecko", confidence: "high", warnings: [], price_sources };
    }

    const worst = secondaries.reduce((a, b) =>
      Math.abs(coingecko - a.value) >= Math.abs(coingecko - b.value) ? a : b
    );

    if (maxDev <= PRICE_WARN_PCT) {
      return {
        price: coingecko,
        source: "coingecko",
        confidence: "medium",
        warnings: [
          `Price sources diverge by ${pct(maxDev)} ` +
          `(CoinGecko ${fmt(coingecko)} vs ${worst.name} ${fmt(worst.value)}) — using CoinGecko as primary.`
        ],
        price_sources
      };
    }

    const details = secondaries.map((s) => `${s.name}: ${fmt(s.value)}`).join(", ");
    return {
      price: coingecko,
      source: "coingecko",
      confidence: "low",
      warnings: [
        `Significant price divergence (${pct(maxDev)}): CoinGecko ${fmt(coingecko)}, ${details}. ` +
        `Using CoinGecko; verify the token's liquidity before acting.`
      ],
      price_sources
    };
  }

  if (dexscreener != null && defillama != null) {
    const dev = Math.abs(dexscreener - defillama) / dexscreener;
    if (dev <= PRICE_AGREE_PCT) {
      return {
        price: dexscreener,
        source: "dexscreener",
        confidence: "medium",
        warnings: ["CoinGecko unavailable; DexScreener and DefiLlama agree."],
        price_sources
      };
    }

    const avg = (dexscreener + defillama) / 2;
    return {
      price: avg,
      source: "aggregate",
      confidence: "low",
      warnings: [
        `CoinGecko unavailable and secondary sources diverge by ${pct(dev)} ` +
        `(DexScreener ${fmt(dexscreener)} vs DefiLlama ${fmt(defillama)}) — using average ${fmt(avg)}.`
      ],
      price_sources
    };
  }

  if (dexscreener != null) {
    return {
      price: dexscreener,
      source: "dexscreener",
      confidence: "low",
      warnings: ["Only DexScreener price available as sole source — low confidence."],
      price_sources
    };
  }

  if (defillama != null) {
    return {
      price: defillama,
      source: "defillama",
      confidence: "low",
      warnings: ["Only DefiLlama price available as sole source — low confidence."],
      price_sources
    };
  }

  return {
    price: null,
    source: "none",
    confidence: "low",
    warnings: ["No price source returned data."],
    price_sources
  };
}

const defaultFetchers: PriceOracleFetchers = {
  coingecko: fetchCoinGeckoTokenPriceUsd,
  dexscreener: fetchDexScreenerTokenPriceUsd,
  defillama: fetchDefiLlamaTokenPriceUsd
};

export async function getCrossValidatedPrice(
  network: Network,
  tokenAddress: string,
  fetchers: Partial<PriceOracleFetchers> = {}
): Promise<PriceValidation> {
  if (network !== "mainnet") {
    return { price: null, source: "none", confidence: "low", warnings: [], price_sources: { coingecko: null, dexscreener: null, defillama: null } };
  }

  const resolvedFetchers = { ...defaultFetchers, ...fetchers };
  const [coingecko, dexscreener, defillama] = await Promise.all([
    resolvedFetchers.coingecko(network, tokenAddress).catch(() => null),
    resolvedFetchers.dexscreener(network, tokenAddress).catch(() => null),
    resolvedFetchers.defillama(network, tokenAddress).catch(() => null)
  ]);

  return crossValidatePrices(coingecko, dexscreener, defillama);
}

export async function getCrossValidatedPrices(
  network: Network,
  tokenAddresses: string[],
  fetchers: Partial<PriceOracleFetchers> = {}
): Promise<Record<string, PriceValidation>> {
  const uniqueAddresses = [...new Set(tokenAddresses.map((address) => address.toLowerCase()))];
  const entries = await Promise.all(
    uniqueAddresses.map(async (address) => [
      address,
      await getCrossValidatedPrice(network, address, fetchers)
    ] as const)
  );
  return Object.fromEntries(entries);
}
