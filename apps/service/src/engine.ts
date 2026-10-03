import { randomUUID } from "node:crypto";
import { isActiveRunStatus } from "../../../packages/protocol/src/index.ts";
import { commandSchema } from "../../../packages/protocol/src/validation.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { transaction, pool } from "../../../packages/database/src.ts";
import {
  assert,
  authorize,
  mergeable,
} from "../../../packages/domain/src/index.ts";
import type {
  Actor,
  Entity,
  Command,
  Plan,
} from "../../../packages/protocol/src/index.ts";
import * as store from "./store.ts";
import * as git from "../../../packages/git/src/index.ts";
import { preflight, runClaude } from "../../../packages/runtime/src/claude.ts";
import {
  AGENT_DOCUMENT_APPEND,
  readDocument,
  writeDocument,
} from "./documents.ts";
// Dependency injection is available only to the isolated test process.
const runtime = { preflight, runClaude, testSandbox: git.testSandbox };
export function configureTestRuntime(overrides: Partial<typeof runtime>) {
  assert(
    process.env.NODE_ENV === "test",
    "Test runtime is disabled outside tests",
  );
  Object.assign(runtime, overrides);
}
const controllers = new Map<string, AbortController>();
const jobs = new Set<string>();
const planSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    document: { type: "string" },
    tasks: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          role: { type: "string", enum: ["Architect", "Backend", "Frontend"] },
          dependencies: { type: "array", items: { type: "string" } },
          relatedFiles: { type: "array", items: { type: "string" } },
        },
        required: [
          "key",
          "title",
          "description",
          "role",
          "dependencies",
          "relatedFiles",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "document", "tasks"],
  additionalProperties: false,
};
export async function command(
  actor: Actor,
  key: string,
  c: Command,
): Promise<any> {
  const parsed = commandSchema.safeParse(c);
  assert(
    parsed.success,
    parsed.success ? "" : parsed.error.issues.map((i) => i.message).join("; "),
  );
  c = parsed.data;
  authorize(actor, actor.projectId, c.type);
  if (c.type === "agent.prompt") return promptAgent(actor, key, c);
  if (c.type === "board.submit") return submitBoard(actor, key, c);
  if (c.type === "run.start") {
    assert(
      actor.type === "human" || actor.type === "external",
      "Run creation requires human or external identity",
      "forbidden",
      403,
    );
    assert(
      c.request?.trim() && c.request.length < 12000,
      "Provide a request under 12000 characters",
    );
    const prior = await pool.query(
      "SELECT fingerprint,result FROM commands WHERE actor_id=$1 AND key=$2",
      [actor.id, key],
    );
    if (prior.rows[0]) return transaction(actor, key, c, async () => null);
    const checks = await runtime.preflight({ sandbox: true });
    assert(
      Object.values(checks).every((x) => x.ok),
      Object.entries(checks)
        .filter(([, v]) => !v.ok)
        .map(([, v]) => v.detail)
        .join(" "),
      "prerequisite",
      503,
    );
    const run = await transaction(actor, key, c, async (tx) => {
      assert(
        !(await tx.list("run")).some(
          (r) => r.data.purpose !== "board" && isActiveRunStatus(r.data.status),
        ),
        "Finish or stop the active run first",
        "conflict",
        409,
      );
      return tx.create(
        "run",
        {
          request: c.request,
          status: "planning",
          attempt: 0,
          createdBy: actor.id,
        },
        "run.started",
      );
    });
    launch(run.id, () => plan(run.id));
    return run;
  }
  if (c.type === "run.approve") {
    assert(
      actor.type === "human",
      "Human plan approval required",
      "forbidden",
      403,
    );
    const run = await transaction(actor, key, c, async (tx) => {
      const r = await tx.get(c.runId, "run");
      assert(
        r.data.status === "awaiting_approval",
        "Run has no pending plan",
        "conflict",
        409,
      );
      return tx.update(
        r.id,
        { status: "running", approvedBy: actor.id, approvedPlan: r.data.plan },
        "run.plan.approved",
      );
    });
    if ((await store.get(run.id)).data.status === "running")
      launch(run.id, () => execute(run.id));
    return run;
  }
  if (c.type === "run.stop") {
    assert(
      actor.type === "human" || actor.type === "external",
      "Human or requesting external actor required",
      "forbidden",
      403,
    );
    const run = await store.get(c.runId);
    assert(
      actor.type === "human" || run.data.createdBy === actor.id,
      "Not your run",
      "forbidden",
      403,
    );
    controllers.get(c.runId)?.abort();
    return transaction(actor, key, c, async (tx) => {
      const r = await tx.get(c.runId, "run");
      assert(
        !["completed", "cancelled"].includes(r.data.status),
        "Run is terminal",
        "conflict",
        409,
      );
      for (const t of (await tx.list("task")).filter(
        (t) =>
          t.data.runId === r.id &&
          !["completed", "cancelled"].includes(t.data.status),
      ))
        await tx.update(t.id, { status: "cancelled" }, "task.cancelled");
      return tx.update(r.id, { status: "cancelled" }, "run.cancelled");
    });
  }
  if (c.type === "run.retry") {
    assert(actor.type === "human", "Human retry required", "forbidden", 403);
    const checks = await runtime.preflight({ sandbox: true });
    assert(
      Object.values(checks).every((x) => x.ok),
      Object.values(checks)
        .filter((x) => !x.ok)
        .map((x) => x.detail)
        .join(" "),
      "prerequisite",
      503,
    );
    const run = await transaction(actor, key, c, async (tx) => {
      const r = await tx.get(c.runId, "run");
      assert(
        ["failed", "blocked"].includes(r.data.status),
        "Only blocked or failed runs can retry",
        "conflict",
        409,
      );
      for (const t of (await tx.list("task")).filter(
        (t) =>
          t.data.runId === r.id &&
          ["failed", "blocked", "working", "claimed", "cancelled"].includes(
            t.data.status,
          ),
      ))
        await tx.update(t.id, { status: "pending" }, "task.retried");
      return tx.update(
        r.id,
        { status: r.data.approvedPlan ? "running" : "planning", error: null },
        "run.retried",
      );
    });
    if (["running", "planning"].includes((await store.get(run.id)).data.status))
      launch(run.id, () =>
        run.data.approvedPlan ? execute(run.id) : plan(run.id),
      );
    return run;
  }
  if (c.type === "run.merge") {
    assert(
      actor.type === "human",
      "Human merge approval required",
      "forbidden",
      403,
    );
    return transaction(actor, key, c, async (tx) => {
      const run = await tx.get(c.runId, "run"),
        reviews = (await tx.list("review")).filter(
          (r) => r.data.runId === run.id,
        );
      const targetHead = await git.git(
        git.repoPath(run.id),
        "rev-parse",
        "main",
      );
      // Recover a crash after Git CAS succeeds but before the SQL commit.
      mergeable(
        run,
        reviews.at(-1),
        targetHead === run.data.candidateSha ? run.data.baseSha : targetHead,
      );
      assert(
        (await tx.list("task"))
          .filter((t) => t.data.runId === run.id)
          .every((t) => t.data.status === "completed"),
        "Tasks incomplete",
        "conflict",
        409,
      );
      if (targetHead !== run.data.candidateSha)
        await git.git(
          git.repoPath(run.id),
          "update-ref",
          "refs/heads/main",
          run.data.candidateSha,
          run.data.baseSha,
        );
      await git.git(git.repoPath(run.id), "reset", "--hard", "main");
      return tx.update(
        run.id,
        {
          status: "completed",
          mergedSha: run.data.candidateSha,
          mergedBy: actor.id,
        },
        "change.merged",
      );
    });
  }
  if (c.type === "change.propose") {
    assert(
      actor.taskId === c.taskId || actor.type === "system",
      "Task scope mismatch",
      "forbidden",
      403,
    );
    return propose(actor, c.taskId, key);
  }
  return store.basicCommand(actor, key, c);
}
function launchJob(
  id: string,
  fn: () => Promise<void>,
  onError?: (error: any) => Promise<void>,
) {
  if (jobs.has(id)) return;
  jobs.add(id);
  controllers.set(id, new AbortController());
  void fn()
    .catch(async (e) => {
      controllers.get(id)?.abort();
      if (onError) await onError(e);
    })
    .finally(() => {
      jobs.delete(id);
      controllers.delete(id);
    });
}
function launch(id: string, fn: () => Promise<void>) {
  launchJob(id, fn, async (e) => {
    const run = await store.get(id).catch(() => null);
    if (run && !["cancelled", "blocked"].includes(run.data.status))
      await store.update(
        id,
        { status: "failed", error: String(e.message || e) },
        "run.failed",
      );
  });
}
async function invoke(
  runId: string,
  agent: Entity,
  prompt: string,
  taskId?: string,
  schema?: object,
) {
  const actor: Actor = {
    id: agent.id,
    type: "agent",
    projectId: agent.projectId,
    permissions: agent.data.permissions,
    runId,
    taskId,
  };
  const token = await store.issue(actor, 1);
  const runSignal =
    controllers.get(runId)?.signal || new AbortController().signal;
  const signal = AbortSignal.any([
    runSignal,
    AbortSignal.timeout(Number(process.env.COLAG_TASK_TIMEOUT_MS || 900000)),
  ]);
  await store.update(
    agent.id,
    { status: "working", currentTaskId: taskId },
    "agent.status.changed",
  );
  await store.pulse(agent.id, "working", taskId);
  const heartbeat = setInterval(
    () => void store.pulse(agent.id, "working", taskId),
    10000,
  );
  try {
    return await runtime.runClaude({
      sessionId: randomUUID(),
      prompt: `You are ${agent.data.name}, the ${agent.data.role} agent in Colag. Use only Colag MCP tools. Work within assigned task scope. Do not alter tests or package dependencies. Record significant decisions with create_decision. Publish concrete artifacts. The sample is disposable.\n${prompt}`,
      token,
      signal,
      schema,
      onOutput: (line) => {
        if (line.type === "assistant") {
          void store.pulse(agent.id, "working", taskId);
          const text = assistantText(line).slice(0, 500);
          if (text)
            void transaction(
              store.systemActor(agent.projectId),
              randomUUID(),
              { text },
              async (tx) => {
                await tx.emit("agent.activity", agent.id, { text, taskId });
                return { ok: true };
              },
            ).catch(() => {});
        }
      },
    });
  } finally {
    clearInterval(heartbeat);
    await pool.query(
      "DELETE FROM credentials WHERE actor->>'runId'=$1 AND actor->>'id'=$2 AND hash=$3",
      [
        runId,
        agent.id,
        (await import("../../../packages/database/src.ts")).hash(token),
      ],
    );
    await store.update(
      agent.id,
      { status: "idle", currentTaskId: null },
      "agent.status.changed",
    );
    await store.pulse(agent.id, "idle");
  }
}
function assistantText(line: any) {
  const content = line.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join(" ");
  return "";
}
export function boardPrompt(board: string) {
  return `The members submitted their collaborative design board. Append a product analysis to that same board with write_document. write_document only appends. Do not replace, delete, or rewrite what people already wrote.

Board:
${board}

Write for a stranger who was not in the session. They must be able to understand the product without asking anyone who attended. Use only what the board supports. Do not invent features, screens, or a finished analysis if the board does not support them.

Append all of the following:
1. General analysis. Say what the app is, then what every feature does, large and small.
2. Page map. Name the screens and how a person moves between them. Draw the map as Mermaid in a mermaid fence.
3. Algorithms. For each process, give steps a person can read, inside an algorithm fence.
4. One BPMN-style diagram per feature. For each feature, add a heading with the feature name and a mermaid fence: stadium nodes for start and end, rectangles for tasks, and diamonds for gateways.

Fences must look like this:
\`\`\`mermaid
flowchart TD
  Start([Start]) --> Task[Do the work]
\`\`\`
\`\`\`algorithm
1. First step
2. Next step
\`\`\`

Do not approve a plan. Do not merge. If you cannot produce the analysis, stop without writing a substitute.`;
}
function analysisReady(text: string) {
  return (
    /general analysis/i.test(text) &&
    /```mermaid/.test(text) &&
    /```algorithm/.test(text)
  );
}
async function settleBoard(
  runId: string,
  status: "blocked" | "completed",
  error?: string,
) {
  const run = await store.get(runId);
  await transaction(
    store.systemActor(run.projectId),
    randomUUID(),
    { runId, status, error },
    async (tx) => {
      const current = await tx.get(runId, "run");
      if (
        current.data.status !== "running" &&
        current.data.status !== "planning"
      )
        return { ok: false };
      await tx.update(
        runId,
        status === "blocked"
          ? { status, error: error || "Blocked" }
          : { status },
        status === "blocked" ? "run.blocked" : "board.analyzed",
      );
      return { ok: true };
    },
  );
}
async function submitBoard(
  actor: Actor,
  key: string,
  c: Extract<Command, { type: "board.submit" }>,
) {
  assert(
    actor.type === "human",
    "A room member submits the board",
    "forbidden",
    403,
  );
  const board = (await readDocument(actor.projectId)).trim();
  assert(board, "Write on the board before submitting");
  let created = false;
  const recorded = await transaction(actor, key, c, async (tx) => {
    created = true;
    const busy = (await tx.list("run")).find(
      (run) =>
        run.data.purpose === "board" &&
        (run.data.status === "running" || run.data.status === "planning"),
    );
    assert(!busy, "Atlas is already reading the board", "conflict", 409);
    const atlas = (await tx.list("agent")).find(
      (agent) => agent.data.role === "Coordinator",
    );
    assert(atlas, "Atlas is not in this room", "not_found", 404);
    const run = await tx.create(
      "run",
      {
        request: "Design board",
        purpose: "board",
        status: "running",
        attempt: 0,
        createdBy: actor.id,
        command: "Submit the design board",
      },
      "board.submitted",
    );
    return { runId: run.id, accepted: true };
  });
  if (!created) return recorded;
  launchJob(
    recorded.runId,
    () => analyzeBoard(recorded.runId),
    async (error) => {
      await settleBoard(
        recorded.runId,
        "blocked",
        String(error?.message || error),
      );
    },
  );
  return recorded;
}
async function analyzeBoard(runId: string) {
  const run = await store.get(runId);
  const before = await readDocument(run.projectId);
  const atlas = (await store.resources(run.projectId)).find(
    (agent) => agent.kind === "agent" && agent.data.role === "Coordinator",
  );
  assert(atlas, "Atlas is not in this room", "not_found", 404);
  let output: unknown;
  try {
    output = await invoke(runId, atlas, boardPrompt(before));
  } catch (error: any) {
    await settleBoard(runId, "blocked", String(error?.message || error));
    return;
  }
  if ((await store.get(runId)).data.status !== "running") return;
  const produced = typeof output === "string" ? output.trim() : "";
  const after = await readDocument(run.projectId);
  const marker = produced.match(/```mermaid[\s\S]{0,80}/)?.[0] || produced.slice(0, 80);
  if (analysisReady(produced) && marker && !after.includes(marker)) {
    await writeDocument(run.projectId, produced, AGENT_DOCUMENT_APPEND, {
      key: `board:${runId}`,
      actor: {
        id: atlas.id,
        type: "agent",
        projectId: run.projectId,
        permissions: atlas.data.permissions || [],
        runId,
      },
    });
  } else if (after.trim() === before.trim()) {
    await settleBoard(
      runId,
      "blocked",
      produced
        ? `Claude returned no analysis: ${produced.slice(0, 500)}`
        : "Claude returned no analysis",
    );
    return;
  }
  await settleBoard(runId, "completed");
}
async function promptAgent(
  actor: Actor,
  key: string,
  c: Extract<Command, { type: "agent.prompt" }>,
) {
  assert(
    actor.type === "human",
    "A room member commands the hosted agent",
    "forbidden",
    403,
  );
  const agent = await store.get(c.agentId);
  assert(
    agent.kind === "agent" && agent.projectId === actor.projectId,
    "Agent not in this room",
    "not_found",
    404,
  );
  let created = false;
  const recorded = await transaction(actor, key, c, async (tx) => {
    created = true;
    await tx.emit("agent.prompted", agent.id, {
      command: c.command,
      agentId: agent.id,
      name: agent.data.name,
      role: agent.data.role,
    });
    await tx.update(agent.id, { prompted: true }, "agent.engaged");
    return { agentId: agent.id, accepted: true };
  });
  if (!created) return recorded;
  const runs = (await store.resources(actor.projectId)).filter(
    (r) => r.kind === "run",
  );
  const active = runs.find(
    (r) => r.data.purpose !== "board" && isActiveRunStatus(r.data.status),
  );
  if (agent.data.role === "Coordinator") {
    if (!active) {
      const run = await transaction(
        actor,
        `${key}:run`,
        { type: "run.start", request: c.command },
        async (tx) =>
          tx.create(
            "run",
            {
              request: c.command,
              status: "planning",
              attempt: 0,
              createdBy: actor.id,
            },
            "run.started",
          ),
      );
      launch(run.id, () => plan(run.id));
    } else if (active.data.status === "planning") {
      await store.update(active.id, { request: c.command }, "run.prompt.updated");
      if (!jobs.has(active.id)) launch(active.id, () => plan(active.id));
    } else if (active.data.status === "awaiting_approval") {
      await store.update(active.id, { request: c.command }, "run.prompt.updated");
      const current = await store.get(agent.id);
      launchJob(`prompt:${agent.id}`, () =>
        invoke(
          active.id,
          current,
          `The member asked: ${c.command}\nRevise the shared plan with write_document if it helps. Do not approve the plan and do not merge.`,
        ),
      );
    } else {
      const current = await store.get(agent.id);
      launchJob(`prompt:${agent.id}`, () =>
        invoke(
          active.id,
          current,
          `The member asked: ${c.command}\nUpdate the shared plan with write_document if it helps. Do not approve the plan and do not merge.`,
        ),
      );
    }
    return recorded;
  }
  assert(
    active && active.data.status === "running",
    "Approve the plan before this agent starts work",
    "conflict",
    409,
  );
  assert(!jobs.has(active.id), "This room is already working", "conflict", 409);
  launch(active.id, () => promptSpecialist(active.id, agent.id, c.command));
  return recorded;
}
async function plan(runId: string) {
  const run = await store.get(runId);
  const projectId = run.projectId;
  const repo = run.data.baseSha
    ? { baseSha: run.data.baseSha }
    : await git.createRepository(runId);
  await store.update(runId, repo, "run.repository.ready");
  const agents = (await store.resources(projectId)).filter(
    (r) => r.kind === "agent",
  );
  const coordinator = agents.find((a) => a.data.role === "Coordinator")!;
  const output = await invoke(
    runId,
    coordinator,
    `Create a plan for this request: ${run.data.request}. Return the JSON schema. Make an Architect task first, then Backend and Frontend tasks depending on it. Do not create tasks through tools yet. Backend scope: backend/auth.mjs. Frontend scope: frontend/App.jsx. Architect scope: architecture.md. The fixed backend contract is register(email,password), login(email,password), authenticate(token), logout(token). Backend uses node:crypto only. QA and integration are managed by Colag. Keep the plan short, achievable and do not promise production authentication.`,
    undefined,
    planSchema,
  );
  if (controllers.get(runId)?.signal.aborted) return;
  const p: Plan = typeof output === "string" ? JSON.parse(output) : output;
  assert(p.tasks?.length && p.document, "Invalid coordinator plan");
  assert(
    new Set(p.tasks.map((t) => t.key)).size === p.tasks.length,
    "Duplicate task keys",
  );
  const ids = new Map(p.tasks.map((t) => [t.key, randomUUID()]));
  await transaction(store.systemActor(projectId), randomUUID(), p, async (tx) => {
    for (const task of p.tasks) {
      assert(
        ["Architect", "Backend", "Frontend"].includes(task.role),
        "Invalid plan role",
      );
      assert(
        task.dependencies.every((d) => ids.has(d)),
        "Unknown plan dependency",
      );
      await tx.create(
        "task",
        {
          title: task.title,
          description: task.description,
          role: task.role,
          dependencies: task.dependencies.map((d) => ids.get(d)),
          relatedFiles:
            task.role === "Backend"
              ? ["backend/auth.mjs"]
              : task.role === "Frontend"
                ? ["frontend/App.jsx"]
                : ["architecture.md"],
          runId,
          status: "pending",
          createdBy: coordinator.id,
        },
        "task.created",
        ids.get(task.key),
      );
    }
    const tasks = (await tx.list("task")).filter((t) => t.data.runId === runId);
    const { validateDependencies } =
      await import("../../../packages/domain/src/index.ts");
    for (const t of tasks)
      validateDependencies(tasks, t.id, t.data.dependencies, runId);
    await tx.update(
      runId,
      { status: "awaiting_approval", plan: p },
      "run.plan.proposed",
    );
    return { ok: true };
  });
  await writeDocument(projectId, p.document, AGENT_DOCUMENT_APPEND);
}
async function execute(runId: string) {
  let run = await store.get(runId);
  const projectId = run.projectId;
  const agents = (await store.resources(projectId)).filter(
    (r) => r.kind === "agent",
  );
  while (true) {
    if (controllers.get(runId)?.signal.aborted || (await store.get(runId)).data.status==='blocked') return;
    const tasks = (await store.resources(projectId)).filter(
      (t) => t.kind === "task" && t.data.runId === runId,
    );
    const pending = tasks.filter((t) => t.data.status === "pending");
    if (!pending.length) break;
    const ready = pending.filter((t) =>
      t.data.dependencies.every(
        (d: string) =>
          tasks.find((x) => x.id === d)?.data.status === "completed",
      ),
    );
    assert(ready.length, "No runnable tasks: dependency graph is blocked");
    const selected: Entity[] = [];
    for (const t of ready) {
      if (selected.length >= Number(process.env.COLAG_MAX_PARALLEL || 2)) break;
      if (!selected.some((x) => x.data.role === t.data.role)) selected.push(t);
    }
    const outcomes = await Promise.allSettled(
      selected.map((task) => {
        const agent = agents.find((a) => a.data.role === task.data.role);
        assert(agent, `No agent configured for ${task.data.role}`);
        return workOneTask(run, task, agent);
      }),
    );
    const failure = outcomes.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    run = await store.get(runId);
  }
  if (controllers.get(runId)?.signal.aborted) return;
  await assemble(runId);
}
async function promptSpecialist(
  runId: string,
  agentId: string,
  commandText: string,
) {
  const run = await store.get(runId);
  const agent = await store.get(agentId);
  const tasks = (await store.resources(run.projectId)).filter(
    (t) => t.kind === "task" && t.data.runId === runId,
  );
  const ready = tasks.filter(
    (t) =>
      t.data.status === "pending" &&
      t.data.role === agent.data.role &&
      (t.data.dependencies || []).every(
        (d: string) =>
          tasks.find((x) => x.id === d)?.data.status === "completed",
      ),
  );
  assert(ready[0], "No task is ready for this agent", "conflict", 409);
  await workOneTask(run, ready[0], agent, commandText);
  const after = (await store.resources(run.projectId)).filter(
    (t) => t.kind === "task" && t.data.runId === runId,
  );
  if (
    after.every((t) => t.data.status === "completed") &&
    !controllers.get(runId)?.signal.aborted &&
    (await store.get(runId)).data.status === "running"
  )
    await assemble(runId);
}
async function workOneTask(
  run: Entity,
  task: Entity,
  agent: Entity,
  instruction?: string,
) {
  const actor: Actor = {
    id: agent.id,
    type: "agent",
    projectId: run.projectId,
    permissions: agent.data.permissions,
    runId: run.id,
    taskId: task.id,
  };
  await store.basicCommand(actor, randomUUID(), {
    type: "task.claim",
    taskId: task.id,
  });
  await store.basicCommand(actor, randomUUID(), {
    type: "task.update",
    taskId: task.id,
    status: "working",
  });
  if (task.data.conflict)
    await git.applyConflict(run.id, task.id, task.data.conflict);
  else
    await git.createWorktree(
      run.id,
      task.id,
      task.data.repairBase || run.data.baseSha,
    );
  try {
    const result = await invoke(
      run.id,
      agent,
      `Task: ${task.data.title}\n${task.data.description}\nAllowed files: ${task.data.relatedFiles.join(", ")}. Inspect shared decisions and document. Implement the task, then propose_change. Architect must write architecture.md and record the contract decision. Frontend must export App({api}) with accessible login and registration forms, state handling and no new dependencies. The supplied api prop has register(email,password), login(email,password), me(), logout(). The existing server and frontend/main.jsx connect these operations. Report honestly what was completed.${instruction ? `\nMember command: ${instruction}` : ""}`,
      task.id,
    );
    if (controllers.get(run.id)?.signal.aborted) return;
    const currentTask = await store.get(task.id);
    if (currentTask.data.status === "blocked") {
      await store.update(
        run.id,
        {
          status: "blocked",
          error:
            currentTask.data.reason || "An agent needs help before continuing.",
        },
        "run.blocked",
      );
      return;
    }
    if (currentTask.data.status === "pending") return;
    await propose(actor, task.id, randomUUID());
    await store.update(
      task.id,
      { status: "completed", result: String(result).slice(0, 10000) },
      "task.completed",
      actor,
    );
  } catch (e: any) {
    await store.update(
      task.id,
      {
        status: controllers.get(run.id)?.signal.aborted ? "cancelled" : "failed",
        error: e.message,
      },
      "task.failed",
      actor,
    );
    throw e;
  }
}
async function assemble(runId: string) {
  const run = await store.get(runId);
  const projectId = run.projectId;
  const agents = (await store.resources(projectId)).filter(
    (r) => r.kind === "agent",
  );
  const all = await store.resources(projectId);
  assert(
    all
      .filter((t) => t.kind === "task" && t.data.runId === runId)
      .every((t) => t.data.status === "completed"),
    "Some tasks have failed or are blocked",
  );
  const changes = all.filter(
    (c) => c.kind === "change" && c.data.runId === runId && !c.data.integration,
  );
  let candidate;
  const resolvedConflict = all
    .filter(
      (t) =>
        t.kind === "task" &&
        t.data.runId === runId &&
        t.data.conflict &&
        t.data.status === "completed",
    )
    .at(-1);
  const repairedTask = all
    .filter(
      (t) =>
        t.kind === "task" &&
        t.data.runId === runId &&
        t.data.repairBase &&
        t.data.status === "completed",
    )
    .at(-1);
  const repairedChange = changes.find(
    (c) => c.data.taskId === (repairedTask || resolvedConflict)?.id,
  );
  try {
    candidate = await git.integrate(
      runId,
      repairedChange
        ? resolvedConflict?.data.conflict.remainingShas || []
        : changes.map((c) => c.data.sha),
      repairedChange?.data.sha || run.data.baseSha,
    );
  } catch (e: any) {
    if (!(e instanceof git.IntegrationConflict)) throw e;
    await store.create(
      "task",
      {
        runId,
        conflict: e.details,
        title: "Resolve integration conflict",
        description: e.message,
        role: "Backend",
        dependencies: [],
        relatedFiles: [
          "backend/auth.mjs",
          "frontend/App.jsx",
          "architecture.md",
        ],
        status: "blocked",
        repair: true,
      },
      "task.blocked",
      store.systemActor(projectId),
    );
    await store.update(
      runId,
      { status: "blocked", error: e.message },
      "run.blocked",
    );
    return;
  }
  await reviewCandidate(runId, candidate.work, candidate.sha, agents);
}
async function reviewCandidate(
  runId: string,
  work: string,
  sha: string,
  agents: Entity[],
) {
  const projectId = (await store.get(runId)).projectId;
  const system = store.systemActor(projectId);
  await store.update(
    runId,
    {
      status: "reviewing",
      candidateSha: sha,
      testsPassed: false,
      testSha: null,
    },
    "change.testing",
  );
  const tests = await runtime.testSandbox(work, controllers.get(runId)?.signal);
  await store.create(
    "artifact",
    {
      runId,
      name: "Integration test results",
      artifactType: "test",
      content: tests.output,
      sha,
      passed: tests.passed,
      createdBy: "system",
    },
    "artifact.created",
    system,
  );
  await store.update(
    runId,
    { testSha: sha, testsPassed: tests.passed },
    "change.tested",
  );
  const change = await store.create(
    "change",
    {
      runId,
      agentId: "integration",
      sha,
      branch: "colag/integration",
      status: "review",
      integration: true,
    },
    "change.review.requested",
    system,
  );
  await store.update(
    runId,
    { candidateChangeId: change.id },
    "run.candidate.ready",
  );
  const qa = agents.find((a) => a.data.role === "QA")!;
  await invoke(
    runId,
    qa,
    `Review the integration candidate ${sha}. Use inspect_diff and run_tests. Inspect frontend and backend correctness. Submit exactly one review with submit_review. Tests must pass before approval. Publish useful findings. Do not edit files.`,
    undefined,
  );
  if (controllers.get(runId)?.signal.aborted) return;
  const reviews = (await store.resources(projectId)).filter(
    (r) => r.kind === "review" && r.data.changeId === change.id,
  );
  const approved = reviews.at(-1)?.data.status === "approved";
  if (tests.passed && approved) {
    await store.update(runId, { status: "awaiting_merge" }, "run.merge.ready");
    return;
  }
  const run = await store.get(runId);
  if ((run.data.attempt || 0) >= 2) {
    await store.update(
      runId,
      {
        status: "blocked",
        error: "Repair limit reached. Inspect the test results and review.",
      },
      "run.blocked",
    );
    return;
  }
  await store.update(
    runId,
    { attempt: (run.data.attempt || 0) + 1, status: "running" },
    "run.repair.started",
  );
  const repair = await store.create(
    "task",
    {
      runId,
      title: "Repair review findings",
      description: reviews.at(-1)?.data.comments || tests.output,
      role: "Backend",
      dependencies: [],
      relatedFiles: ["backend/auth.mjs", "frontend/App.jsx", "architecture.md"],
      status: "working",
      ownerAgentId: agents.find((a) => a.data.role === "Backend")!.id,
      repair: true,
      repairBase: sha,
    },
    "task.created",
    system,
  );
  await git.createWorktree(runId, repair.id, sha);
  const backend = agents.find((a) => a.data.role === "Backend")!;
  await invoke(
    runId,
    backend,
    `Repair this candidate based on tests and review: ${tests.output}\n${reviews.at(-1)?.data.comments || ""}. Keep existing test files unchanged. Propose the corrected change.`,
    repair.id,
  );
  const actor: Actor = {
    id: backend.id,
    type: "agent",
    projectId,
    permissions: backend.data.permissions,
    runId,
    taskId: repair.id,
  };
  const repaired = await propose(actor, repair.id, randomUUID());
  await store.update(repair.id, { status: "completed" }, "task.completed");
  await git.git(work, "merge", "--ff-only", repaired.data.sha);
  await reviewCandidate(runId, work, repaired.data.sha, agents);
}
export async function propose(actor: Actor, taskId: string, key: string) {
  const task = await store.get(taskId);
  const activeRun = await store.get(task.data.runId);
  assert(
    task.data.status === "working" && activeRun.data.status === "running",
    "Change proposals require an active working task",
    "conflict",
    409,
  );
  assert(
    task.data.runId === actor.runId || actor.type === "system",
    "Run scope mismatch",
    "forbidden",
    403,
  );
  assert(
    task.data.ownerAgentId === actor.id || actor.type === "system",
    "Task owner required",
    "forbidden",
    403,
  );
  return transaction(
    actor,
    key,
    { type: "change.propose", taskId },
    async (tx) => {
      const commit = await git.commitTask(task.data.runId, task.id);
      const old = (await tx.list("change")).find(
        (c) => c.data.taskId === task.id,
      );
      return old
        ? tx.update(
            old.id,
            { ...commit, status: "proposed" },
            "change.proposed",
          )
        : tx.create(
            "change",
            {
              ...commit,
              taskId,
              runId: task.data.runId,
              agentId: actor.id,
              status: "proposed",
            },
            "change.proposed",
          );
    },
  );
}
export async function tools(
  actor: Actor,
  name: string,
  args: any,
  key: string,
): Promise<any> {
  assert(
    !(
      actor.type === "external" &&
      ["run.approve", "run.merge", "submit_review"].includes(name)
    ),
    "Connected clients cannot approve or merge",
    "forbidden",
    403,
  );
  const all = await store.resources(actor.projectId);
  if (actor.type === "external" && !actor.taskId) {
    const owned = all.find(
      (t) =>
        t.kind === "task" &&
        t.data.ownerAgentId === actor.id &&
        ["claimed", "working"].includes(t.data.status),
    );
    if (owned) actor = { ...actor, taskId: owned.id, runId: owned.data.runId };
  }
  const task = actor.taskId
    ? all.find((x) => x.id === actor.taskId)
    : undefined;
  let run = actor.runId ? all.find((x) => x.id === actor.runId) : undefined;
  if (!run && actor.type === "external")
    run = [...all]
      .reverse()
      .find(
        (x) =>
          x.kind === "run" &&
          !["completed", "failed", "cancelled"].includes(x.data.status),
      );
  if (run && !actor.runId) actor = { ...actor, runId: run.id };
  if (name === "inspect_project") {
    authorize(actor, actor.projectId, "project.read");
    return store.snapshot(actor.projectId);
  }
  if (name === "read_document") {
    authorize(actor, actor.projectId, "project.read");
    return { text: await readDocument(actor.projectId) };
  }
  if (name === "write_document") {
    authorize(actor, actor.projectId, "document.write");
    if (actor.type === "agent")
      assert(
        (await store.get(actor.id)).data.capabilities?.some((c: string) =>
          ["planning", "architecture"].includes(c),
        ),
        "Planning agent required",
        "forbidden",
        403,
      );
    await writeDocument(actor.projectId, args.text, AGENT_DOCUMENT_APPEND, {
      key,
      actor,
    });
    return { ok: true };
  }
  if (name === "claim_task") {
    const claimed = await command(actor, key, {
      taskId: args.taskId,
      type: "task.claim",
    });
    if (actor.type !== "external") return claimed;
    return command(
      { ...actor, taskId: args.taskId, runId: claimed.data.runId },
      `${key}:working`,
      { taskId: args.taskId, status: "working", type: "task.update" },
    );
  }
  if(name==='update_task')return command(actor,key,{taskId:args.taskId,status:args.status,reason:args.reason,type:'task.update'});
  if (name === "create_decision")
    return command(actor, key, { ...args, type: "decision.create" });
  if (name === "create_task") {
    const runId =
      actor.runId ||
      all.find(
        (r) =>
          r.kind === "run" &&
          ["planning", "awaiting_approval"].includes(r.data.status),
      )?.id;
    assert(runId, "No plan is open for new tasks", "conflict", 409);
    return command({ ...actor, runId }, key, {
      type: "task.create",
      task: { ...args, runId },
    });
  }
  if (name === "delegate_task")
    return command(actor, key, { ...args, type: "task.delegate" });
  if (name === "publish_artifact")
    return command(actor, key, {
      ...args,
      type: "artifact.create",
      taskId: actor.taskId,
    });
  assert(run, "Run context required");
  assert(
    ["planning", "running", "reviewing"].includes(run.data.status),
    "Run is not active",
    "conflict",
    409,
  );
  if (name === "inspect_diff") {
    authorize(actor, actor.projectId, "workspace.read");
    assert(run.data.candidateSha, "No candidate yet");
    return git.diffFiles(run.id, run.data.baseSha, run.data.candidateSha);
  }
  if (name === "submit_review")
    return command(actor, key, {
      ...args,
      type: "review.create",
      changeId: run.data.candidateChangeId,
    });
  if (name === "delegate_external") {
    authorize(actor, actor.projectId, "task.delegate");
    const { delegateExternal } =
      await import("../../../packages/adapters/src/a2a.ts");
    return delegateExternal(actor, args.message);
  }
  const work = task
    ? git.workPath(run.id, task.id)
    : path.join(git.root, "runs", run.id, "integration");
  if (name === "list_files") {
    authorize(actor, actor.projectId, "workspace.read");
    return git.files(work);
  }
  if (name === "read_file") {
    authorize(actor, actor.projectId, "workspace.read");
    return { content: await git.readWorkspace(work, args.path) };
  }
  if (name === "write_file") {
    authorize(actor, actor.projectId, "workspace.write");
    assert(task && task.data.status === "working", "Active task required");
    assert(
      task.data.relatedFiles.includes(args.path),
      "File is not assigned to this task",
      "forbidden",
      403,
    );
    await transaction(
      actor,
      key,
      { tool: "write_file", path: args.path, content: args.content },
      async (tx) => {
        await git.writeWorkspace(work, args.path, args.content);
        await tx.emit("workspace.file.updated", task.id, {
          path: args.path,
          runId: run.id,
        });
        return { ok: true };
      },
    );
    return { ok: true };
  }
  if (name === "run_tests") {
    authorize(actor, actor.projectId, "test.execute");
    const result = await runtime.testSandbox(
      work,
      controllers.get(run.id)?.signal,
    );
    await store.create(
      "artifact",
      {
        runId: run.id,
        taskId: task?.id,
        name: "Task test results",
        content: result.output,
        passed: result.passed,
        createdBy: actor.id,
      },
      undefined,
      actor,
    );
    return result;
  }
  if (name === "propose_change") {
    assert(task, "Task required");
    return command(actor, key, { type: "change.propose", taskId: task.id });
  }
  throw new Error("Unknown tool");
}
export async function recover() {
  await pool.query("DELETE FROM credentials WHERE actor->>'type'='agent'");
  const projects = await pool.query(
    "SELECT id FROM resources WHERE kind='project'",
  );
  for (const project of projects.rows) await recoverProject(project.id);
}
async function recoverProject(projectId: string) {
  const all = await store.resources(projectId);
  for (const agent of all.filter(
    (r) => r.kind === "agent" && r.data.status !== "idle",
  ))
    await store.update(
      agent.id,
      { status: "idle", currentTaskId: null },
      "agent.status.changed",
    );
  for (const run of all.filter(
    (r) =>
      r.kind === "run" &&
      ["planning", "running", "reviewing"].includes(r.data.status),
  )) {
    for (const task of all.filter(
      (t) =>
        t.kind === "task" &&
        t.data.runId === run.id &&
        ["working", "claimed"].includes(t.data.status),
    ))
      await store.update(
        task.id,
        {
          status: "blocked",
          reason: "Runtime interrupted; retry resumes this workspace.",
        },
        "task.blocked",
      );
    await store.update(
      run.id,
      {
        status: "blocked",
        error:
          "Service restarted during execution. Preserved workspaces are available; retry after checking local services.",
      },
      "run.interrupted",
    );
  }
}

export async function shutdown() {
  for (const controller of controllers.values()) controller.abort();
  await pool.query("DELETE FROM credentials WHERE actor->>'type'='agent'");
}
