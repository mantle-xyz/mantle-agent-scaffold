import { describe, expect, it, vi, beforeEach } from "vitest";
import { formatUnits } from "viem";
import { MantleMcpError } from "@mantleio/mantle-core/errors.js";
import { discoverBestV3Pool } from "@mantleio/mantle-core/lib/pool-discovery.js";
import { crossValidatePrices } from "@mantleio/mantle-core/lib/price-oracle.js";

const USDC = {
  address: "0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9",
  symbol: "USDC",
  decimals: 6
};

const WETH = {
  address: "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111",
  symbol: "WETH",
  decimals: 18
};

const OWNER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const POOL_ADDRESS = "0xEe12e312878B74b2C17D80516128D7868f80365B";
const QUOTER_AMOUNT_OUT = 30951000893378207n;

const highConfidenceUsdc = crossValidatePrices(1, 1.0001, 0.9999);
const highConfidenceWeth = crossValidatePrices(2322, 2321.5, 2322.5);
const lowConfidenceUsdc = crossValidatePrices(null, 1, null);
const lowConfidenceWeth = crossValidatePrices(null, 2322, null);

function mapToken(input: string) {
  const upper = input.toUpperCase();
  if (upper === "USDC") return USDC;
  if (upper === "WETH") return WETH;
  throw new Error(`Unknown test token: ${input}`);
}

function priceProvider(confidence: "high" | "low" = "high") {
  const usdc = confidence === "high" ? highConfidenceUsdc : lowConfidenceUsdc;
  const weth = confidence === "high" ? highConfidenceWeth : lowConfidenceWeth;
  return async (_network: "mainnet" | "sepolia", tokenAddress: string) => {
    if (tokenAddress.toLowerCase() === USDC.address.toLowerCase()) return usdc;
    if (tokenAddress.toLowerCase() === WETH.address.toLowerCase()) return weth;
    return crossValidatePrices(null, null, null);
  };
}

function logSlippageCase(label: string, value: unknown) {
  console.info(
    `[slippage-detection] ${label}: ${JSON.stringify(value, (_key, item) =>
      typeof item === "bigint" ? item.toString() : item, 2)}`
  );
}

function quoteProvider(amountOutRaw: bigint = QUOTER_AMOUNT_OUT) {
  return async () => ({
    estimated_out_raw: amountOutRaw.toString(),
    estimated_out_decimal: formatUnits(amountOutRaw, 18),
    price_impact_pct: null,
    route: `onchain:agni:${POOL_ADDRESS}`,
    fee_tier: 500,
    quote_source: "onchain" as const,
    resolved_pool_params: {
      fee_tier: 500,
      pool_address: POOL_ADDRESS
    }
  });
}

describe("getSwapQuote slippage detection", () => {
  it("adds deterministic slippage fields and high/extreme warnings for the 160 USDC incident", async () => {
    const { getSwapQuote } = await import("@mantleio/mantle-core/tools/defi-read.js");

    const result = await getSwapQuote(
      {
        provider: "agni",
        token_in: "USDC",
        token_out: "WETH",
        amount_in: "160",
        fee_tier: 500,
        network: "mainnet"
      },
      {
        resolveTokenInput: async (input: string) => mapToken(input),
        quoteProvider: quoteProvider(),
        getCrossValidatedPrice: priceProvider("high"),
        now: () => "2026-04-22T12:00:00.000Z"
      }
    );
    logSlippageCase("quote incident detection", {
      estimated_out_decimal: result.estimated_out_decimal,
      minimum_out_decimal: result.minimum_out_decimal,
      fair_market_out_decimal: result.fair_market_out_decimal,
      slippage_pct: result.slippage_pct,
      price_confidence: result.price_confidence,
      warnings: result.warnings
    });

    expect(result.price_impact_pct).toBeNull();
    expect(result.slippage_pct).toBeGreaterThan(50);
    expect(result.fair_market_out_raw).not.toBeNull();
    expect(result.fair_market_out_decimal).not.toBeNull();
    expect(result.price_confidence).toBe("high");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("HIGH SLIPPAGE"),
        expect.stringContaining("EXTREME SLIPPAGE WARNING")
      ])
    );
  });

  it("uses a wider warning threshold when price confidence is low", async () => {
    const { getSwapQuote } = await import("@mantleio/mantle-core/tools/defi-read.js");
    const twelvePercentSlippageOut = 60632041343793280n;

    const result = await getSwapQuote(
      {
        provider: "agni",
        token_in: "USDC",
        token_out: "WETH",
        amount_in: "160",
        fee_tier: 500,
        network: "mainnet"
      },
      {
        resolveTokenInput: async (input: string) => mapToken(input),
        quoteProvider: quoteProvider(twelvePercentSlippageOut),
        getCrossValidatedPrice: priceProvider("low"),
        now: () => "2026-04-22T12:00:00.000Z"
      }
    );
    logSlippageCase("low-confidence threshold", {
      slippage_pct: result.slippage_pct,
      price_confidence: result.price_confidence,
      warnings: result.warnings
    });

    expect(result.price_confidence).toBe("low");
    expect(result.slippage_pct).toBeGreaterThan(10);
    expect(result.slippage_pct).toBeLessThan(15);
    expect(result.warnings.some((warning: string) => warning.includes("HIGH SLIPPAGE"))).toBe(false);
  });
});

