import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorize,
  canClaim,
  mergeable,
  transition,
  validateDependencies,
} from "../packages/domain/src/index.ts";
import {
  EXTERNAL_MCP_PERMISSIONS,
  type Entity,
  type Actor,
} from "../packages/protocol/src/index.ts";
const e = (id: string, data: any): Entity => ({
  id,
  kind: "task",
  projectId: "p",
  data,
  version: 1,
  createdAt: "",
  updatedAt: "",
});
test("dependency gate prevents work before approval and prerequisite completion", () => {
  const task = e("b", { status: "pending", dependencies: ["a"] });
  assert.throws(() =>
    canClaim(
      task,
      [e("a", { status: "completed" })],
      e("run", { status: "awaiting_approval" }),
    ),
  );
  assert.throws(() =>
    canClaim(
      task,
      [e("a", { status: "working" })],
      e("run", { status: "running" }),
    ),
  );
  assert.doesNotThrow(() =>
    canClaim(
      task,
      [e("a", { status: "completed" })],
      e("run", { status: "running" }),
    ),
  );
  assert.throws(() =>
    canClaim(
      { ...task, data: { ...task.data, status: "claimed" } },
      [],
      e("run", { status: "running" }),
    ),
  );
});
test("dependency graph rejects cycles, missing tasks and cross-run edges", () => {
  const tasks = [
    e("a", { runId: "r", dependencies: ["b"] }),
    e("b", { runId: "r", dependencies: [] }),
    e("c", { runId: "other", dependencies: [] }),
  ];
  assert.throws(() => validateDependencies(tasks, "b", ["a"], "r"));
  assert.throws(() => validateDependencies(tasks, "x", ["missing"], "r"));
  assert.throws(() => validateDependencies(tasks, "x", ["c"], "r"));
  assert.doesNotThrow(() => validateDependencies(tasks, "x", ["b"], "r"));
});
test("actor identity cannot grant itself cross-project or merge permissions", () => {
  const actor: Actor = {
    id: "a",
    type: "agent",
    projectId: "p",
    permissions: ["task.claim"],
  };
  assert.throws(() => authorize(actor, "q", "task.claim"));
  assert.throws(() => authorize(actor, "p", "run.merge"));
  assert.doesNotThrow(() => authorize(actor, "p", "task.claim"));
});
test("terminal tasks cannot resume and failed tasks require explicit retry", () => {
  assert.throws(() => transition("completed", "working"));
  assert.throws(() => transition("failed", "working"));
  assert.doesNotThrow(() => transition("failed", "pending"));
  assert.doesNotThrow(() => transition("working", "cancelled"));
});
test("a human acts only inside rooms they belong to", () => {
  const human: Actor = {
    id: "u",
    type: "human",
    projectId: "",
    permissions: [],
    rooms: ["room-a"],
  };
  assert.throws(() => authorize(human, "room-b", "project.read"));
  assert.doesNotThrow(() => authorize(human, "room-a", "run.approve"));
  assert.doesNotThrow(() => authorize(human, "room-a", "run.merge"));
  assert.throws(() =>
    authorize({ ...human, permissions: ["*"] }, "room-a", "run.approve"),
  );
  assert.throws(() =>
    authorize(
      { ...human, permissions: ["document.write"] },
      "room-a",
      "run.merge",
    ),
  );
});
test("a connected client cannot approve a plan or merge", () => {
  const client: Actor = {
    id: "mcp:1",
    type: "external",
    projectId: "room-a",
    permissions: [...EXTERNAL_MCP_PERMISSIONS],
  };
  assert.ok(!EXTERNAL_MCP_PERMISSIONS.includes("run.approve"));
  assert.ok(!EXTERNAL_MCP_PERMISSIONS.includes("run.merge"));
  assert.throws(() => authorize(client, "room-a", "run.approve"));
  assert.throws(() => authorize(client, "room-a", "run.merge"));
  assert.throws(() => authorize(client, "room-b", "document.write"));
  assert.doesNotThrow(() => authorize(client, "room-a", "document.write"));
  assert.doesNotThrow(() => authorize(client, "room-a", "change.propose"));
});
test("merge is bound to candidate, test, review and target SHAs", () => {
  const run = e("r", {
    status: "awaiting_merge",
    candidateSha: "c1",
    testSha: "c1",
    testsPassed: true,
    baseSha: "b1",
  });
  const review = e("review", { sha: "c1", status: "approved" });
  assert.doesNotThrow(() => mergeable(run, review, "b1"));
  assert.throws(() => mergeable(run, review, "b2"));
  assert.throws(() =>
    mergeable(
      { ...run, data: { ...run.data, candidateSha: "c2" } },
      review,
      "b1",
    ),
  );
  assert.throws(() =>
    mergeable(
      run,
      e("review", { sha: "c1", status: "changes_requested" }),
      "b1",
    ),
  );
  assert.throws(() =>
    mergeable(
      { ...run, data: { ...run.data, testsPassed: false } },
      review,
      "b1",
    ),
  );
});
