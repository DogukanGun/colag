import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { remoteTools } from "../../../packages/adapters/src/catalog.ts";
import type { Actor } from "../../../packages/protocol/src/index.ts";
import { tools as runTool } from "./engine.ts";

export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  actor: Actor,
) {
  const server = new McpServer({ name: "colag", version: "0.1.0" });
  for (const tool of remoteTools())
    server.tool(tool.name, tool.description, tool.schema, async (args) => {
      try {
        const result = await runTool(actor, tool.name, args, randomUUID());
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (e: any) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: e.message,
                code: e.code || "tool_error",
              }),
            },
          ],
        };
      }
    });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  res.on("close", () => {
    void server.close().catch(() => {});
  });
  await transport.handleRequest(req, res, body);
}