const mockEstimateGas = vi.fn<() => Promise<bigint>>();
const mockGetBlock = vi.fn<() => Promise<{ baseFeePerGas: bigint | null }>>();
const mockEstimateMaxPriorityFeePerGas = vi.fn<() => Promise<bigint>>();
const mockReadContract = vi.fn<() => Promise<bigint>>();
const mockGetTransactionCount = vi.fn<() => Promise<number>>();

const mockClient = {
  estimateGas: mockEstimateGas,
  getBlock: mockGetBlock,
  estimateMaxPriorityFeePerGas: mockEstimateMaxPriorityFeePerGas,
  readContract: mockReadContract,
  getTransactionCount: mockGetTransactionCount,
  simulateContract: vi.fn(),
  multicall: vi.fn()
};

vi.mock("@mantleio/mantle-core/lib/clients.js", () => ({
  getPublicClient: vi.fn(() => mockClient),
  getRpcUrl: vi.fn(() => "https://mock.rpc"),
  getRpcUrls: vi.fn(() => ["https://mock.rpc"])
}));

const { defiWriteTools, buildSwap } = await import("@mantleio/mantle-core/tools/defi-write.js");

const buildDeps = {
  resolveTokenInput: async (input: string) => mapToken(input),
  getClient: () => mockClient as any,
  getCrossValidatedPrice: priceProvider("high"),
  now: () => "2026-04-22T12:00:00.000Z",
  deadline: () => 1_800_000_000n
};

function setupGasMocks() {
  mockEstimateGas.mockResolvedValue(120_000n);
  mockGetBlock.mockResolvedValue({ baseFeePerGas: 50_000_000n } as any);
  mockEstimateMaxPriorityFeePerGas.mockResolvedValue(2_000_000n);
  mockReadContract.mockResolvedValue(
    BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
  );
  mockGetTransactionCount.mockResolvedValue(42);
}

