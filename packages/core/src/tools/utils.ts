/**
 * Utility tools — safe encoding/decoding primitives for on-chain operations.
 *
 * These tools provide the "escape hatch" for operations not covered by
 * dedicated CLI commands. Agents should use these instead of manually
 * computing hex values, calldata, or wei amounts with Python/JS.
 *
 * All tools are pure computation — no RPC calls, no state reads.
 */

import {
  encodeFunctionData,
  decodeFunctionResult,
  parseUnits,
  formatUnits,
  isAddress,
  getAddress,
  keccak256,
  toHex,
  parseAbi
} from "viem";

import { MantleMcpError } from "../errors.js";
import type { Tool } from "../types.js";
import { CHAIN_CONFIGS } from "../config/chains.js";
import { isWhitelistedContract, whitelistLabel } from "../config/protocols.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireString(input: unknown, fieldName: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `${fieldName} is required.`,
      `Provide a non-empty string for ${fieldName}.`,
      { field: fieldName }
    );
  }
  return input.trim();
}

function nowUtc(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Guard: reject ERC-20 transfer / transferFrom targeting protocol contracts
// ---------------------------------------------------------------------------

const TRANSFER_SELECTOR = "0xa9059cbb";       // transfer(address,uint256)
const TRANSFER_FROM_SELECTOR = "0x23b872dd";   // transferFrom(address,address,uint256)
const SAFE_TRANSFER_SELECTOR = "0x42842e0e";   // safeTransferFrom(address,address,uint256)

/**
 * Inspect calldata for ERC-20 transfer / transferFrom / safeTransferFrom
 * whose recipient is a whitelisted protocol contract. Such transfers bypass
 * protocol accounting (no aToken minted, no swap executed, no LP registered)
 * and permanently lock funds.
 *
 * Throws MantleMcpError if the pattern is detected.
 *
 * @param calldata  0x-prefixed hex calldata
 * @param toAddress Optional: the `to` field of the tx (the ERC-20 token
 *                  contract). Not used for the guard itself but included in
 *                  the error for diagnostics.
 */
function rejectTransferToProtocol(calldata: string, toAddress?: string): void {
  if (!calldata || calldata.length < 10) return;

  const selector = calldata.slice(0, 10).toLowerCase();

  let recipientHex: string | null = null;

  if (selector === TRANSFER_SELECTOR && calldata.length >= 74) {
    // transfer(address to, uint256 amount) — recipient is first arg (bytes 10..74)
    recipientHex = "0x" + calldata.slice(34, 74);
  } else if (
    (selector === TRANSFER_FROM_SELECTOR || selector === SAFE_TRANSFER_SELECTOR) &&
    calldata.length >= 138
  ) {
    // transferFrom(address from, address to, uint256 amount) — recipient is second arg (bytes 74..138)
    recipientHex = "0x" + calldata.slice(98, 138);
  } else {
    return; // Not a transfer-family selector
  }

  // Normalize: the ABI-encoded address is left-padded with zeros to 32 bytes.
  // Extract the last 40 hex chars as the actual address.
  if (recipientHex.length > 42) {
    recipientHex = "0x" + recipientHex.slice(-40);
  }

  // Check against the whitelist
  if (isWhitelistedContract(recipientHex, "mainnet")) {
    const label = whitelistLabel(recipientHex, "mainnet") ?? "protocol contract";
    const selectorName =
      selector === TRANSFER_SELECTOR ? "transfer(address,uint256)" :
      selector === TRANSFER_FROM_SELECTOR ? "transferFrom(address,address,uint256)" :
      "safeTransferFrom(address,address,uint256)";

    throw new MantleMcpError(
      "BLOCKED_TRANSFER_TO_PROTOCOL",
      `BLOCKED: ERC-20 ${selectorName} targeting ${label} (${recipientHex}). ` +
      `Protocol contracts only accept tokens through their designated functions ` +
      `(Pool.supply(), router.swap(), positionManager.mint(), etc.). ` +
      `A plain transfer permanently locks funds with no recovery path.`,
      `Use the dedicated CLI command instead: ` +
      `Aave → 'mantle-cli aave supply/repay', ` +
      `Swap → 'mantle-cli swap build-swap', ` +
      `LP → 'mantle-cli lp add'. ` +
      `Do NOT use encodeCall/buildRawTx to construct transfers to protocol contracts.`,
      {
        blocked_selector: selectorName,
        recipient: recipientHex,
        recipient_label: label,
        ...(toAddress ? { token_contract: toAddress } : {})
      }
    );
  }
}

// =========================================================================
// Tool 1: mantle_parseUnits — decimal → raw integer conversion
// =========================================================================

async function parseUnitsHandler(
  args: Record<string, unknown>
): Promise<unknown> {
  const amount = requireString(args.amount, "amount");
  const decimals =
    typeof args.decimals === "number"
      ? args.decimals
      : typeof args.decimals === "string"
        ? parseInt(args.decimals, 10)
        : 18;

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "decimals must be an integer between 0 and 77.",
      "Common values: 18 (MNT/WETH), 6 (USDC/USDT), 8 (WBTC). Do NOT guess token decimals.",
      { decimals }
    );
  }

  try {
    const raw = parseUnits(amount, decimals);
    return {
      amount_decimal: amount,
      decimals,
      amount_raw: raw.toString(),
      amount_hex: "0x" + raw.toString(16),
      computed_at_utc: nowUtc()
    };
  } catch (err: any) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `Failed to parse '${amount}' with ${decimals} decimals: ${err.message}`,
      "Provide a valid decimal number (e.g. '100', '0.5', '1234.567890').",
      { amount, decimals }
    );
  }
}

