import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  pool,
  migrate,
  transaction,
  entity,
} from "../packages/database/src.ts";
import { basicCommand } from "../apps/service/src/store.ts";
import type { Actor } from "../packages/protocol/src/index.ts";
const enabled = process.env.COLAG_DATABASE_TESTS === "1";
after(async () => {
  await pool.end();
});
test(
  "concurrent claims, idempotency, audit atomicity and expired leases",
  { skip: !enabled },
  async () => {
    await migrate();
    const projectId = "test-" + randomUUID();
    const system: Actor = {
      id: "s-" + projectId,
      type: "system",
      projectId,
      permissions: ["*"],
    };
    const a: Actor = {
      id: "a-" + projectId,
      type: "agent",
      projectId,
      permissions: ["task.claim", "lock.acquire"],
    };
    const b: Actor = { ...a, id: "b-" + projectId };
    try {
      const fixture = await transaction(system, "fixture", {}, async (tx) => {
        await tx.create("agent", { role: "Backend" }, undefined, a.id);
        await tx.create("agent", { role: "Backend" }, undefined, b.id);
        const run = await tx.create("run", { status: "running" });
        const task = await tx.create("task", {
          status: "pending",
          role: "Backend",
          dependencies: [],
          runId: run.id,
        });
        return { run, task };
      });
      const claims = await Promise.allSettled([
        basicCommand(a, "claim-a", {
          type: "task.claim",
          taskId: fixture.task.id,
        }),
        basicCommand(b, "claim-b", {
          type: "task.claim",
          taskId: fixture.task.id,
        }),
      ]);
      assert.equal(claims.filter((x) => x.status === "fulfilled").length, 1);
      const actor = claims[0].status === "fulfilled" ? a : b;
      const key = claims[0].status === "fulfilled" ? "claim-a" : "claim-b";
      const replay = await basicCommand(actor, key, {
        type: "task.claim",
        taskId: fixture.task.id,
      });
      assert.equal(replay?.id, fixture.task.id);
      await assert.rejects(
        () =>
          basicCommand(actor, key, { type: "task.claim", taskId: "different" }),
        /Idempotency/,
      );
      const count = await pool.query(
        "SELECT count(*) FROM events WHERE project_id=$1 AND type=$2",
        [projectId, "task.claimed"],
      );
      assert.equal(Number(count.rows[0].count), 1);
      await assert.rejects(() =>
        transaction(system, "rollback", {}, async (tx) => {
          await tx.create("decision", { title: "Must roll back" });
          throw new Error("stop");
        }),
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM resources WHERE project_id=$1 AND kind=$2",
            [projectId, "decision"],
          )
        ).rows[0].count,
        "0",
      );
      await basicCommand(a, "lock-1", {
        type: "lock.acquire",
        resource: "migration",
        ttlMs: 1,
        reason: "test",
      });
      await new Promise((r) => setTimeout(r, 5));
      await assert.doesNotReject(async () =>
        basicCommand(b, "lock-2", {
          type: "lock.acquire",
          resource: "migration",
          ttlMs: 1000,
          reason: "test",
        }),
      );
    } finally {
      await pool.query("DELETE FROM resources WHERE project_id=$1", [
        projectId,
      ]);
      await pool.query("DELETE FROM events WHERE project_id=$1", [projectId]);
      await pool.query("DELETE FROM commands WHERE actor_id=ANY($1)", [
        [system.id, a.id, b.id],
      ]);
    }
  },
);
