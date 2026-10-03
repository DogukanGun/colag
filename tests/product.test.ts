import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
process.env.NODE_ENV = "test";
import { authRequestBody } from "../apps/service/src/identity.ts";
import { remoteTools } from "../packages/adapters/src/catalog.ts";
import { commandSchema } from "../packages/protocol/src/validation.ts";
import { pool } from "../packages/database/src.ts";
const enabled = process.env.COLAG_DATABASE_TESTS === "1";
after(async () => {
  await pool.end();
});
test("development shows a sign-in code until mail is configured", () => {
  assert.equal(authRequestBody("123456", true, "development").code, undefined);
  assert.equal(authRequestBody("123456", false, "development").code, "123456");
  assert.equal(authRequestBody("123456", false, "production").code, undefined);
});
test("remote MCP tools do not approve or merge", () => {
  const names = remoteTools().map((tool) => tool.name);
  assert.ok(names.includes("inspect_project"));
  assert.ok(names.includes("write_document"));
  assert.ok(names.includes("write_file"));
  assert.ok(names.includes("propose_change"));
  assert.equal(names.includes("submit_review"), false);
  assert.equal(
    names.some((name) => name.includes("approve") || name.includes("merge")),
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      type: "agent.prompt",
      agentId: "agent-1",
      command: "Draft the plan",
    }).success,
    true,
  );
});
test(
  "sign-in, room isolation, revoked mcp tokens, and agent.prompt",
  { skip: !enabled },
  async () => {
    process.env.COLAG_DATA_DIR = path.resolve(".colag/product-" + randomUUID());
    const { migrate, hash } = await import("../packages/database/src.ts");
    const store = await import("../apps/service/src/store.ts");
    const identity = await import("../apps/service/src/identity.ts");
    const engine = await import("../apps/service/src/engine.ts");
    await migrate();
    const email = `person-${randomUUID()}@colag.test`;
    const requested = await identity.requestCode(email);
    assert.equal(requested.code?.length, 6);
    await assert.rejects(
      () => identity.verifyCode({ email, code: requested.code }),
      /display name/i,
    );
    const first = await identity.verifyCode({
      email,
      code: requested.code,
      displayName: "Ada Lovelace",
    });
    assert.equal(first.user.displayName, "Ada Lovelace");
    await assert.rejects(
      () =>
        identity.verifyCode({
          email,
          code: requested.code,
          displayName: "Ada Lovelace",
        }),
      /already been used/i,
    );
    const session = await identity.userFromSession(first.token);
    assert.equal(session.id, first.user.id);
    await identity.revokeSession(first.token);
    await assert.rejects(
      () => identity.userFromSession(first.token),
      /sign in required/i,
    );
    const other = await identity.upsertUser(
      `other-${randomUUID()}@colag.test`,
      "Grace Hopper",
    );
    assert.notEqual(other.id, first.user.id);
    const roomA = await store.provisionRoom(first.user.id, "Room A");
    const roomB = await store.provisionRoom(other.id, "Room B");
    const memberA = await identity.memberActor(first.user, roomA.id);
    await assert.rejects(
      () => identity.memberActor(first.user, roomB.id),
      /membership/i,
    );
    const expired = await identity.requestCode(`expired-${randomUUID()}@colag.test`);
    await pool.query(
      "UPDATE login_codes SET expires_at=now()-interval '1 minute' WHERE code_hash=$1",
      [hash(expired.code!)],
    );
    await assert.rejects(
      () => identity.verifyCode({ email: expired.email, code: expired.code, displayName: "Late" }),
      /expired/i,
    );
    const agentToken = await store.issue({
      id: "agent-test",
      type: "agent",
      projectId: roomA.id,
      permissions: ["project.read"],
    });
    await assert.rejects(
      () => identity.openMe(undefined, agentToken),
      /cannot open the UI/i,
    );
    const fresh = await identity.verifyCode({
      email,
      code: (await identity.requestCode(email)).code,
    });
    assert.equal(fresh.user.id, first.user.id);
    const connection = await identity.createConnection(
      fresh.user,
      roomA.id,
      "Cursor",
    );
    const mcp = await identity.authenticateMcp(connection.token);
    assert.equal(mcp.projectId, roomA.id);
    assert.equal(mcp.permissions.includes("run.approve"), false);
    await assert.rejects(
      () =>
        engine.command(mcp, randomUUID(), {
          type: "run.approve",
          runId: "missing",
        }),
      /Permission denied: run.approve/,
    );
    await assert.rejects(
      () =>
        engine.command(mcp, randomUUID(), {
          type: "run.merge",
          runId: "missing",
        }),
      /Permission denied: run.merge/,
    );
    await identity.revokeConnection(roomA.id, connection.id, fresh.user.id);
    await assert.rejects(
      () => identity.authenticateMcp(connection.token),
      /revoked/i,
    );
    await assert.rejects(
      () => identity.authenticateMcp(fresh.token),
      /invalid or revoked/i,
    );
    engine.configureTestRuntime({
      preflight: async () => ({
        docker: { ok: true, detail: "ok" },
        claude: { ok: true, detail: "ok" },
      }),
      runClaude: async (request) => {
        if (request.schema)
          return {
            title: "Prompted plan",
            document: "A plan drafted by Atlas. Approval stays with the member.",
            tasks: [
              {
                key: "architecture",
                title: "Contract",
                description: "Write the contract",
                role: "Architect",
                dependencies: [],
                relatedFiles: ["architecture.md"],
              },
              {
                key: "backend",
                title: "Service",
                description: "Write the service",
                role: "Backend",
                dependencies: ["architecture"],
                relatedFiles: ["backend/auth.mjs"],
              },
            ],
          };
        return "Noted";
      },
    });
    const atlas = (await store.resources(roomA.id)).find(
      (agent) => agent.kind === "agent" && agent.data.role === "Coordinator",
    )!;
    await engine.command(memberA, randomUUID(), {
      type: "agent.prompt",
      agentId: atlas.id,
      command: "Draft a small plan.",
    });
    let status = "";
    for (let i = 0; i < 80; i++) {
      const runs = (await store.resources(roomA.id)).filter(
        (resource) => resource.kind === "run",
      );
      status = runs.at(-1)?.data.status || "";
      if (status === "awaiting_approval" || status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(status, "awaiting_approval");
    const events = await store.events(0, roomA.id);
    assert.equal(
      events.some((event) => event.type === "run.plan.approved"),
      false,
    );
    assert.equal(
      events.some((event) => event.type === "change.merged"),
      false,
    );
    await assert.rejects(
      () =>
        engine.command(
          {
            id: atlas.id,
            type: "agent",
            projectId: roomA.id,
            permissions: ["run.approve", "run.merge"],
          },
          randomUUID(),
          { type: "run.approve", runId: "nope" },
        ),
      /Human/,
    );
  },
);