// =========================================================================
// Tool 2: mantle_formatUnits — raw integer → decimal conversion
// =========================================================================

async function formatUnitsHandler(
  args: Record<string, unknown>
): Promise<unknown> {
  const raw = requireString(args.amount_raw, "amount_raw");
  const decimals =
    typeof args.decimals === "number"
      ? args.decimals
      : typeof args.decimals === "string"
        ? parseInt(args.decimals, 10)
        : 18;

  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "decimals must be an integer between 0 and 77.",
      "Common values: 18 (MNT/WETH), 6 (USDC/USDT), 8 (WBTC). Do NOT guess token decimals.",
      { decimals }
    );
  }

  try {
    const value = BigInt(raw);
    const decimal = formatUnits(value, decimals);
    return {
      amount_raw: raw,
      decimals,
      amount_decimal: decimal,
      computed_at_utc: nowUtc()
    };
  } catch (err: any) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `Failed to format '${raw}' with ${decimals} decimals: ${err.message}`,
      "Provide a valid integer string (e.g. '1000000', '500000000000000000').",
      { amount_raw: raw, decimals }
    );
  }
}

// =========================================================================
// Tool 3: mantle_encodeCall — ABI-encode a contract function call
// =========================================================================

async function encodeCallHandler(
  args: Record<string, unknown>
): Promise<unknown> {
  const abiInput = requireString(args.abi, "abi");
  const functionName = requireString(args.function_name, "function_name");
  const functionArgs = Array.isArray(args.args) ? args.args : [];
  const toAddress =
    typeof args.to === "string" && isAddress(args.to, { strict: false })
      ? getAddress(args.to)
      : null;

  let abi: any[];
  try {
    // Support both full ABI array and human-readable ABI signatures
    if (abiInput.startsWith("[")) {
      abi = JSON.parse(abiInput);
    } else {
      // Human-readable: e.g. "function transfer(address to, uint256 amount) returns (bool)"
      abi = parseAbi([abiInput]) as any;
    }
  } catch (err: any) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `Failed to parse ABI: ${err.message}`,
      'Provide a valid ABI JSON array or human-readable signature like "function transfer(address to, uint256 amount) returns (bool)".',
      { abi: abiInput }
    );
  }

  try {
    const data = encodeFunctionData({
      abi,
      functionName,
      args: functionArgs
    });

    // SAFETY GUARD: reject transfer/transferFrom targeting protocol contracts
    rejectTransferToProtocol(data, toAddress ?? undefined);

    const result: Record<string, unknown> = {
      function_name: functionName,
      args: functionArgs,
      encoded_data: data,
      data_length_bytes: (data.length - 2) / 2, // subtract "0x"
      computed_at_utc: nowUtc()
    };

    // If 'to' address is provided, also build a ready-to-use unsigned_tx
    if (toAddress) {
      const value =
        typeof args.value === "string" ? args.value : "0x0";
      const chainId =
        typeof args.chain_id === "number"
          ? args.chain_id
          : CHAIN_CONFIGS.mainnet.chain_id;

      result.unsigned_tx = {
        to: toAddress,
        data,
        value,
        chainId
      };
      result.note =
        "unsigned_tx is provided for convenience. The signer should verify " +
        "the target address and data before signing. This is an UNVERIFIED " +
        "manual construction — use dedicated CLI commands when available.";
    }

    return result;
  } catch (err: any) {
    throw new MantleMcpError(
      "ENCODING_FAILED",
      `Failed to encode function call: ${err.message}`,
      "Check that the function name exists in the ABI and the args match the expected types. " +
        "Do NOT manually construct calldata hex or guess function argument encoding.",
      { function_name: functionName, args: functionArgs }
    );
  }
}

