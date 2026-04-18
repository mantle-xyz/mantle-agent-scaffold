import type { Network } from "../types.js";

interface ProtocolEntry {
  name: string;
  type: string;
  status: "enabled" | "planned";
  contracts: Record<string, string>;
  source_url?: string;
}

/**
 * Mantle protocol registry — strictly scoped to the OpenClaw / RealClaw whitelist.
 *
 * Authoritative source:
 *   skills/mantle-openclaw-competition/references/asset-whitelist.md
 *
 * Only these protocol contracts may appear in:
 *   - `unsigned_tx.to`
 *   - `--spender` for `approve`
 *   - `router` / `position_manager` / `factory` in a plan
 *
 * Any other address MUST be rejected before building a transaction, even if
 * the user insists (Hard Constraint #10).
 */
export const MANTLE_PROTOCOLS: Record<Network, Record<string, ProtocolEntry>> = {
  mainnet: {
    agni: {
      name: "Agni Finance",
      type: "dex",
      status: "enabled",
      source_url: "https://agni.finance",
      contracts: {
        swap_router: "0x319B69888b0d11cEC22caA5034e25FfFBDc88421",
        position_manager: "0x218bf598D1453383e2F4AA7b14fFB9BfB102D637",
        factory: "0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035",
        smart_router: "0xB52B1f5e08c04a8C33f4c7363fa2De23b9Bc169F",
        // Read-only (eth_call) — used by getSwapQuote / buildSwap to compute
        // minimum_out. Never appears in unsigned_tx.to, so not on the
        // whitelist set below (whitelist governs tx targets only).
        quoter_v2: "0xc4aaDc921E1cdb66c5300Bc158a313292923C0cb"
      }
    },
    fluxion: {
      name: "Fluxion",
      type: "dex",
      status: "enabled",
      source_url: "https://app.fluxion.network",
      contracts: {
        swap_router: "0x5628a59dF0ECAC3f3171f877A94bEb26BA6DFAa0",
        position_manager: "0x2b70C4e7cA8E920435A5dB191e066E9E3AFd8DB3",
        // V3 factory — referenced by callers as `factory` (matches agni convention).
        factory: "0xf883162Ed9C7E8ef604214C964C678e40C9B737C",
        v2_router: "0xD772E655Af24fE5af92504d613D1Da0D9CFB6408",
        v2_pool_factory: "0x9336B143C572D75f1F2B7374532E8C96EED41fE9",
        // Read-only quoter — see agni note above.
        quoter_v2: "0x3E4eE18Ac7280813236a1EB850679Da5322E14CE"
      }
    },
    merchant_moe: {
      name: "Merchant Moe",
      type: "dex",
      status: "enabled",
      source_url: "https://docs.merchantmoe.com/resources/contracts",
      contracts: {
        moe_router: "0xeaEE7EE68874218c3558b40063c42B82D3E7232a",
        lb_router_v2_2: "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a",
        lfj_aggregator: "0x45A62B090DF48243F12A21897e7ed91863E2c86b",
        // LB factory — callers use the versioned key `lb_factory_v2_2`.
        lb_factory_v2_2: "0xa6630671775c4EA2743840F9A5016dCf2A104054",
        moe_factory: "0x5bEf015CA9424A7C07B68490616a4C1F094BEdEc",
        masterchef: "0xd4BD5e47548D8A6ba2a0Bf4cE073Cbf8fa523DcC",
        moe_staking: "0xE92249760e1443FbBeA45B03f607Ba84471Fa793",
        // Read-only LB quoter — see agni note above.
        lb_quoter_v2_2: "0x501b8AFd35df20f531fF45F6f695793AC3316c85"
      }
    },
    aave_v3: {
      name: "Aave V3",
      type: "lending",
      status: "enabled",
      source_url: "https://github.com/bgd-labs/aave-address-book/blob/main/src/AaveV3Mantle.sol",
      contracts: {
        pool: "0x458F293454fE0d67EC0655f3672301301DD51422",
        weth_gateway: "0x9C6cCAC66b1c9AbA4855e2dD284b9e16e41E06eA",
        pool_data_provider: "0x487c5c669D9eee6057C44973207101276cf73b68"
      }
    },
    wmnt: {
      name: "WMNT (wrap/unwrap)",
      type: "wrapper",
      status: "enabled",
      source_url: "https://docs.mantle.xyz/network/for-developers/quick-access",
      contracts: {
        wrap_unwrap: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8"
      }
    }
  },
  sepolia: {}
};

// ---------------------------------------------------------------------------
// Whitelist helpers — used by defi-write tools to validate targets
// ---------------------------------------------------------------------------

/**
 * All whitelisted contract addresses on mainnet (lowercase for comparison).
 * Must match the "Protocol Whitelist" section of asset-whitelist.md exactly.
 */
