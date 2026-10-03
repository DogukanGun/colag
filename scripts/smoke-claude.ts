import { randomUUID } from "node:crypto";
process.loadEnvFile(".env");
const { issue, pool } = await import("../apps/service/src/smoke-deps.ts");
const store = await import("../apps/service/src/store.ts");
const identity = await import("../apps/service/src/identity.ts");
const { runClaude } = await import("../packages/runtime/src/claude.ts");
const owner = await identity.upsertUser("smoke@colag.test", "Smoke");
const room = await store.provisionRoom(owner.id, "Smoke");
const token = await issue(
  {
    id: `agent-coordinator-${room.id}`,
    type: "agent",
    projectId: room.id,
    permissions: ["project.read"],
  },
  1,
);
try {
  const result = await runClaude({
    sessionId: randomUUID(),
    token,
    signal: AbortSignal.timeout(120000),
    prompt:
      "Use the Colag inspect_project MCP tool. Report only the project name and number of configured agents. Do not change anything.",
    onOutput: (line) => {
      if (line.type === "system" && line.subtype === "init")
        console.log(
          "Claude session initialized; configured MCP servers:",
          line.mcp_servers,
        );
    },
  });
  console.log("Live Claude result:", result);
} finally {
  await pool.end();
}
