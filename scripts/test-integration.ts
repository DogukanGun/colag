import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.COLAG_TEST_DATABASE_URL || "postgres://127.0.0.1:5432/colag_test";
process.env.COLAG_DATA_DIR = path.resolve(".colag/test-" + randomUUID());
import assert from "node:assert/strict";
const { pool, migrate } = await import("../packages/database/src.ts");
const store = await import("../apps/service/src/store.ts");
const identity = await import("../apps/service/src/identity.ts");
const engine = await import("../apps/service/src/engine.ts");
const { collaboration } = await import("../apps/service/src/documents.ts");
const git = await import("../packages/git/src/index.ts");
await migrate();
const owner = await identity.upsertUser("integration@colag.test", "Integration");
const room = await store.provisionRoom(owner.id, "Integration room");
const human = await identity.memberActor(owner, room.id);
const agentId = async (role: string) =>
  (await store.resources(room.id)).find(
    (a) => a.kind === "agent" && a.data.role === role,
  )!.id;
const calls: string[] = [];
engine.configureTestRuntime({
  preflight: async () => ({
    docker: { ok: true, detail: "Deterministic test runner" },
    model: { ok: true, detail: "Deterministic agent fixture" },
  }),
  testSandbox: async () => ({
    passed: true,
    output: "Deterministic integration fixture: test runner passed.",
  }),
  runAgent: async (r) => {
    const actor = await store.authenticate(r.token);
    calls.push(actor.id);
    const role = (await store.resources(actor.projectId)).find(
      (a) => a.id === actor.id,
    )?.data.role;
    if (r.schema)
      return {
        title: "Fixture authentication plan",
        document: "A deterministic integration test, not a live agent run.",
        tasks: [
          {
            key: "architecture",
            title: "Define contract",
            description: "Define the API contract",
            role: "Architect",
            dependencies: [],
            relatedFiles: ["architecture.md"],
          },
          {
            key: "backend",
            title: "Backend implementation",
            description: "Implement backend fixture",
            role: "Backend",
            dependencies: ["architecture"],
            relatedFiles: ["backend/auth.mjs"],
          },
          {
            key: "frontend",
            title: "Frontend implementation",
            description: "Implement frontend fixture",
            role: "Frontend",
            dependencies: ["architecture"],
            relatedFiles: ["frontend/App.jsx"],
          },
        ],
      };
    const tool = (name: string, args: any = {}) =>
      engine.tools(actor, name, args, randomUUID());
    await tool("inspect_project");
    if (role === "Architect") {
      await tool("write_file", {
        path: "architecture.md",
        content:
          "# Authentication contract\nregister, login, authenticate and logout.",
      });
      await tool("create_decision", {
        title: "Authentication contract",
        description: "Use Node crypto and opaque sessions.",
      });
    }
    if (role === "Backend") {
      await assert.rejects(
        () =>
          tool("write_file", {
            path: "backend/auth.test.mjs",
            content: "tamper",
          }),
        /not assigned/,
      );
      await tool("write_file", {
        path: "backend/auth.mjs",
        content: 'export const fixture = "backend implementation";\n',
      });
    }
    if (role === "Frontend")
      await tool("write_file", {
        path: "frontend/App.jsx",
        content:
          "export default function App(){return <main>Fixture login</main>}\n",
      });
    if (role === "QA") {
      const diff = await tool("inspect_diff");
      assert.equal(diff.length, 3);
      await tool("submit_review", {
        status: "approved",
        comments: "Deterministic fixture approves the candidate.",
      });
    } else await tool("propose_change");
    return "Fixture completed";
  },
});
async function wait(id: string, status: string) {
  for (let i = 0; i < 160; i++) {
    const r = await store.get(id);
    if (r.data.status === status) return r;
    if (r.data.status === "failed") throw new Error(r.data.error);
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Timed out waiting for " + status);
}
let runId: string | undefined;
try {
  const started = await engine.command(human, randomUUID(), {
    type: "run.start",
    request: "Build authentication.",
  });
  runId = started.id;
  let run = await wait(started.id, "awaiting_approval");
  assert.deepEqual(calls, [await agentId("Coordinator")]);
  const tasks = (await store.resources(room.id)).filter(
    (x) => x.kind === "task" && x.data.runId === run.id,
  );
  assert.equal(tasks.length, 3);
  await assert.rejects(
    () =>
      engine.command(
        {
          id: "agent-backend",
          type: "agent",
          projectId: room.id,
          permissions: ["run.approve"],
        },
        randomUUID(),
        { type: "run.approve", runId: run.id },
      ),
    /Human/,
  );
  await engine.command(human, randomUUID(), {
    type: "run.approve",
    runId: run.id,
  });
  run = await wait(run.id, "awaiting_merge");
  assert.equal(calls.at(-1), await agentId("QA"));
  assert.equal(run.data.testSha, run.data.candidateSha);
  const key = randomUUID();
  await engine.command(human, key, { type: "run.merge", runId: run.id });
  await engine.command(human, key, { type: "run.merge", runId: run.id });
  assert.equal((await store.get(run.id)).data.status, "completed");
  assert.equal(
    await git.git(git.repoPath(run.id), "rev-parse", "main"),
    run.data.candidateSha,
  );
  const events = await store.events(0, room.id);
  assert.equal(
    events.filter((e) => e.type === "change.merged" && e.resourceId === run.id)
      .length,
    1,
  );
  const cursor = events.find(
    (e) => e.type === "run.plan.approved" && e.resourceId === run.id,
  )!.seq;
  assert.ok((await store.events(cursor, room.id)).every((e) => e.seq > cursor));
  console.log(
    "PASS: plan gate → dependency scheduling → isolated Git changes → tests → independent review → exact-commit human merge → idempotent replay",
  );
  process.env.COLAG_A2A_PORT = "4332";
  const { startA2A } = await import("../packages/adapters/src/a2a.ts");
  const { ClientFactory } = await import("@a2a-js/sdk/client");
  const { Message } = await import("@a2a-js/sdk");
  const gateway = await startA2A();
  try {
    const token = await store.issue({
      id: "external-test",
      type: "external",
      projectId: room.id,
      permissions: ["project.read", "run.start", "run.stop"],
    });
    const client = await new ClientFactory().createFromUrl(
      "http://127.0.0.1:4332",
    );
    const options = { serviceParameters: { Authorization: `Bearer ${token}` } };
    const submitted = await client.sendMessage(
      {
        message: Message.fromJSON({
          messageId: randomUUID(),
          role: "ROLE_USER",
          parts: [{ text: "Build authentication through A2A." }],
        }),
        tenant: "",
        configuration: undefined,
        metadata: undefined,
      },
      options,
    );
    assert.ok("status" in submitted);
    const externalRun = await wait(
      submitted.metadata!.runId,
      "awaiting_approval",
    );
    const polled = await client.getTask(
      { id: (submitted as any).id, tenant: "" },
      options,
    );
    assert.equal(polled.status?.state, 6);
    await client.cancelTask(
      { id: (submitted as any).id, tenant: "", metadata: undefined },
      options,
    );
    assert.equal((await store.get(externalRun.id)).data.status, "cancelled");
    console.log(
      "PASS: independent A2A client discovery, authenticated submission, durable mapping, status and cancellation",
    );
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
  console.log(
    "Fixture agents and test runner were deterministic; no live model or sandbox result is implied.",
  );
} finally {
  await collaboration.destroy();
  await pool.end();
  await rm(process.env.COLAG_DATA_DIR!, { recursive: true, force: true });
}
