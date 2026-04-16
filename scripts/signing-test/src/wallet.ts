/**
 * Signing Test Framework — wallet utilities for signing & broadcasting
 * unsigned_tx payloads returned by mantle-core tools.
 *
 * Supports both Mantle Mainnet (chainId 5000) and Sepolia (5003).
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type PublicClient,
  type WalletClient,
  type TransactionReceipt,
  type Hash,
  type Account,
  formatEther,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ---------------------------------------------------------------------------
// Chain definitions
// ---------------------------------------------------------------------------

export const mantleMainnet = defineChain({
  id: 5000,
  name: "Mantle",
  nativeCurrency: { name: "MNT", symbol: "MNT", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mantle.xyz"] },
  },
  blockExplorers: {
    default: {
      name: "Mantle Explorer",
      url: "https://mantlescan.xyz",
    },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
});

export const mantleSepolia = defineChain({
  id: 5003,
  name: "Mantle Sepolia",
  nativeCurrency: { name: "MNT", symbol: "MNT", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.sepolia.mantle.xyz"] },
  },
  blockExplorers: {
    default: {
      name: "Mantle Sepolia Explorer",
      url: "https://sepolia.mantlescan.xyz",
    },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
});

// ---------------------------------------------------------------------------
// Wallet setup
// ---------------------------------------------------------------------------

export type NetworkMode = "mainnet" | "sepolia";

export interface TestWallet {
  account: Account;
  publicClient: PublicClient;
  walletClient: WalletClient;
  address: string;
  network: NetworkMode;
  chainId: number;
}

export function createTestWallet(opts?: {
  privateKey?: string;
  network?: NetworkMode;
}): TestWallet {
  const pk = opts?.privateKey ?? process.env.TEST_PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      "TEST_PRIVATE_KEY environment variable is required.\n" +
      "Set it to a funded private key (with 0x prefix)."
    );
  }

  const network = opts?.network ?? (process.env.TEST_NETWORK as NetworkMode) ?? "mainnet";
  const chain = network === "mainnet" ? mantleMainnet : mantleSepolia;

  const account = privateKeyToAccount(pk as `0x${string}`);

  const rpcUrl = network === "mainnet"
    ? (process.env.MANTLE_RPC_URL ?? "https://rpc.mantle.xyz")
    : (process.env.MANTLE_SEPOLIA_RPC_URL ?? "https://rpc.sepolia.mantle.xyz");

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  return {
    account,
    publicClient: publicClient as PublicClient,
    walletClient,
    address: account.address,
    network,
    chainId: chain.id,
  };
}

// ---------------------------------------------------------------------------
// Transaction signing & broadcasting
// ---------------------------------------------------------------------------

export interface UnsignedTx {
  to: string;
  data: string;
  value: string;
  chainId: number;
  gas?: string;
  type?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface SignAndSendResult {
  hash: Hash;
  receipt: TransactionReceipt;
}

/**
 * Sign an unsigned_tx object returned by a mantle-core write tool,
 * broadcast it, and wait for the receipt.
 */
export async function signAndSend(
  wallet: TestWallet,
  unsignedTx: UnsignedTx,
  opts?: { dryRun?: boolean }
): Promise<SignAndSendResult | null> {
  if (opts?.dryRun) {
    console.log("  [DRY RUN] Would send transaction:");
    console.log(`    to:    ${unsignedTx.to}`);
    console.log(`    data:  ${unsignedTx.data.length > 20 ? unsignedTx.data.slice(0, 20) + "..." : unsignedTx.data}`);
    console.log(`    value: ${unsignedTx.value}`);
    console.log(`    chain: ${unsignedTx.chainId}`);
    if (unsignedTx.gas) console.log(`    gas:   ${unsignedTx.gas}`);
    return null;
  }

  // Validate chain matches wallet
  if (unsignedTx.chainId !== wallet.chainId) {
    throw new Error(
      `Chain mismatch: tx chainId=${unsignedTx.chainId}, wallet chainId=${wallet.chainId}`
    );
  }

  const chain = wallet.network === "mainnet" ? mantleMainnet : mantleSepolia;

  const txParams: any = {
    to: unsignedTx.to as `0x${string}`,
    data: unsignedTx.data as `0x${string}`,
    value: BigInt(unsignedTx.value),
    chain,
    account: wallet.account,
  };

  // Use gas parameters from unsigned_tx when available (dynamically estimated
  // by wrapBuildHandler via eth_estimateGas + latest block baseFee).
  if (unsignedTx.gas) {
    txParams.gas = BigInt(unsignedTx.gas);
  }
  if (unsignedTx.maxFeePerGas) {
    txParams.maxFeePerGas = BigInt(unsignedTx.maxFeePerGas);
  }
  if (unsignedTx.maxPriorityFeePerGas) {
    txParams.maxPriorityFeePerGas = BigInt(unsignedTx.maxPriorityFeePerGas);
  }

  const hash = await wallet.walletClient.sendTransaction(txParams);

  const receipt = await wallet.publicClient.waitForTransactionReceipt({
    hash,
    timeout: 60_000,
  });

  return { hash, receipt };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export async function getBalance(wallet: TestWallet): Promise<bigint> {
  return wallet.publicClient.getBalance({
    address: wallet.address as `0x${string}`,
  });
}

export async function getBlockNumber(wallet: TestWallet): Promise<bigint> {
  return wallet.publicClient.getBlockNumber();
}

export function formatMNT(wei: bigint): string {
  return formatEther(wei);
}

export { formatEther, parseEther };
