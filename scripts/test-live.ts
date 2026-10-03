import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
process.loadEnvFile(".env");
if (!process.argv.includes("--approve-test-gates"))
  throw new Error(
    "Explicit --approve-test-gates flag required for this disposable acceptance test.",
  );
const store = await import("../apps/service/src/store.ts");
const identity = await import("../apps/service/src/identity.ts");
const { pool, hash } = await import("../packages/database/src.ts");
const owner = await identity.upsertUser("acceptance@colag.test", "Acceptance");
const room = await store.provisionRoom(owner.id, "Acceptance");
const token = await store.issue(
  {
    id: owner.id,
    type: "human",
    projectId: room.id,
    permissions: [],
    rooms: [room.id],
    displayName: owner.displayName,
  },
  2,
);
async function command(body: any) {
  const r = await fetch(
    `http://127.0.0.1:4310/api/v1/projects/${room.id}/commands`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify(body),
    },
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
let runId = "",
  last = "";
try {
  const run = await command({
    type: "run.start",
    request:
      "Build authentication. This is a live acceptance test in the disposable sample. Implement the fixed register/login/authenticate/logout Node contract and the React forms using the injected api prop. Keep scope small and preserve the supplied tests and HTTP adapter.",
  });
  runId = run.id;
  for (let i = 0; i < 900; i++) {
    const r = await store.get(runId);
    if (r.data.status !== last) {
      last = r.data.status;
      console.log(new Date().toISOString(), last);
    }
    if (last === "awaiting_approval") {
      console.log(
        "Acceptance test approving its disposable plan:",
        r.data.plan?.title,
      );
      await command({ type: "run.approve", runId });
    }
    if (last === "awaiting_merge") {
      console.log(
        "Acceptance test approving tested commit:",
        r.data.candidateSha,
      );
      await command({ type: "run.merge", runId });
    }
    if (last === "completed") {
      await writeFile(
        ".colag/live-acceptance.json",
        JSON.stringify(
          {
            runId,
            status: last,
            sha: r.data.mergedSha,
            at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      console.log(
        "PASS: live Claude → MCP → isolated Git → Docker tests → QA → approval → merge",
      );
      break;
    }
    if (["failed", "blocked", "cancelled"].includes(last))
      throw new Error(`${last}: ${r.data.error || "See run artifacts"}`);
    if (i === 899) throw new Error("Live test exceeded 30 minutes");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
} finally {
  await pool.query("DELETE FROM credentials WHERE hash=$1", [hash(token)]);
  await pool.end();
}