// =========================================================================
// Tool 4: mantle_buildRawTx — wrap arbitrary calldata into unsigned_tx
// =========================================================================

async function buildRawTxHandler(
  args: Record<string, unknown>
): Promise<unknown> {
  const toRaw = requireString(args.to, "to");
  if (!isAddress(toRaw, { strict: false })) {
    throw new MantleMcpError(
      "INVALID_ADDRESS",
      `'to' must be a valid Ethereum address, got: ${toRaw}`,
      "Provide a checksummed or lowercase 0x-prefixed 40-hex-character address. " +
        "Do NOT guess or fabricate contract addresses.",
      { field: "to", value: toRaw }
    );
  }
  const to = getAddress(toRaw);

  const data = requireString(args.data, "data");
  // Validate hex format
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      `'data' must be valid hex-encoded calldata (0x-prefixed, even length), got length=${data.length}.`,
      "Use 'mantle-cli utils encode-call' to produce valid calldata, or '0x' for a plain transfer.",
      { field: "data" }
    );
  }

  // SAFETY GUARD: reject transfer/transferFrom targeting protocol contracts
  rejectTransferToProtocol(data, to);

  // Value: accept decimal MNT (e.g. "0.5") or hex (e.g. "0x...")
  let valueHex = "0x0";
  if (typeof args.value === "string" && args.value.trim().length > 0) {
    const val = args.value.trim();
    if (val.startsWith("0x")) {
      // Already hex
      if (!/^0x[0-9a-fA-F]*$/.test(val)) {
        throw new MantleMcpError(
          "INVALID_INPUT",
          `'value' hex is invalid: ${val}`,
          "Provide valid hex (e.g. '0x0') or a decimal MNT amount (e.g. '0.5').",
          { field: "value" }
        );
      }
      valueHex = val;
    } else {
      // Decimal MNT → convert to hex wei
      try {
        const wei = parseUnits(val, 18);
        valueHex = "0x" + wei.toString(16);
      } catch {
        throw new MantleMcpError(
          "INVALID_INPUT",
          `Cannot parse '${val}' as a decimal MNT amount.`,
          "Provide a valid number (e.g. '0.5', '10') or hex (e.g. '0x0').",
          { field: "value", value: val }
        );
      }
    }
  }

  const chainId =
    typeof args.chain_id === "number"
      ? args.chain_id
      : CHAIN_CONFIGS.mainnet.chain_id;

  const description =
    typeof args.description === "string" ? args.description.trim() : null;

  // Compute idempotency key (same logic as defi-write wrapBuildHandler)
  const senderRaw = typeof args.sender === "string" ? args.sender.trim() : "";
  let sender: string | null = null;
  try {
    if (senderRaw && isAddress(senderRaw, { strict: false })) {
      sender = getAddress(senderRaw).toLowerCase();
    }
  } catch { /* not a valid address */ }

  const rawRequestId =
    typeof args.request_id === "string" ? args.request_id.trim() : "";
  const requestId = rawRequestId.length > 0 ? rawRequestId : null;

  const unsignedTx: { to: string; data: string; value: string; chainId: number; nonce?: number } =
    { to, data, value: valueHex, chainId };
  const nonceArg =
    typeof args.nonce === "number" && Number.isInteger(args.nonce) && args.nonce >= 0
      ? args.nonce
      : null;
  if (nonceArg != null) {
    unsignedTx.nonce = nonceArg;
  }
  const idempotencyParts: string[] = [
    sender ?? "*",
    requestId ?? "*",
    unsignedTx.to,
    unsignedTx.data,
    unsignedTx.value,
    String(unsignedTx.chainId),
  ];
  if (nonceArg !== null) {
    // Rule: include the nonce in the idempotency key when (and only when)
    // a nonce is pinned into unsigned_tx. `mantle_buildRawTx` only pins a
    // nonce on explicit override (stuck-tx replacement) — in all other
    // paths the signer picks its own nonce, so the unsigned_tx is not
    // deterministic w.r.t. nonce and the key deliberately doesn't commit
    // to one.
    //
    // Two distinct replacement attempts at two distinct nonces are
    // genuinely different transactions and must bypass dedupe; pinning
    // the nonce into the key gives them distinct hashes.
    idempotencyParts.push("nonce:" + String(nonceArg));
  }
  const idempotencyPayload = idempotencyParts.join(":");
  const idempotencyKey = keccak256(
    toHex(new TextEncoder().encode(idempotencyPayload))
  );

  return {
    intent: "raw_contract_call",
    human_summary:
      description ??
      `Raw call to ${to} with ${(data.length - 2) / 2} bytes calldata` +
        (valueHex !== "0x0" ? ` + ${args.value} MNT` : ""),
    unsigned_tx: unsignedTx,
    idempotency_key: idempotencyKey,
    idempotency_scope: {
      sender: sender ?? "unscoped",
      request_id: requestId ?? "none"
    },
    warnings: [
      "⚠ UNVERIFIED MANUAL CONSTRUCTION — this transaction was NOT built by a dedicated CLI command. " +
        "The calldata, target address, and value have NOT been validated against known protocol ABIs. " +
        "Verify all fields carefully before signing.",
      "Gas fields (gas, maxFeePerGas, maxPriorityFeePerGas) are NOT pre-estimated for raw transactions. " +
        "The signer MUST call eth_estimateGas and populate fee parameters before broadcasting.",
      ...(sender && nonceArg === null
        ? [
            "Nonce not set: mantle_buildRawTx is a pure-computation tool and does not fetch the " +
              "pending nonce automatically. Call mantle_getNonce for the sender address and pass " +
              "the result as the nonce arg to ensure the transaction is fully deterministic."
          ]
        : []),
    ],
    built_at_utc: nowUtc()
  };
}

