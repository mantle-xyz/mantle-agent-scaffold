import type { Command } from "commander";
import {
  getRegistryData,
  listRegistryEntries,
  type RegistryEntry
} from "@mantleio/mantle-core/lib/registry.js";
import { normalizeNetwork } from "@mantleio/mantle-core/lib/network.js";
import { formatKeyValue, formatTable, formatJson } from "../formatter.js";

type Network = "mainnet" | "sepolia";

const VALID_STATUSES = ["active", "deprecated", "paused", "unknown"] as const;
const VALID_CONTRACT_CATEGORIES = ["defi", "bridge", "system"] as const;

/**
 * Derive a protocol group name from a registry key.
 *
 * The registry uses PROTOCOL[_VERSION]_ROLE naming, but role discriminators
 * (LB, LFJ, POSITION, SMART, WETH, V3, ...) vary per protocol. Instead of
 * trying to enumerate every role suffix, we match against a fixed list of
 * known protocol prefixes; the longest prefix wins. This produces stable
 * grouping even as new role contracts are added.
 *
 * Fallback: for any registry key that matches no known prefix, we group by
 * the first underscore-delimited segment. This is usually correct (e.g.
 * `ODOS_ROUTER` → `ODOS`) but breaks when a protocol name itself contains
 * underscores (e.g. `CURVE_FINANCE_ROUTER` → `CURVE` rather than
 * `CURVE_FINANCE`). Add such protocols to KNOWN_PROTOCOL_PREFIXES when they
 * are introduced to the registry.
 *
 * Examples:
 *   MERCHANT_MOE_LB_ROUTER     -> MERCHANT_MOE
 *   MERCHANT_MOE_ROUTER        -> MERCHANT_MOE
 *   AGNI_SMART_ROUTER          -> AGNI
 *   AAVE_V3_WETH_GATEWAY       -> AAVE_V3
 *   FLUXION_V2_ROUTER          -> FLUXION
 */
const KNOWN_PROTOCOL_PREFIXES = [
  // Longer prefixes first so a key like AAVE_V3_POOL matches AAVE_V3, not AAVE.
  "MERCHANT_MOE",
  "AAVE_V3",
  "FLUXION",
  "AGNI"
];

function protocolGroupOf(entry: RegistryEntry): string {
  const key = entry.key;
  for (const prefix of KNOWN_PROTOCOL_PREFIXES) {
    if (key === prefix || key.startsWith(prefix + "_")) {
      return prefix;
    }
  }
  // Fallback: first underscore-delimited segment.
  const firstSegment = key.split("_")[0];
  return firstSegment || key;
}

/**
 * Validate the global --network flag via the shared core helper so that
 * invalid values produce the same UNSUPPORTED_NETWORK error as sibling
 * commands (e.g. `registry resolve`), rather than silently returning
 * mainnet data with the wrong label.
 */
function resolveNetwork(cmd: Command): Network {
  const globals = cmd.optsWithGlobals();
  const { network } = normalizeNetwork({ network: globals.network });
  return network;
}

/** Flag suffix for agent-facing next-command hints; empty on default network. */
function networkFlagSuffix(network: Network): string {
  return network === "mainnet" ? "" : ` --network ${network}`;
}

