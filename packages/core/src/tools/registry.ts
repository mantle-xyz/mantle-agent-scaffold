import { getAddress, isAddress } from "viem";
import { MantleMcpError } from "../errors.js";
import { getPublicClient } from "../lib/clients.js";
import { normalizeNetwork } from "../lib/network.js";
import { findRegistryByAddress, listRegistryEntries, type RegistryEntry } from "../lib/registry.js";
import type { Tool } from "../types.js";

function confidenceFromTimestamp(timestamp: string | undefined): "high" | "medium" | "low" {
  if (!timestamp) {
    return "low";
  }

  const ageMs = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return "low";
  }
  if (ageMs > 30 * 24 * 60 * 60 * 1000) {
    return "medium";
  }
  return "high";
}

function normalizeLookupText(value: string): string {
  return value.trim().toLowerCase();
}

function matchCategory(
  entry: RegistryEntry,
  category: "system" | "token" | "bridge" | "defi" | "any"
): boolean {
  return category === "any" ? true : entry.category === category;
}

function findEntry(
  entries: RegistryEntry[],
  identifier: string,
  category: "system" | "token" | "bridge" | "defi" | "any"
): RegistryEntry | null {
  const needle = normalizeLookupText(identifier);

  const byKey = entries.find(
    (entry) => matchCategory(entry, category) && normalizeLookupText(entry.key) === needle
  );
  if (byKey) {
    return byKey;
  }

  const byAlias = entries.find(
    (entry) =>
      matchCategory(entry, category) &&
      (entry.aliases ?? []).some((alias) => normalizeLookupText(alias) === needle)
  );
  if (byAlias) {
    return byAlias;
  }

  const byLabel = entries.find(
    (entry) => matchCategory(entry, category) && normalizeLookupText(entry.label) === needle
  );
  return byLabel ?? null;
}

interface ValidateAddressDeps {
  getClient: (
    network: "mainnet" | "sepolia"
  ) => { getBytecode: (args: { address: `0x${string}` }) => Promise<string | null | undefined> };
}

const defaultValidateDeps: ValidateAddressDeps = {
  getClient: getPublicClient
};

export async function resolveAddress(args: Record<string, unknown>): Promise<any> {
  const { network, warnings } = normalizeNetwork(args, { allowLegacyEnvironment: true });
  const identifier = typeof args.identifier === "string" ? args.identifier.trim() : "";
  const category = (typeof args.category === "string" ? args.category : "any") as
    | "system"
    | "token"
    | "bridge"
    | "defi"
    | "any";

  if (!identifier) {
    throw new MantleMcpError(
      "ADDRESS_NOT_FOUND",
      "Identifier is required for address resolution.",
      "Pass identifier as a contract key, alias, or label.",
      null
    );
  }

  const entry = findEntry(listRegistryEntries(network), identifier, category);
  if (!entry) {
    throw new MantleMcpError(
      "ADDRESS_NOT_FOUND",
      `No registry entry found for: ${identifier}`,
      "Use mantle://registry/contracts to discover valid keys and aliases.",
      { identifier, network, category }
    );
  }

  return {
    identifier,
    network,
    address: getAddress(entry.address),
    label: entry.label,
    category: entry.category,
    decimals: entry.decimals ?? null,
    status: entry.status,
    is_official: entry.is_official,
    source_url: entry.source?.url ?? "",
    source_retrieved_at: entry.source?.retrieved_at ?? "",
    confidence: confidenceFromTimestamp(entry.source?.retrieved_at),
    aliases: entry.aliases ?? [],
    warnings
  };
}

export async function validateAddress(
  args: Record<string, unknown>,
  deps: ValidateAddressDeps = defaultValidateDeps
): Promise<any> {
  const { network } = normalizeNetwork(args);
  const address = typeof args.address === "string" ? args.address : "";
  const checkCode = args.check_code === true;

  const validFormat = isAddress(address, { strict: false });
  if (!validFormat) {
    return {
      address,
      valid_format: false,
      is_zero_address: false,
      is_checksummed: false,
      has_code: checkCode ? false : null,
      registry_match: null,
      warnings: ["Address format is invalid."]
    };
  }

  const normalized = getAddress(address);
  const isZeroAddress = normalized.toLowerCase() === "0x0000000000000000000000000000000000000000";
  const isChecksummed = normalized === address;

  let hasCode: boolean | null = null;
  if (checkCode) {
    try {
      const bytecode = await deps.getClient(network).getBytecode({ address: normalized });
      hasCode = Boolean(bytecode && bytecode !== "0x");
    } catch {
      hasCode = false;
    }
  }

  const match = findRegistryByAddress(network, normalized);
  const warnings: string[] = [];
  if (isZeroAddress) {
    warnings.push("Zero address should not be used as an execution target.");
  }
  if (!isChecksummed) {
    warnings.push("Input address is not checksummed; normalized to EIP-55.");
  }

  return {
    address: normalized,
    valid_format: true,
    is_zero_address: isZeroAddress,
    is_checksummed: isChecksummed,
    has_code: hasCode,
    registry_match: match?.label ?? null,
    warnings
  };
}

export const registryTools: Record<string, Tool> = {
  resolveAddress: {
    name: "mantle_resolveAddress",
    description:
      "Resolve trusted contract addresses by key, alias, or label from the Mantle registry. Examples: identifier='USDC' -> 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9; identifier='Agni Router' -> 0x319B69888b0d11cEC22caA5034e25FfFBDc88421.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "Registry key, alias, or label." },
        network: {
          type: "string",
          description: "Network name (mainnet, sepolia).",
          enum: ["mainnet", "sepolia"]
        },
        environment: {
          type: "string",
          description: "Legacy alias for network (`testnet` maps to `sepolia`)."
        },
        category: {
          type: "string",
          description: "Filter category.",
          enum: ["system", "token", "bridge", "defi", "any"]
        }
      },
      required: ["identifier"]
    },
    handler: resolveAddress
  },
  validateAddress: {
    name: "mantle_validateAddress",
    description:
      "Validate address format/checksum and optional bytecode presence. Examples: 0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8 (WMNT) and 0x319B69888b0d11cEC22caA5034e25FfFBDc88421 (Agni Router).",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Address to validate." },
        check_code: { type: "boolean", description: "If true, check deployed bytecode." },
        network: {
          type: "string",
          description: "Network name (mainnet, sepolia).",
          enum: ["mainnet", "sepolia"]
        }
      },
      required: ["address"]
    },
    handler: validateAddress
  }
};