describe("buildSwap slippage guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupGasMocks();
  });

  it("rejects the 55% loss incident before building calldata", async () => {
    const minimumOutRaw = (QUOTER_AMOUNT_OUT * 9950n) / 10000n;

    await expect(
      buildSwap(
        {
          provider: "agni",
          token_in: "USDC",
          token_out: "WETH",
          amount_in: "160",
          amount_out_min: minimumOutRaw.toString(),
          recipient: RECIPIENT,
          owner: OWNER,
          network: "mainnet",
          fee_tier: 500,
          quote_fee_tier: 500,
          quote_provider: "agni"
        },
        buildDeps
      )
    ).rejects.toMatchObject({
      code: "EXTREME_SLIPPAGE_REJECTED"
    } satisfies Partial<MantleMcpError>);
    logSlippageCase("build extreme rejection", {
      minimum_out_raw: minimumOutRaw.toString(),
      expected_code: "EXTREME_SLIPPAGE_REJECTED"
    });
  });

  it("warns but still builds for 5-30% value loss", async () => {
    const twentyPercentLossOut = 55120000000000000n;
    const result = await buildSwap(
      {
        provider: "agni",
        token_in: "USDC",
        token_out: "WETH",
        amount_in: "160",
        amount_out_min: twentyPercentLossOut.toString(),
        recipient: RECIPIENT,
        owner: OWNER,
        network: "mainnet",
        fee_tier: 500,
        quote_fee_tier: 500,
        quote_provider: "agni"
      },
      buildDeps
    );
    logSlippageCase("build warning but allowed", {
      intent: result.intent,
      warnings: result.warnings
    });

    expect(result.intent).toBe("swap");
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("HIGH SLIPPAGE")])
    );
  });

  it("blocks the end-to-end incident when quote minimum_out_raw reaches build", async () => {
    const { getSwapQuote } = await import("@mantleio/mantle-core/tools/defi-read.js");
    const quote = await getSwapQuote(
      {
        provider: "agni",
        token_in: "USDC",
        token_out: "WETH",
        amount_in: "160",
        fee_tier: 500,
        network: "mainnet"
      },
      {
        resolveTokenInput: async (input: string) => mapToken(input),
        quoteProvider: quoteProvider(),
        getCrossValidatedPrice: priceProvider("high"),
        now: () => "2026-04-22T12:00:00.000Z"
      }
    );
    logSlippageCase("end-to-end quote", {
      minimum_out_raw: quote.minimum_out_raw,
      slippage_pct: quote.slippage_pct,
      warnings: quote.warnings
    });

    const handler = defiWriteTools["mantle_buildSwap"].handler;
    await expect(
      handler(
        {
          provider: quote.provider,
          token_in: "USDC",
          token_out: "WETH",
          amount_in: "160",
          amount_out_min: quote.minimum_out_raw,
          recipient: RECIPIENT,
          owner: OWNER,
          network: "mainnet",
          fee_tier: quote.fee_tier,
          quote_fee_tier: quote.fee_tier,
          quote_provider: quote.provider
        },
        buildDeps
      )
    ).rejects.toMatchObject({ code: "EXTREME_SLIPPAGE_REJECTED" });
    logSlippageCase("end-to-end build", {
      outcome: "blocked",
      expected_code: "EXTREME_SLIPPAGE_REJECTED"
    });
  });

  it("emits PRICE CHECK UNAVAILABLE and builds when price fetch throws", async () => {
    const fairOutRaw = 68900000000000000n;
    const result = await buildSwap(
      {
        provider: "agni",
        token_in: "USDC",
        token_out: "WETH",
        amount_in: "160",
        amount_out_min: fairOutRaw.toString(),
        recipient: RECIPIENT,
        owner: OWNER,
        network: "mainnet",
        fee_tier: 500,
        quote_fee_tier: 500,
        quote_provider: "agni"
      },
      {
        ...buildDeps,
        getCrossValidatedPrice: async () => { throw new Error("timeout"); }
      }
    );
    logSlippageCase("price-check unavailable fallback", {
      intent: result.intent,
      warnings: result.warnings
    });

    expect(result.intent).toBe("swap");
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("PRICE CHECK UNAVAILABLE")])
    );
  });
});

describe("shared price oracle", () => {
  it("is the source of the three-source validation policy used by read/write/token paths", () => {
    const validation = crossValidatePrices(1, 1.01, 0.99);
    logSlippageCase("shared oracle validation", validation);

    expect(validation.price).toBe(1);
    expect(validation.source).toBe("coingecko");
    expect(validation.confidence).toBe("high");
    expect(validation.price_sources).toEqual({
      coingecko: 1,
      dexscreener: 1.01,
      defillama: 0.99
    });
  });
});

describe("pool discovery liquidity threshold", () => {
  it("filters pools below the optional liquidity threshold and ranks candidates", async () => {
    const pool500 = "0x0000000000000000000000000000000000000500";
    const pool3000 = "0x0000000000000000000000000000000000003000";
    const client = {
      multicall: vi.fn()
        .mockResolvedValueOnce([
          { status: "success", result: "0x0000000000000000000000000000000000000000" },
          { status: "success", result: pool500 },
          { status: "success", result: "0x0000000000000000000000000000000000000000" },
          { status: "success", result: pool3000 },
          { status: "success", result: "0x0000000000000000000000000000000000000000" }
        ])
        .mockResolvedValueOnce([
          { status: "success", result: 100n },
          { status: "success", result: 1_000n }
        ])
    };

    const best = await discoverBestV3Pool(
      client,
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000003",
      { minLiquidityThreshold: 500n }
    );
    logSlippageCase("pool discovery threshold", best);

    expect(best).toMatchObject({
      feeTier: 3000,
      poolAddress: pool3000,
      liquidity: 1_000n,
      liquidityRank: 1
    });
  });
});