const WHITELISTED_CONTRACTS_MAINNET = new Set(
  [
    // Merchant Moe (7)
    "0xeaEE7EE68874218c3558b40063c42B82D3E7232a", // MoeRouter
    "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a", // LB Router V2.2
    "0x45A62B090DF48243F12A21897e7ed91863E2c86b", // LFJ Aggregator
    "0xa6630671775c4EA2743840F9A5016dCf2A104054", // LB Factory
    "0x5bEf015CA9424A7C07B68490616a4C1F094BEdEc", // MoeFactory
    "0xd4BD5e47548D8A6ba2a0Bf4cE073Cbf8fa523DcC", // MasterChef
    "0xE92249760e1443FbBeA45B03f607Ba84471Fa793", // MoeStaking
    // Agni Finance (4)
    "0x319B69888b0d11cEC22caA5034e25FfFBDc88421", // SwapRouter
    "0x218bf598D1453383e2F4AA7b14fFB9BfB102D637", // PositionManager
    "0x25780dc8Fc3cfBD75F33bFDAB65e969b603b2035", // AgniFactory
    "0xB52B1f5e08c04a8C33f4c7363fa2De23b9Bc169F", // SmartRouter
    // Fluxion (5)
    "0x5628a59dF0ECAC3f3171f877A94bEb26BA6DFAa0", // V3 SwapRouter
    "0x2b70C4e7cA8E920435A5dB191e066E9E3AFd8DB3", // V3 PositionManager
    "0xf883162Ed9C7E8ef604214C964C678e40C9B737C", // V3 Factory
    "0xD772E655Af24fE5af92504d613D1Da0D9CFB6408", // V2 Router
    "0x9336B143C572D75f1F2B7374532E8C96EED41fE9", // V2 PoolFactory
    // Aave V3 (3)
    "0x458F293454fE0d67EC0655f3672301301DD51422", // Pool
    "0x9C6cCAC66b1c9AbA4855e2dD284b9e16e41E06eA", // WETHGateway
    "0x487c5c669D9eee6057C44973207101276cf73b68", // DataProvider
    // WMNT (wrap/unwrap)
    "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8"
  ].map((a) => a.toLowerCase())
);

/**
 * Check whether an address is on the competition whitelist.
 * Used by `mantle_buildApprove` to validate spender targets.
 */
export function isWhitelistedContract(
  address: string,
  network: Network
): boolean {
  if (network !== "mainnet") return false;
  return WHITELISTED_CONTRACTS_MAINNET.has(address.toLowerCase());
}

/**
 * Return the human-readable label for a whitelisted contract, or null.
 */
export function whitelistLabel(
  address: string,
  network: Network
): string | null {
  if (network !== "mainnet") return null;
  const lower = address.toLowerCase();
  const labels: Record<string, string> = {
    // Merchant Moe
    "0xeaee7ee68874218c3558b40063c42b82d3e7232a": "Merchant Moe MoeRouter",
    "0x013e138ef6008ae5fdfde29700e3f2bc61d21e3a": "Merchant Moe LB Router V2.2",
    "0x45a62b090df48243f12a21897e7ed91863e2c86b": "Merchant Moe LFJ Aggregator",
    "0xa6630671775c4ea2743840f9a5016dcf2a104054": "Merchant Moe LB Factory",
    "0x5bef015ca9424a7c07b68490616a4c1f094bedec": "Merchant Moe V1 Factory",
    "0xd4bd5e47548d8a6ba2a0bf4ce073cbf8fa523dcc": "Merchant Moe MasterChef",
    "0xe92249760e1443fbbea45b03f607ba84471fa793": "Merchant Moe Staking",
    // Agni Finance
    "0x319b69888b0d11cec22caa5034e25fffbdc88421": "Agni SwapRouter",
    "0x218bf598d1453383e2f4aa7b14ffb9bfb102d637": "Agni PositionManager",
    "0x25780dc8fc3cfbd75f33bfdab65e969b603b2035": "Agni V3 Factory",
    "0xb52b1f5e08c04a8c33f4c7363fa2de23b9bc169f": "Agni SmartRouter",
    // Fluxion
    "0x5628a59df0ecac3f3171f877a94beb26ba6dfaa0": "Fluxion V3 SwapRouter",
    "0x2b70c4e7ca8e920435a5db191e066e9e3afd8db3": "Fluxion V3 PositionManager",
    "0xf883162ed9c7e8ef604214c964c678e40c9b737c": "Fluxion V3 Factory",
    "0xd772e655af24fe5af92504d613d1da0d9cfb6408": "Fluxion V2 Router",
    "0x9336b143c572d75f1f2b7374532e8c96eed41fe9": "Fluxion V2 PoolFactory",
    // Aave V3
    "0x458f293454fe0d67ec0655f3672301301dd51422": "Aave V3 Pool",
    "0x9c6ccac66b1c9aba4855e2dd284b9e16e41e06ea": "Aave V3 WETHGateway",
    "0x487c5c669d9eee6057c44973207101276cf73b68": "Aave V3 DataProvider",
    // WMNT
    "0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8": "WMNT (wrap/unwrap)"
  };
  return labels[lower] ?? null;
}
