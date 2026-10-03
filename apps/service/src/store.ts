import { randomUUID, randomBytes } from "node:crypto";
import { createClient } from "redis";
import {
  pool,
  entity,
  event,
  transaction,
  hash,
  Tx,
} from "../../../packages/database/src.ts";
import {
  authorize,
  assert,
  transition,
  canClaim,
  validateDependencies,
} from "../../../packages/domain/src/index.ts";
import {
  DEFAULT_AGENTS,
  type Actor,
  type Command,
  type Entity,
} from "../../../packages/protocol/src/index.ts";
export const AGENT_PERMISSIONS = [
  "project.read",
  "task.create",
  "task.claim",
  "task.update",
  "task.delegate",
  "decision.create",
  "artifact.create",
  "document.write",
  "workspace.read",
  "workspace.write",
  "change.propose",
  "review.create",
  "test.execute",
];
export function systemActor(projectId: string): Actor {
  return { id: "system", type: "system", projectId, permissions: ["*"] };
}
export const redis = createClient({
  url: process.env.REDIS_URL || "redis://127.0.0.1:63799",
  socket: { connectTimeout: 2000, reconnectStrategy: () => 2000 },
});
redis.on("error", () => {});
export async function issue(actor: Actor, hours = 24) {
  const token = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO credentials(hash,actor,expires_at) VALUES($1,$2,now()+($3::text||' hours')::interval)",
    [hash(token), actor, hours],
  );
  return token;
}
export async function authenticate(token: string) {
  const r = await pool.query(
    "SELECT actor FROM credentials WHERE hash=$1 AND (expires_at IS NULL OR expires_at>now())",
    [hash(token)],
  );
  assert(r.rows[0], "Invalid or expired credential", "unauthorized", 401);
  return r.rows[0].actor as Actor;
}
export async function provisionRoom(
  ownerId: string,
  name: string,
  purpose = "room",
) {
  const roomId = randomUUID();
  const system = systemActor(roomId);
  await transaction(system, `provision-${roomId}`, { name }, async (tx) => {
    await tx.create(
      "project",
      {
        name,
        description:
          purpose === "app" ? "A shared design board" : "A shared room",
        ownerId,
        purpose,
      },
      "project.created",
      roomId,
    );
    await tx.create(
      "document",
      { title: "Shared plan" },
      "document.created",
      `document-${roomId}`,
    );
    for (const a of DEFAULT_AGENTS)
      await tx.create(
        "agent",
        { ...a, status: "idle", permissions: AGENT_PERMISSIONS },
        "agent.joined",
        `agent-${a.role.toLowerCase()}-${roomId}`,
      );
    return { ok: true };
  });
  await pool.query(
    "INSERT INTO memberships(room_id,user_id,role) VALUES($1,$2,'owner')",
    [roomId, ownerId],
  );
  return { id: roomId, name };
}
export async function resources(projectId: string) {
  return (
    await pool.query(
      "SELECT * FROM resources WHERE project_id=$1 ORDER BY created_at",
      [projectId],
    )
  ).rows.map(entity);
}
export async function get(id: string) {
  const r = await pool.query("SELECT * FROM resources WHERE id=$1", [id]);
  assert(r.rows[0], "Resource not found", "not_found", 404);
  return entity(r.rows[0]);
}
export async function events(after = 0, projectId: string, limit = 500) {
  return (
    await pool.query(
      "SELECT * FROM events WHERE project_id=$1 AND seq>$2 ORDER BY seq LIMIT $3",
      [projectId, after, limit],
    )
  ).rows.map(event);
}
export async function snapshot(projectId: string) {
  const all = await resources(projectId);
  const ev = (
    await pool.query(
      "SELECT * FROM (SELECT * FROM events WHERE project_id=$1 ORDER BY seq DESC LIMIT 80) e ORDER BY seq",
      [projectId],
    )
  ).rows.map(event);
  const presence: Record<string, any> = {};
  if (redis.isReady)
    for (const a of all.filter((r) => r.kind === "agent")) {
      const p = await redis.get(`presence:${a.id}`);
      if (p) presence[a.id] = JSON.parse(p);
    }
  const connections = await pool.query(
    `SELECT c.id, c.name, u.display_name, c.last_seen_at FROM mcp_connections c
     JOIN users u ON u.id=c.user_id WHERE c.room_id=$1 AND c.revoked_at IS NULL`,
    [projectId],
  );
  for (const c of connections.rows) {
    const live =
      c.last_seen_at &&
      Date.now() - new Date(c.last_seen_at).getTime() < 45000;
    presence[`mcp:${c.id}`] = {
      status: live ? "live" : "idle",
      label: `${c.display_name} · ${c.name}`,
    };
    if (redis.isReady) {
      const p = await redis.get(`presence:mcp:${c.id}`);
      if (p) presence[`mcp:${c.id}`] = { ...JSON.parse(p), status: "live" };
    }
  }
  return {
    project: all.find((r) => r.kind === "project"),
    resources: all.filter((r) => r.kind !== "project"),
    events: ev,
    presence,
    lastSeq: ev.at(-1)?.seq || 0,
  };
}
export async function update(
  id: string,
  data: Record<string, any>,
  type: string,
  actor?: Actor,
) {
  const existing = await get(id);
  if (actor?.projectId)
    assert(
      actor.projectId === existing.projectId || actor.type === "system",
      "Project mismatch",
      "forbidden",
      403,
    );
  if (actor?.type === "human")
    assert(
      actor.rooms?.includes(existing.projectId),
      "Project membership required",
      "forbidden",
      403,
    );
  const scoped: Actor = actor
    ? { ...actor, projectId: existing.projectId }
    : systemActor(existing.projectId);
  return transaction(scoped, randomUUID(), { id, data, type }, (tx) =>
    tx.update(id, data, type),
  );
}
export async function create(
  kind: Entity["kind"],
  data: Record<string, any>,
  type?: string,
  actor?: Actor,
) {
  assert(actor?.projectId, "Project scope required");
  return transaction(actor, randomUUID(), data, (tx) =>
    tx.create(kind, data, type),
  );
}
export async function pulse(agentId: string, status: string, taskId?: string) {
  if (redis.isReady)
    await redis.set(
      `presence:${agentId}`,
      JSON.stringify({ status, taskId, at: new Date().toISOString() }),
      { EX: 40 },
    );
}
export async function basicCommand(actor: Actor, key: string, c: Command) {
  const result = await transaction(actor, key, c, async (tx) => {
    authorize(actor, actor.projectId, c.type);
    switch (c.type) {
      case "agent.register":
        assert(
          actor.type === "human",
          "Only a human can register agents",
          "forbidden",
          403,
        );
        return tx.create(
          "agent",
          {
            name: c.name,
            role: c.role,
            capabilities: c.capabilities,
            permissions: c.permissions || [],
            status: "idle",
          },
          "agent.joined",
        );
      case "task.create": {
        assert(
          c.task.title?.trim() && c.task.description && c.task.role,
          "Task title, description and role required",
        );
        const run = await tx.get(c.task.runId, "run");
        assert(
          actor.type === "human" ||
            actor.type === "system" ||
            actor.type === "external" ||
            actor.runId === run.id,
          "Run scope mismatch",
          "forbidden",
          403,
        );
        assert(
          ["planning", "awaiting_approval"].includes(run.data.status),
          "Add tasks before approving the plan",
          "conflict",
          409,
        );
        const id = randomUUID();
        validateDependencies(
          await tx.list("task"),
          id,
          c.task.dependencies,
          c.task.runId,
        );
        return tx.create(
          "task",
          { ...c.task, status: "pending", createdBy: actor.id },
          "task.created",
          id,
        );
      }
      case "task.claim": {
        const task = await tx.get(c.taskId, "task");
        assert(
          actor.type === "agent" || actor.type === "external",
          "Only agents can claim tasks",
          "forbidden",
          403,
        );
        assert(
          !actor.taskId || actor.taskId === task.id,
          "Task scope mismatch",
          "forbidden",
          403,
        );
        canClaim(
          task,
          await tx.list("task"),
          await tx.get(task.data.runId, "run"),
        );
        if (actor.type === "agent") {
          const agent = await tx.get(actor.id, "agent");
          assert(
            agent.data.role === task.data.role,
            "Agent role does not match task",
            "forbidden",
            403,
          );
        }
        return tx.update(
          task.id,
          { status: "claimed", ownerAgentId: actor.id },
          "task.claimed",
        );
      }
      case "task.update": {
        const task = await tx.get(c.taskId, "task");
        assert(
          actor.type === "human" ||
            actor.type === "system" ||
            task.data.ownerAgentId === actor.id,
          "Only owner can update task",
          "forbidden",
          403,
        );
        assert(
          !actor.taskId || actor.taskId === task.id,
          "Task scope mismatch",
          "forbidden",
          403,
        );
        transition(task.data.status, c.status);
        return tx.update(
          task.id,
          { status: c.status, reason: c.reason },
          `task.${c.status}`,
          c.version,
        );
      }
      case "task.delegate": {
        const task = await tx.get(c.taskId, "task");
        assert(
          (task.data.ownerAgentId === actor.id &&
            (!actor.taskId || actor.taskId === task.id)) ||
            actor.type === "human",
          "Only owner can delegate",
          "forbidden",
          403,
        );
        assert(
          ["pending", "claimed", "blocked"].includes(task.data.status),
          "Pause active work before delegation",
          "conflict",
          409,
        );
        const target = await tx.get(c.targetAgentId, "agent");
        await tx.create(
          "delegation",
          { taskId: task.id, from: actor.id, to: target.id, reason: c.reason },
          "task.delegated",
        );
        return tx.update(
          task.id,
          {
            ownerAgentId: undefined,
            role: target.data.role,
            status: "pending",
          },
          "task.assignment.changed",
        );
      }
      case "decision.create":
        assert(
          c.title?.trim() && c.description,
          "Decision title and description required",
        );
        return tx.create(
          "decision",
          {
            title: c.title,
            description: c.description,
            affectedTasks: c.affectedTasks || [],
            status: "proposed",
            proposedBy: actor.id,
            runId: actor.runId,
          },
          "decision.proposed",
        );
      case "decision.update":
        assert(
          actor.type === "human" || actor.type === "system",
          "Human approval required",
          "forbidden",
          403,
        );
        await tx.get(c.decisionId, "decision");
        return tx.update(
          c.decisionId,
          { status: c.status },
          `decision.${c.status}`,
        );
      case "artifact.create":
        assert(
          c.name &&
            typeof c.content === "string" &&
            c.content.length < 2_000_000,
          "Invalid artifact",
        );
        return tx.create(
          "artifact",
          { ...c, createdBy: actor.id, runId: actor.runId },
          "artifact.created",
        );
      case "review.create": {
        const change = await tx.get(c.changeId, "change");
        const run = await tx.get(change.data.runId, "run");
        assert(
          actor.type === "human" ||
            actor.type === "system" ||
            actor.runId === run.id,
          "Review run scope mismatch",
          "forbidden",
          403,
        );
        assert(
          run.data.status === "reviewing" &&
            run.data.candidateChangeId === change.id,
          "Only the active candidate can be reviewed",
          "conflict",
          409,
        );
        assert(
          change.data.agentId !== actor.id,
          "Author cannot approve own change",
          "forbidden",
          403,
        );
        assert(
          actor.type === "human" ||
            actor.type === "system" ||
            (await tx.get(actor.id, "agent")).data.capabilities?.includes(
              "code-review",
            ),
          "Reviewer role required",
          "forbidden",
          403,
        );
        return tx.create(
          "review",
          {
            changeId: change.id,
            runId: change.data.runId,
            sha: change.data.sha,
            reviewerAgentId: actor.id,
            status: c.status,
            comments: c.comments,
          },
          "change.reviewed",
        );
      }
      case "lock.acquire": {
        assert(c.ttlMs > 0 && c.ttlMs <= 900000, "Lease must be 1–900000 ms");
        const existing = (await tx.list("lock")).find(
          (l) =>
            l.data.resource === c.resource &&
            !l.data.released &&
            Date.parse(l.data.expiresAt) > Date.now(),
        );
        assert(!existing, "Resource is locked", "conflict", 409);
        return tx.create(
          "lock",
          {
            resource: c.resource,
            owner: actor.id,
            expiresAt: new Date(Date.now() + c.ttlMs).toISOString(),
            reason: c.reason,
            fencingToken: randomUUID(),
          },
          "lock.acquired",
        );
      }
      case "lock.release": {
        const lock = await tx.get(c.lockId, "lock");
        assert(
          lock.data.owner === actor.id || actor.type === "human",
          "Lock owner required",
          "forbidden",
          403,
        );
        return tx.update(lock.id, { released: true }, "lock.released");
      }
      default:
        throw new Error("Unsupported domain command: " + c.type);
    }
  });
  if (redis.isReady && result && c.type === "lock.acquire")
    await redis.set(`lease:${result.id}`, JSON.stringify(result.data), {
      PX: c.ttlMs,
    });
  if (redis.isReady && c.type === "lock.release")
    await redis.del(`lease:${c.lockId}`);
  return result;
}
export async function expireLeases() {
  const projects = await pool.query(
    "SELECT id FROM resources WHERE kind='project'",
  );
  for (const project of projects.rows) {
    const system = systemActor(project.id);
    await transaction(system, randomUUID(), {}, async (tx) => {
      for (const lock of (await tx.list("lock")).filter(
        (l) =>
          !l.data.released &&
          !l.data.expired &&
          Date.parse(l.data.expiresAt) <= Date.now(),
      ))
        await tx.update(lock.id, { expired: true }, "lock.expired");
      return { ok: true };
    });
  }
}