// =========================================================================
// Tool definitions
// =========================================================================

export const utilsTools: Record<string, Tool> = {
  mantle_parseUnits: {
    name: "mantle_parseUnits",
    description:
      "Convert a human-readable decimal amount to its raw integer representation (wei/smallest unit). " +
      "Use this instead of manually computing amount * 10**decimals.\n\n" +
      "Examples:\n" +
      "- 100 USDC (6 decimals): amount='100', decimals=6 → '100000000'\n" +
      "- 1.5 ETH (18 decimals): amount='1.5', decimals=18 → '1500000000000000000'\n" +
      "- 0.001 WBTC (8 decimals): amount='0.001', decimals=8 → '100000'",
    inputSchema: {
      type: "object",
      properties: {
        amount: {
          type: "string",
          description: "Decimal amount (e.g. '100', '1.5', '0.001')."
        },
        decimals: {
          type: "number",
          description:
            "Token decimals (default: 18). Common: 18 (MNT/WETH/mETH), 6 (USDC/USDT), 8 (WBTC)."
        }
      },
      required: ["amount"]
    },
    handler: parseUnitsHandler
  },

  mantle_formatUnits: {
    name: "mantle_formatUnits",
    description:
      "Convert a raw integer amount (wei/smallest unit) to its human-readable decimal representation. " +
      "Use this instead of manually computing amount / 10**decimals.\n\n" +
      "Examples:\n" +
      "- 100000000 with 6 decimals → '100.0' (USDC)\n" +
      "- 1500000000000000000 with 18 decimals → '1.5' (ETH)",
    inputSchema: {
      type: "object",
      properties: {
        amount_raw: {
          type: "string",
          description: "Raw integer amount as string (e.g. '100000000', '1500000000000000000')."
        },
        decimals: {
          type: "number",
          description:
            "Token decimals (default: 18). Common: 18 (MNT/WETH/mETH), 6 (USDC/USDT), 8 (WBTC)."
        }
      },
      required: ["amount_raw"]
    },
    handler: formatUnitsHandler
  },

  mantle_encodeCall: {
    name: "mantle_encodeCall",
    description:
      "ABI-encode a smart contract function call. Returns encoded calldata (hex). " +
      "Use this ONLY when no dedicated CLI command exists for the operation. " +
      "For standard operations (swaps, LP, Aave), ALWAYS use the dedicated " +
      "CLI commands instead.\n\n" +
      "⛔ SAFETY: This tool BLOCKS ERC-20 transfer()/transferFrom() calls whose recipient is a " +
      "whitelisted protocol contract (Aave Pool, DEX routers, position managers). Sending tokens " +
      "directly to these contracts locks funds permanently. Use the dedicated CLI verb instead " +
      "(aave supply, swap build-swap, lp add).\n\n" +
      "Accepts ABI as either:\n" +
      "- JSON array: '[{\"type\":\"function\",\"name\":\"approve\",...}]'\n" +
      '- Human-readable: \'function approve(address spender, uint256 amount) returns (bool)\'\n\n' +
      "If 'to' address is also provided, returns a ready-to-use unsigned_tx object.\n\n" +
      "Examples:\n" +
      "- Custom contract: abi='function claim(uint256 id)', function_name='claim', " +
      "args=[42], to='<contract_address>'",
    inputSchema: {
      type: "object",
      properties: {
        abi: {
          type: "string",
          description:
            'ABI as JSON array or human-readable signature (e.g. \'function transfer(address to, uint256 amount) returns (bool)\').'
        },
        function_name: {
          type: "string",
          description: "Name of the function to call (e.g. 'transfer', 'claim')."
        },
        args: {
          type: "array",
          description:
            "Function arguments as an array. Types are inferred from the ABI. " +
            "Use strings for addresses and large integers (uint256).",
          items: {}
        },
        to: {
          type: "string",
          description:
            "Target contract address. If provided, the response includes a ready-to-use unsigned_tx."
        },
        value: {
          type: "string",
          description: "Hex-encoded MNT value to send with the call (default: zero)."
        },
        chain_id: {
          type: "number",
          description: "Chain ID (default: 5000 for Mantle mainnet)."
        }
      },
      required: ["abi", "function_name"]
    },
    handler: encodeCallHandler
  },

  mantle_buildRawTx: {
    name: "mantle_buildRawTx",
    description:
      "Build an unsigned_tx from raw calldata. Use this as the FINAL STEP when constructing " +
      "transactions for protocols not covered by dedicated CLI commands.\n\n" +
      "⛔ SAFETY: This tool BLOCKS ERC-20 transfer()/transferFrom() calls whose recipient is a " +
      "whitelisted protocol contract (Aave Pool, DEX routers, position managers). Sending tokens " +
      "directly to these contracts locks funds permanently. Use the dedicated CLI verb instead " +
      "(aave supply, swap build-swap, lp add).\n\n" +
      "Typical workflow for unsupported operations:\n" +
      "1. mantle-cli utils parse-units — convert decimal amounts to raw integers\n" +
      "2. mantle-cli utils encode-call — ABI-encode the function call → get hex calldata\n" +
      "3. mantle-cli utils build-tx — wrap the calldata into a signed-ready unsigned_tx\n\n" +
      "This tool validates the target address and hex format, converts decimal MNT values " +
      "to hex wei, and returns a properly formatted unsigned_tx with warning labels.\n\n" +
      "Examples:\n" +
      "- Call a contract: to='<contract>', data='<hex_from_encode_call>'\n" +
      "- Call with MNT: to='<contract>', data='<hex>', value='0.5' (decimal MNT)",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Target contract or recipient address."
        },
        data: {
          type: "string",
          description:
            "Hex-encoded calldata (from encode-call output). Use '0x' for plain MNT transfers."
        },
        value: {
          type: "string",
          description:
            "MNT to send: decimal (e.g. '0.5', '10') or hex wei (e.g. '0x0'). Default: '0x0' (no MNT)."
        },
        description: {
          type: "string",
          description:
            "Human-readable description of what this transaction does (shown in human_summary)."
        },
        chain_id: {
          type: "number",
          description: "Chain ID (default: 5000 for Mantle mainnet)."
        },
        sender: {
          type: "string",
          description: "Signing wallet address. Scopes idempotency_key."
        },
        request_id: {
          type: "string",
          description: "Unique ID for this user intent."
        },
        nonce: {
          type: "number",
          description: "Optional nonce override. Query mantle_getNonce first to get the correct value. Only use when the signer has nonce issues."
        }
      },
      required: ["to", "data"]
    },
    handler: buildRawTxHandler
  }
};
