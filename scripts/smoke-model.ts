import { randomUUID } from "node:crypto";
process.loadEnvFile(".env");
const { issue, pool } = await import("../apps/service/src/smoke-deps.ts");
const store = await import("../apps/service/src/store.ts");
const identity = await import("../apps/service/src/identity.ts");
const { runAgent, modelProvider, preflight } = await import(
  "../packages/runtime/src/index.ts"
);
console.log("Provider:", modelProvider());
console.log("Preflight:", await preflight());
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
  const result = await runAgent({
    sessionId: randomUUID(),
    token,
    signal: AbortSignal.timeout(120000),
    prompt:
      "Use the Colag inspect_project tool. Report only the project name and number of configured agents. Do not change anything.",
    onOutput: (line) => {
      if (line.type === "system" && line.subtype === "init")
        console.log("Session initialized:", {
          provider: line.provider || "claude",
          model: line.model,
          mcp_servers: line.mcp_servers,
          tools: line.tools?.length,
        });
      if (line.type === "result" && line.usage)
        console.log("Token usage:", line.usage);
    },
  });
  console.log("Live model result:", result);
} finally {
  await pool.end();
}