export function registerWhitelist(parent: Command): void {
  const group = parent
    .command("whitelist")
    .description(
      "Inspect the OpenClaw / Mantle whitelist — only assets and contracts in the registry " +
      "may participate in plan / quote / approve / unsigned-tx flows. " +
      "Use layered subcommands: `summary` for overview, `tokens` / `contracts` for lists, " +
      "`protocols` for protocol groupings, and `show <key>` for full details."
    );

  // ------------------------------------------------------------------
  // Layer 1: summary — metadata + counts. Entry point for agents.
  // ------------------------------------------------------------------
  group
    .command("summary")
    .description("High-level overview: schema version, counts per category, protocol groups")
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const network = resolveNetwork(cmd);
      const flagSuffix = networkFlagSuffix(network);
      const data = getRegistryData();
      const entries = listRegistryEntries(network);

      const countsByCategory: Record<string, number> = {};
      for (const entry of entries) {
        countsByCategory[entry.category] = (countsByCategory[entry.category] ?? 0) + 1;
      }

      // NOTE: If `system` or `bridge` categories are ever added to the registry
      // and should NOT be grouped alongside DeFi protocols, filter them here
      // (`entry.category !== "defi"`). Current registry only contains `token`
      // and `defi`, so the token-skip below is sufficient.
      const protocolGroups = new Map<string, number>();
      for (const entry of entries) {
        if (entry.category === "token") continue;
        const grp = protocolGroupOf(entry);
        protocolGroups.set(grp, (protocolGroups.get(grp) ?? 0) + 1);
      }
      const protocols = [...protocolGroups.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const chainId =
        network === "sepolia"
          ? data.chain_ids?.testnet ?? null
          : data.chain_ids?.mainnet ?? null;

      const summary = {
        network,
        chain_id: chainId,
        schema_version: data.schema_version,
        updated_at: data.updated_at,
        total_entries: entries.length,
        counts_by_category: countsByCategory,
        protocol_groups: protocols,
        notes: data.notes ?? null,
        next_commands: {
          tokens: `mantle-cli whitelist tokens${flagSuffix}`,
          contracts: `mantle-cli whitelist contracts${flagSuffix}`,
          protocols: `mantle-cli whitelist protocols${flagSuffix}`,
          details: `mantle-cli whitelist show <key>${flagSuffix}`
        }
      };

      if (globals.json) {
        formatJson(summary);
        return;
      }

      formatKeyValue(
        {
          network: summary.network,
          chain_id: summary.chain_id,
          schema_version: summary.schema_version,
          updated_at: summary.updated_at,
          total_entries: summary.total_entries
        },
        {
          order: ["network", "chain_id", "schema_version", "updated_at", "total_entries"],
          labels: {
            network: "Network",
            chain_id: "Chain ID",
            schema_version: "Schema",
            updated_at: "Updated At",
            total_entries: "Total Entries"
          }
        }
      );

      const categoryRows = Object.entries(countsByCategory).map(([category, count]) => ({
        category,
        count
      }));
      console.log("  Counts by category:");
      formatTable(categoryRows, [
        { key: "category", label: "Category" },
        { key: "count", label: "Count", align: "right" }
      ]);

      console.log("  Protocol groups (non-token contracts):");
      formatTable(protocols, [
        { key: "name", label: "Group" },
        { key: "count", label: "Contracts", align: "right" }
      ]);

      if (summary.notes) {
        console.log("  Notes:");
        console.log(`    ${summary.notes}\n`);
      }

      console.log("  Next:");
      console.log(`    mantle-cli whitelist tokens${flagSuffix}`);
      console.log(`    mantle-cli whitelist contracts${flagSuffix}`);
      console.log(`    mantle-cli whitelist protocols${flagSuffix}`);
      console.log(`    mantle-cli whitelist show <key>${flagSuffix}\n`);
    });

  // ------------------------------------------------------------------
  // Layer 2a: tokens — ERC-20 whitelist only.
  // ------------------------------------------------------------------
  group
    .command("tokens")
    .description("List whitelisted tokens (key, address, decimals, status)")
    .option("--status <status>", `filter by status (${VALID_STATUSES.join(", ")})`)
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const network = resolveNetwork(cmd);
      let tokens = listRegistryEntries(network).filter((e) => e.category === "token");

      if (opts.status !== undefined) {
        const status = String(opts.status).toLowerCase();
        if (!(VALID_STATUSES as readonly string[]).includes(status)) {
          console.error(
            `\n  Invalid --status value: "${opts.status}". ` +
            `Use one of: ${VALID_STATUSES.join(", ")}.\n`
          );
          process.exit(1);
        }
        tokens = tokens.filter((e) => e.status === status);
      }

      const rows = tokens.map((t) => ({
        key: t.key,
        label: t.label,
        address: t.address,
        decimals: t.decimals ?? null,
        status: t.status,
        official: t.is_official
      }));

      if (globals.json) {
        formatJson({ network, count: rows.length, tokens: rows });
        return;
      }

      formatTable(rows, [
        { key: "key", label: "Key" },
        { key: "label", label: "Name" },
        { key: "address", label: "Address" },
        { key: "decimals", label: "Dec", align: "right" },
        { key: "status", label: "Status" },
        { key: "official", label: "Official" }
      ]);
      console.log(`  ${rows.length} token(s). Use 'whitelist show <key>' for source URL and aliases.\n`);
    });

  // ------------------------------------------------------------------
  // Layer 2b: contracts — non-token contracts.
  // ------------------------------------------------------------------
  group
    .command("contracts")
    .description("List whitelisted contracts (defi / bridge / system)")
    .option(
      "--category <category>",
      `filter category (${VALID_CONTRACT_CATEGORIES.join(", ")})`
    )
    .option("--protocol <protocol>", "filter by protocol group (e.g. MERCHANT_MOE, AGNI, AAVE_V3)")
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const network = resolveNetwork(cmd);
      let contracts = listRegistryEntries(network).filter((e) => e.category !== "token");

      if (opts.category !== undefined) {
        const category = String(opts.category).toLowerCase();
        if (category === "token") {
          console.error(
            `\n  --category token is not valid here; tokens live in a separate subcommand. ` +
            `Run 'mantle-cli whitelist tokens' instead.\n`
          );
          process.exit(1);
        }
        if (!(VALID_CONTRACT_CATEGORIES as readonly string[]).includes(category)) {
          console.error(
            `\n  Invalid --category value: "${opts.category}". ` +
            `Use one of: ${VALID_CONTRACT_CATEGORIES.join(", ")}.\n`
          );
          process.exit(1);
        }
        contracts = contracts.filter((e) => e.category === category);
      }
      if (opts.protocol) {
        const needle = String(opts.protocol).toUpperCase();
        contracts = contracts.filter((e) => protocolGroupOf(e).toUpperCase() === needle);
      }

      const rows = contracts.map((c) => ({
        key: c.key,
        label: c.label,
        category: c.category,
        protocol: protocolGroupOf(c),
        address: c.address,
        status: c.status
      }));

      if (globals.json) {
        formatJson({ network, count: rows.length, contracts: rows });
        return;
      }

      formatTable(rows, [
        { key: "key", label: "Key" },
        { key: "label", label: "Name" },
        { key: "protocol", label: "Protocol" },
        { key: "category", label: "Category" },
        { key: "address", label: "Address" },
        { key: "status", label: "Status" }
      ]);
      console.log(
        `  ${rows.length} contract(s). Use 'whitelist show <key>' for source URL and aliases.\n`
      );
    });

  // ------------------------------------------------------------------
  // Layer 2c: protocols — grouped listing.
  // ------------------------------------------------------------------
  group
    .command("protocols")
    .description("List protocol groups and the contract keys inside each")
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const network = resolveNetwork(cmd);
      const flagSuffix = networkFlagSuffix(network);
      const contracts = listRegistryEntries(network).filter((e) => e.category !== "token");

      const groupsMap = new Map<string, RegistryEntry[]>();
      for (const entry of contracts) {
        const grp = protocolGroupOf(entry);
        const list = groupsMap.get(grp) ?? [];
        list.push(entry);
        groupsMap.set(grp, list);
      }

      const groups = [...groupsMap.entries()]
        .map(([name, list]) => ({
          name,
          count: list.length,
          keys: list.map((e) => e.key).sort()
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      if (globals.json) {
        formatJson({ network, protocols: groups });
        return;
      }

      console.log();
      for (const g of groups) {
        console.log(`  ${g.name}  (${g.count})`);
        for (const key of g.keys) {
          console.log(`    - ${key}`);
        }
        console.log();
      }
      console.log(
        `  ${groups.length} protocol group(s). ` +
        `Filter with: mantle-cli whitelist contracts --protocol <group>${flagSuffix}\n`
      );
    });

  // ------------------------------------------------------------------
  // Layer 3: show — full details for a single entry.
  // ------------------------------------------------------------------
  group
    .command("show")
    .description("Show full details for a whitelist entry (key, alias, label, or address)")
    .argument("<identifier>", "registry key, alias, label, or address")
    .action(async (identifier: string, _opts: Record<string, unknown>, cmd: Command) => {
      const globals = cmd.optsWithGlobals();
      const network = resolveNetwork(cmd);
      const entries = listRegistryEntries(network);
      const needle = identifier.trim().toLowerCase();

      const match =
        entries.find((e) => e.key.toLowerCase() === needle) ??
        entries.find((e) =>
          (e.aliases ?? []).some((alias) => alias.toLowerCase() === needle)
        ) ??
        entries.find((e) => e.label.toLowerCase() === needle) ??
        entries.find((e) => e.address.toLowerCase() === needle);

      if (!match) {
        const err = {
          error: true,
          code: "WHITELIST_NOT_FOUND",
          message: `No whitelist entry matches "${identifier}" on ${network}.`,
          suggestion:
            "Run 'mantle-cli whitelist tokens' or 'mantle-cli whitelist contracts' to list valid keys."
        };
        if (globals.json) {
          formatJson(err);
        } else {
          console.error(`\n  ${err.message}`);
          console.error(`  ${err.suggestion}\n`);
        }
        process.exit(1);
      }

      const isToken = match.category === "token";
      const detail: Record<string, unknown> = {
        key: match.key,
        label: match.label,
        network,
        environment: match.environment,
        category: match.category,
        address: match.address,
        status: match.status,
        is_official: match.is_official,
        aliases: match.aliases ?? [],
        protocol_group: isToken ? null : protocolGroupOf(match),
        source_url: match.source?.url ?? null,
        source_retrieved_at: match.source?.retrieved_at ?? null
      };
      // Only tokens carry ERC-20 decimals; omit the field entirely for non-tokens
      // to mirror `registry resolve` and avoid showing a meaningless `null` row.
      if (isToken) {
        detail.decimals = match.decimals ?? null;
      }

      if (globals.json) {
        formatJson(detail);
        return;
      }

      const order = [
        "key",
        "label",
        "network",
        "environment",
        "category",
        "protocol_group",
        "address",
        ...(isToken ? ["decimals"] : []),
        "status",
        "is_official",
        "aliases",
        "source_url",
        "source_retrieved_at"
      ];

      formatKeyValue(detail, {
        order,
        labels: {
          key: "Key",
          label: "Label",
          network: "Network",
          environment: "Environment",
          category: "Category",
          protocol_group: "Protocol",
          address: "Address",
          decimals: "Decimals",
          status: "Status",
          is_official: "Official",
          aliases: "Aliases",
          source_url: "Source URL",
          source_retrieved_at: "Source Retrieved At"
        }
      });
    });
}
