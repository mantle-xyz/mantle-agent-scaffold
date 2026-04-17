import { MantleMcpError } from "../errors.js";
import { ensureEndpointSafe, ensureReadOnlySql, safeFetchOptions } from "../lib/endpoint-policy.js";
import type { Tool } from "../types.js";

interface FetchResult {
  json: any;
  elapsed_ms: number;
  response_bytes: number;
}

interface IndexerDeps {
  fetchJson: (endpoint: string, body: Record<string, unknown>, timeoutMs: number) => Promise<FetchResult>;
  now: () => string;
  maxRows: number;
  maxSubgraphResponseBytes: number;
  /** Optional override for DNS resolution. Pass `async () => {}` in tests to skip real DNS. */
  dnsResolver?: (hostname: string) => Promise<void>;
}

function containsHasNextPageTrue(value: unknown): boolean {
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const current = queue.pop();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!current || typeof current !== "object") {
      continue;
    }

    const record = current as Record<string, unknown>;
    if (record.hasNextPage === true) {
      return true;
    }

    queue.push(...Object.values(record));
  }

  return false;
}

const defaultDeps: IndexerDeps = {
  fetchJson: async (endpoint, body, timeoutMs) => {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, safeFetchOptions({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      }));
      const text = await response.text();
      const responseBytes = Buffer.byteLength(text, "utf8");
      const json = text.length === 0 ? {} : JSON.parse(text);
      return { json, elapsed_ms: Date.now() - start, response_bytes: responseBytes };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new MantleMcpError(
          "INDEXER_TIMEOUT",
          "Indexer query timed out.",
          "Retry with a larger timeout_ms or simplify the query.",
          { endpoint, timeout_ms: timeoutMs, retryable: true }
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
  now: () => new Date().toISOString(),
  maxRows: 1000,
  maxSubgraphResponseBytes: 1048576
};

function withDeps(overrides?: Partial<IndexerDeps>): IndexerDeps {
  return {
    ...defaultDeps,
    maxRows: Number(process.env.MANTLE_INDEXER_MAX_ROWS ?? String(defaultDeps.maxRows)),
    maxSubgraphResponseBytes: Number(
      process.env.MANTLE_SUBGRAPH_MAX_RESPONSE_BYTES ?? String(defaultDeps.maxSubgraphResponseBytes)
    ),
    ...overrides
  };
}

export async function querySubgraph(
  args: Record<string, unknown>,
  deps?: Partial<IndexerDeps>
): Promise<any> {
  const resolvedDeps = withDeps(deps);
  const endpointInput = typeof args.endpoint === "string" ? args.endpoint : "";
  const query = typeof args.query === "string" ? args.query : "";
  const variables = (args.variables ?? {}) as Record<string, unknown>;
  const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 15000;

  if (!endpointInput || !query) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "Subgraph endpoint and query are required.",
      "Provide both endpoint and query.",
      { endpoint: endpointInput || null, query: query || null }
    );
  }

  const endpoint = (await ensureEndpointSafe(endpointInput, resolvedDeps.dnsResolver)).toString();

  try {
    const { json, elapsed_ms, response_bytes } = await resolvedDeps.fetchJson(
      endpoint,
      { query, variables },
      timeoutMs
    );

    const maxResponseBytes =
      resolvedDeps.maxSubgraphResponseBytes > 0
        ? resolvedDeps.maxSubgraphResponseBytes
        : 1048576;

    if (response_bytes > maxResponseBytes) {
      throw new MantleMcpError(
        "INDEXER_ERROR",
        `Subgraph response exceeds size limit (${response_bytes} > ${maxResponseBytes} bytes).`,
        "Reduce query scope or set MANTLE_SUBGRAPH_MAX_RESPONSE_BYTES to a higher value if safe.",
        {
          endpoint,
          response_bytes,
          max_response_bytes: maxResponseBytes,
          retryable: false
        }
      );
    }

    const warnings: string[] = [];
    if (containsHasNextPageTrue(json.data)) {
      warnings.push("hasNextPage=true detected; query may be paginated.");
    }

    return {
      data: json.data ?? null,
      errors: json.errors ?? null,
      endpoint,
      queried_at_utc: resolvedDeps.now(),
      elapsed_ms,
      warnings
    };
  } catch (error) {
    if (error instanceof MantleMcpError) {
      throw error;
    }
    throw new MantleMcpError(
      "INDEXER_ERROR",
      error instanceof Error ? error.message : String(error),
      "Check endpoint reachability and query shape, then retry.",
      { endpoint, raw_error: error instanceof Error ? error.message : String(error), retryable: true }
    );
  }
}

