import type { Network } from "../types.js";

interface ProtocolEntry {
  name: string;
  type: string;
  status: "enabled" | "planned";
  contracts: Record<string, string>;
  source_url?: string;
}

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
        quoter_v2: "0xc4aaDc921E1cdb66c5300Bc158a313292923C0cb"
      }
    },
    fluxion: {
      name: "Fluxion",
      type: "dex",
      status: "enabled",
      source_url: "https://app.fluxion.network",
      contracts: {
        swap_router: "0x5628a59df0ecac3f3171f877a94beb26ba6dfaa0",
        position_manager: "0x2b70c4e7ca8e920435a5db191e066e9e3afd8db3",
        factory: "0xF883162Ed9c7E8EF604214c964c678E40c9B737C"
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
        lb_factory_v2_2: "0xa6630671775c4EA2743840F9A5016dCf2A104054",
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
        pool_data_provider: "0x487c5c669D9eee6057C44973207101276cf73b68",
        pool_addresses_provider: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
        weth_gateway: "0x9C6cCAC66b1c9AbA4855e2dD284b9e16e41E06eA",
        oracle: "0x47a063CfDa980532267970d478EC340C0F80E8df"
      }
    },
    ondo: {
      name: "Ondo Finance",
      type: "rwa",
      status: "planned",
      contracts: {
        router: "BLOCKER: fill from Ondo official docs and verify on Mantlescan",
        vault_manager: "BLOCKER: fill from Ondo official docs and verify on Mantlescan"
      }
    }
  },
  sepolia: {}
};

// ---------------------------------------------------------------------------
// Whitelist helpers — used by defi-write tools to validate targets
// ---------------------------------------------------------------------------

/** All whitelisted contract addresses on mainnet (lowercase for comparison). */
const WHITELISTED_CONTRACTS_MAINNET = new Set(
  [
    // Merchant Moe
    "0xeaEE7EE68874218c3558b40063c42B82D3E7232a", // MoeRouter
    "0x013e138EF6008ae5FDFDE29700e3f2Bc61d21E3a", // LB Router V2.2
    // Agni
    "0x319B69888b0d11cEC22caA5034e25FfFBDc88421", // SwapRouter
    "0x218bf598D1453383e2F4AA7b14fFB9BfB102D637", // PositionManager
    // Fluxion
    "0x5628a59df0ecac3f3171f877a94beb26ba6dfaa0", // SwapRouter
    "0x2b70c4e7ca8e920435a5db191e066e9e3afd8db3", // PositionManager
    // Aave V3
    "0x458F293454fE0d67EC0655f3672301301DD51422", // Pool
    "0x9C6cCAC66b1c9AbA4855e2dD284b9e16e41E06eA", // WETHGateway
    // WMNT
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
    "0xeaee7ee68874218c3558b40063c42b82d3e7232a": "Merchant Moe MoeRouter",
    "0x013e138ef6008ae5fdfde29700e3f2bc61d21e3a": "Merchant Moe LB Router V2.2",
    "0x319b69888b0d11cec22caa5034e25fffbdc88421": "Agni SwapRouter",
    "0x218bf598d1453383e2f4aa7b14ffb9bfb102d637": "Agni PositionManager",
    "0x5628a59df0ecac3f3171f877a94beb26ba6dfaa0": "Fluxion SwapRouter",
    "0x2b70c4e7ca8e920435a5db191e066e9e3afd8db3": "Fluxion PositionManager",
    "0x458f293454fe0d67ec0655f3672301301dd51422": "Aave V3 Pool",
    "0x9c6ccac66b1c9aba4855e2dd284b9e16e41e06ea": "Aave V3 WETHGateway",
    "0x78c1b0c915c4faa5fffa6cabf0219da63d7f4cb8": "WMNT"
  };
  return labels[lower] ?? null;
}
