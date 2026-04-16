import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { MantleMcpError, toErrorPayload } from "@mantleio/mantle-core/errors.js";
import { extractMeta, writeAuditLog } from "./lib/audit-log.js";
import { getPromptMessages, prompts } from "./prompts.js";
import { listResources, prefetchResources, readResource } from "./resources.js";
import { allTools } from "@mantleio/mantle-core/tools/index.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
);

export function createServer(): Server {
  const server = new Server(
    { name: "mantle-mcp", version: pkg.version },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.values(allTools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const tool = allTools[name];
    const { agent_id, session_id, loggableArgs } = extractMeta(args);
    const startTime = Date.now();

    if (!tool) {
      writeAuditLog({
        tool_name: name,
        input: loggableArgs,
        agent_id,
        session_id,
        timestamp: new Date(startTime).toISOString(),
        duration_ms: Date.now() - startTime,
        success: false,
        error_code: "UNKNOWN_TOOL"
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: true,
              code: "UNKNOWN_TOOL",
              message: `Unknown tool: ${name}`,
              suggestion: "Call ListTools first to discover available tool names.",
              details: null
            })
          }
        ],
        isError: true
      };
    }

    try {
      const result = await tool.handler(args);
      writeAuditLog({
        tool_name: name,
        input: loggableArgs,
        agent_id,
        session_id,
        timestamp: new Date(startTime).toISOString(),
        duration_ms: Date.now() - startTime,
        success: true,
        error_code: null
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2) }]
      };
    } catch (error) {
      const errorPayload = toErrorPayload(error);
      writeAuditLog({
        tool_name: name,
        input: loggableArgs,
        agent_id,
        session_id,
        timestamp: new Date(startTime).toISOString(),
        duration_ms: Date.now() - startTime,
        success: false,
        error_code: errorPayload.code ?? "INTERNAL_ERROR"
      });
      return {
        content: [{ type: "text", text: JSON.stringify(errorPayload) }],
        isError: true
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listResources()
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const resource = readResource(uri);
    if (!resource) {
      return {
        contents: [{ uri, mimeType: "text/plain", text: `Resource not found: ${uri}` }]
      };
    }
    return {
      contents: [{ uri, mimeType: resource.mimeType, text: resource.content }]
    };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: prompts
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const messages = getPromptMessages(request.params.name);
    if (!messages) {
      throw new MantleMcpError(
        "PROMPT_NOT_FOUND",
        `Prompt not found: ${request.params.name}`,
        "Call ListPrompts to discover available prompt names.",
        { name: request.params.name }
      );
    }
    return { messages };
  });

  return server;
}

export async function runServer(): Promise<void> {
  const transportMode = process.env.MANTLE_MCP_TRANSPORT ?? "stdio";
  if (transportMode !== "stdio") {
    throw new Error("Only stdio transport is currently supported. Set MANTLE_MCP_TRANSPORT=stdio.");
  }

  const server = createServer();
  await prefetchResources();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
