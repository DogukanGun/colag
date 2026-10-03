import express from "express";
import { randomUUID } from "node:crypto";
import { AgentCard, Task, Message, Role, TaskState } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  AgentEvent,
  type TaskStore,
  type AgentExecutor,
  type ServerCallContext,
} from "@a2a-js/sdk/server";
import { agentCardHandler, jsonRpcHandler } from "@a2a-js/sdk/server/express";
import { ClientFactory } from "@a2a-js/sdk/client";
import * as store from "../../../apps/service/src/store.ts";
import { command } from "../../../apps/service/src/engine.ts";
import { pool } from "../../database/src.ts";
import type { Actor } from "../../protocol/src/index.ts";
export function card(url: string, name = "Colag coordinator") {
  return AgentCard.fromJSON({
    name,
    description:
      "Plan, implement and review software changes with human approval.",
    version: "0.1.0",
    supportedInterfaces: [
      { url: `${url}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    capabilities: { streaming: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "software-engineering",
        name: "Collaborative engineering",
        description: "Create a shared plan and reviewed Git changes",
        tags: ["planning", "coding", "review"],
        examples: ["Build authentication"],
      },
    ],
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: "bearer" } },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
  });
}
const actorFor = (ctx: ServerCallContext) =>
  JSON.parse(ctx.user!.userName) as Actor;
const states: Record<string, TaskState> = {
  planning: TaskState.TASK_STATE_WORKING,
  awaiting_approval: TaskState.TASK_STATE_INPUT_REQUIRED,
  running: TaskState.TASK_STATE_WORKING,
  reviewing: TaskState.TASK_STATE_WORKING,
  awaiting_merge: TaskState.TASK_STATE_INPUT_REQUIRED,
  blocked: TaskState.TASK_STATE_INPUT_REQUIRED,
  failed: TaskState.TASK_STATE_FAILED,
  cancelled: TaskState.TASK_STATE_CANCELED,
  completed: TaskState.TASK_STATE_COMPLETED,
};
class PersistentTasks implements TaskStore {
  async save(task: Task, ctx: ServerCallContext) {
    const actor = actorFor(ctx);
    await pool.query(
      "INSERT INTO a2a_tasks(id,owner,task) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET task=$3 WHERE a2a_tasks.owner=$2",
      [task.id, actor.id, Task.toJSON(task)],
    );
  }
  async load(id: string, ctx: ServerCallContext) {
    const actor = actorFor(ctx);
    const r = await pool.query(
      "SELECT task FROM a2a_tasks WHERE id=$1 AND owner=$2",
      [id, actor.id],
    );
    if (!r.rows[0]) return;
    const task = Task.fromJSON(r.rows[0].task);
    if (task.metadata?.runId) {
      const run = await store.get(task.metadata.runId);
      task.status = {
        state: states[run.data.status],
        timestamp: run.updatedAt,
        message: undefined,
      };
      task.artifacts = (await store.resources(run.projectId))
        .filter((x) => x.kind === "artifact" && x.data.runId === run.id)
        .map((a) => ({
          artifactId: a.id,
          name: a.data.name,
          description: "",
          parts: [
            {
              content: { $case: "text", value: String(a.data.content) },
              metadata: undefined,
              filename: "",
              mediaType: "text/plain",
            },
          ],
          metadata: undefined,
          extensions: [],
        }));
    }
    return task;
  }
  async list(params: any, ctx: ServerCallContext) {
    const actor = actorFor(ctx);
    const r = await pool.query(
      "SELECT id FROM a2a_tasks WHERE owner=$1 ORDER BY id",
      [actor.id],
    );
    const tasks = (
      await Promise.all(r.rows.map((x) => this.load(x.id, ctx)))
    ).filter(Boolean) as Task[];
    const offset = Number(params.pageToken || 0),
      size = Math.min(params.pageSize || 50, 100);
    return {
      tasks: tasks.slice(offset, offset + size),
      pageSize: size,
      totalSize: tasks.length,
      nextPageToken: offset + size < tasks.length ? String(offset + size) : "",
    };
  }
}
export async function startA2A() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS a2a_tasks(id text PRIMARY KEY,owner text NOT NULL,task jsonb NOT NULL)",
  );
  const taskStore = new PersistentTasks();
  const executor: AgentExecutor = {
    async execute(ctx, bus) {
      const actor = actorFor(ctx.context);
      const text = ctx.userMessage.parts
        .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
        .join("\n");
      const run = await command(actor, `a2a-${ctx.userMessage.messageId}`, {
        type: "run.start",
        request: text,
      });
      const task = Task.fromJSON({
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: { state: "TASK_STATE_INPUT_REQUIRED" },
        history: [Message.toJSON(ctx.userMessage)],
        metadata: { runId: run.id },
      });
      bus.publish(AgentEvent.task(task));
      await store.create(
        "a2a",
        {
          externalTaskId: ctx.taskId,
          runId: run.id,
          actorId: actor.id,
          direction: "inbound",
        },
        "a2a.task.mapped",
        actor,
      );
      bus.finished();
    },
    async cancelTask(id, bus) {
      const r = await pool.query(
        "SELECT task,owner FROM a2a_tasks WHERE id=$1",
        [id],
      );
      if (!r.rows[0]) return;
      const task = Task.fromJSON(r.rows[0].task);
      const run = await store.get(task.metadata!.runId);
      const actor: Actor = {
        id: r.rows[0].owner,
        type: "external",
        projectId: run.projectId,
        permissions: ["run.stop", "project.read"],
      };
      await command(actor, `cancel-${id}`, {
        type: "run.stop",
        runId: task.metadata!.runId,
      });
      bus.publish(
        AgentEvent.statusUpdate({
          taskId: id,
          contextId: task.contextId,
          status: {
            state: TaskState.TASK_STATE_CANCELED,
            timestamp: new Date().toISOString(),
            message: undefined,
          },
          metadata: undefined,
        }),
      );
      bus.finished();
    },
  };
  const port = Number(process.env.COLAG_A2A_PORT || 4312);
  const handler = new DefaultRequestHandler(
    card(`http://127.0.0.1:${port}`),
    taskStore,
    executor,
  );
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: handler }),
  );
  app.use(
    "/a2a",
    jsonRpcHandler({
      requestHandler: handler,
      userBuilder: async (req) => {
        const actor = await store.authenticate(
          req.headers.authorization?.replace(/^Bearer /, "") || "",
        );
        return { isAuthenticated: true, userName: JSON.stringify(actor) };
      },
    }),
  );
  return app.listen(port, "127.0.0.1");
}
export async function delegateExternal(actor: Actor, message: string) {
  const endpoint = process.env.COLAG_A2A_ENDPOINT || "http://127.0.0.1:4320";
  const client = await new ClientFactory().createFromUrl(endpoint);
  const result = await client.sendMessage(
    {
      message: Message.fromJSON({
        messageId: randomUUID(),
        role: "ROLE_USER",
        parts: [{ text: message }],
      }),
      metadata: undefined,
      configuration: undefined,
      tenant: "",
    },
    {
      signal: AbortSignal.timeout(30000),
      serviceParameters: process.env.COLAG_A2A_TOKEN
        ? { Authorization: `Bearer ${process.env.COLAG_A2A_TOKEN}` }
        : {},
    },
  );
  await store.create(
    "a2a",
    {
      runId: actor.runId,
      direction: "outbound",
      endpoint,
      result: JSON.parse(JSON.stringify(result)),
      actorId: actor.id,
    },
    "task.delegated",
    actor,
  );
  await store.create(
    "artifact",
    {
      name: "External A2A review",
      content: JSON.stringify(result, null, 2),
      runId: actor.runId,
      createdBy: actor.id,
    },
    "artifact.created",
    actor,
  );
  return result;
}
