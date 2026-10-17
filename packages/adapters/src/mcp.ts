import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { tools } from "./catalog.ts";
import { callTool } from "./tool-client.ts";
const server = new McpServer({ name: "colag", version: "0.1.0" });
const api = process.env.COLAG_API_URL || "http://127.0.0.1:4310";
async function call(name: string, args: unknown) {
  const r = await callTool(api, process.env.COLAG_AGENT_TOKEN || "", name, args);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(r.data) }],
    isError: !r.ok,
  };
}
for (const tool of tools)
  server.tool(tool.name, tool.description, tool.schema, async (args) =>
    call(tool.name, args),
  );
await server.connect(new StdioServerTransport());