export async function queryIndexerSql(
  args: Record<string, unknown>,
  deps?: Partial<IndexerDeps>
): Promise<any> {
  const resolvedDeps = withDeps(deps);
  const endpointInput = typeof args.endpoint === "string" ? args.endpoint : "";
  const query = typeof args.query === "string" ? args.query : "";
  const params = (args.params ?? {}) as Record<string, unknown>;
  const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 15000;

  if (!endpointInput || !query) {
    throw new MantleMcpError(
      "INVALID_INPUT",
      "SQL endpoint and query are required.",
      "Provide both endpoint and query.",
      { endpoint: endpointInput || null, query: query || null }
    );
  }

  ensureReadOnlySql(query);
  const endpoint = (await ensureEndpointSafe(endpointInput, resolvedDeps.dnsResolver)).toString();

  try {
    const { json, elapsed_ms } = await resolvedDeps.fetchJson(
      endpoint,
      { query, params },
      timeoutMs
    );

    const columns = Array.isArray(json.columns) ? json.columns.map(String) : [];
    const rows = Array.isArray(json.rows) ? json.rows : [];
    const rowCount = typeof json.row_count === "number" ? json.row_count : rows.length;

    const maxRows = resolvedDeps.maxRows > 0 ? resolvedDeps.maxRows : 1000;
    const truncated = rows.length > maxRows;
    const limitedRows = truncated ? rows.slice(0, maxRows) : rows;
    const warnings = truncated ? [`Result truncated to ${maxRows} rows.`] : [];

    return {
      columns,
      rows: limitedRows,
      row_count: rowCount,
      endpoint,
      queried_at_utc: resolvedDeps.now(),
      elapsed_ms,
      truncated,
      warnings
    };
  } catch (error) {
    if (error instanceof MantleMcpError) {
      throw error;
    }
    throw new MantleMcpError(
      "INDEXER_ERROR",
      error instanceof Error ? error.message : String(error),
      "Check endpoint reachability, authentication, and SQL syntax, then retry.",
      { endpoint, raw_error: error instanceof Error ? error.message : String(error), retryable: true }
    );
  }
}

export const indexerTools: Record<string, Tool> = {
  querySubgraph: {
    name: "mantle_querySubgraph",
    description:
      "Execute a GraphQL query against a Mantle indexer endpoint. Examples: query Agni pool snapshots from https://indexer.example.com/graphql for router 0x319B69888b0d11cEC22caA5034e25FfFBDc88421.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "GraphQL endpoint URL." },
        query: { type: "string", description: "GraphQL query document." },
        variables: { type: "object", description: "Optional GraphQL variables." },
        timeout_ms: { type: "number", description: "Request timeout in milliseconds." }
      },
      required: ["endpoint", "query"]
    },
    handler: querySubgraph
  },
  queryIndexerSql: {
    name: "mantle_queryIndexerSql",
    description:
      "Execute a read-only SQL query against an indexer API. Examples: SELECT liquidity rows for USDC 0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9 from https://indexer.example.com/sql.",
    inputSchema: {
      type: "object",
      properties: {
        endpoint: { type: "string", description: "SQL indexer endpoint URL." },
        query: { type: "string", description: "Read-only SQL query." },
        params: { type: "object", description: "Optional query params." },
        timeout_ms: { type: "number", description: "Request timeout in milliseconds." }
      },
      required: ["endpoint", "query"]
    },
    handler: queryIndexerSql
  }
};
