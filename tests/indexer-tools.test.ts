import { describe, expect, it } from "vitest";
import { queryIndexerSql, querySubgraph } from "@0xwh1sker/mantle-core/tools/indexer.js";

describe("indexer tools", () => {
  it("blocks unsafe endpoints", async () => {
    await expect(
      querySubgraph({
        endpoint: "http://127.0.0.1:8080/graphql",
        query: "{ pairs { id } }"
      })
    ).rejects.toMatchObject({ code: "ENDPOINT_NOT_ALLOWED" });
  });

  it("allows loopback http when local override is enabled", async () => {
    const previous = process.env.MANTLE_ALLOW_HTTP_LOCAL_ENDPOINTS;
    process.env.MANTLE_ALLOW_HTTP_LOCAL_ENDPOINTS = "true";

    try {
      const result = await querySubgraph(
        {
          endpoint: "http://127.0.0.1:8080/graphql",
          query: "{ pairs { id } }"
        },
        {
          fetchJson: async () => ({
            json: { data: { pairs: [{ id: "1" }] }, errors: null },
            elapsed_ms: 7,
            response_bytes: 64
          })
        }
      );

      expect(result.endpoint).toBe("http://127.0.0.1:8080/graphql");
      expect(result.data.pairs[0].id).toBe("1");
    } finally {
      if (previous == null) {
        delete process.env.MANTLE_ALLOW_HTTP_LOCAL_ENDPOINTS;
      } else {
        process.env.MANTLE_ALLOW_HTTP_LOCAL_ENDPOINTS = previous;
      }
    }
  });

  it("rejects SQL mutation queries", async () => {
    await expect(
      queryIndexerSql({
        endpoint: "https://indexer.example.com/sql",
        query: "DELETE FROM swaps"
      })
    ).rejects.toMatchObject({ code: "INDEXER_ERROR" });
  });

  it("queries subgraph with response warnings", async () => {
    const result = await querySubgraph(
      {
        endpoint: "https://indexer.example.com/graphql",
        query: "{ pairs { id pageInfo { hasNextPage } } }",
        timeout_ms: 1000
      },
      {
        fetchJson: async () => ({
          json: {
            data: {
              pairs: {
                nodes: [{ id: "1" }],
                pageInfo: { hasNextPage: true }
              }
            },
            errors: null
          },
          elapsed_ms: 10,
          response_bytes: 256
        })
      }
    );

    expect(result.endpoint).toBe("https://indexer.example.com/graphql");
    expect(result.data.pairs.nodes[0].id).toBe("1");
    expect(result.elapsed_ms).toBe(10);
    expect(result.warnings.join(" ")).toContain("hasNextPage");
  });

  it("enforces max response bytes for subgraph queries", async () => {
    const previous = process.env.MANTLE_SUBGRAPH_MAX_RESPONSE_BYTES;
    process.env.MANTLE_SUBGRAPH_MAX_RESPONSE_BYTES = "32";

    try {
      await expect(
        querySubgraph(
          {
            endpoint: "https://indexer.example.com/graphql",
            query: "{ pairs { id } }"
          },
          {
            fetchJson: async () => ({
              json: { data: { pairs: [{ id: "1" }] }, errors: null },
              elapsed_ms: 5,
              response_bytes: 128
            })
          }
        )
      ).rejects.toMatchObject({ code: "INDEXER_ERROR" });
    } finally {
      if (previous == null) {
        delete process.env.MANTLE_SUBGRAPH_MAX_RESPONSE_BYTES;
      } else {
        process.env.MANTLE_SUBGRAPH_MAX_RESPONSE_BYTES = previous;
      }
    }
  });

  it("queries SQL endpoint with truncation", async () => {
    const result = await queryIndexerSql(
      {
        endpoint: "https://indexer.example.com/sql",
        query: "SELECT block_number FROM swaps"
      },
      {
        maxRows: 1,
        fetchJson: async () => ({
          json: {
            columns: ["block_number"],
            rows: [[1], [2]],
            row_count: 2
          },
          elapsed_ms: 8,
          response_bytes: 128
        })
      }
    );

    expect(result.columns).toEqual(["block_number"]);
    expect(result.rows).toEqual([[1]]);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(" ")).toContain("truncated");
  });
});
