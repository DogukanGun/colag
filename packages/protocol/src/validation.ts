import { z } from "zod";
const id = z.string().min(1).max(160),
  text = z.string().min(1).max(20000);
const task = z
  .object({
    title: z.string().min(1).max(200),
    description: text,
    role: z.string().min(1).max(80),
    dependencies: z.array(id).max(30),
    relatedFiles: z.array(z.string().min(1).max(300)).max(30),
    runId: id,
  })
  .strict();
export const commandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("agent.register"),
      name: z.string().min(1).max(100),
      role: z.string().min(1).max(80),
      capabilities: z.array(id),
      permissions: z.array(id).optional(),
    })
    .strict(),
  z.object({ type: z.literal("task.create"), task }).strict(),
  z.object({ type: z.literal("task.claim"), taskId: id }).strict(),
  z
    .object({
      type: z.literal("task.update"),
      taskId: id,
      status: z.enum([
        "pending",
        "claimed",
        "working",
        "blocked",
        "review",
        "completed",
        "failed",
        "cancelled",
      ]),
      version: z.number().int().positive().optional(),
      reason: text.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("task.delegate"),
      taskId: id,
      targetAgentId: id,
      reason: text,
    })
    .strict(),
  z
    .object({
      type: z.literal("decision.create"),
      title: text,
      description: text,
      affectedTasks: z.array(id).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("decision.update"),
      decisionId: id,
      status: z.enum(["approved", "rejected", "superseded"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("artifact.create"),
      name: text,
      content: z.string().max(2000000),
      taskId: id.optional(),
      artifactType: id.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("review.create"),
      changeId: id,
      status: z.enum(["approved", "changes_requested"]),
      comments: text,
    })
    .strict(),
  z.object({ type: z.literal("change.propose"), taskId: id }).strict(),
  z
    .object({
      type: z.literal("lock.acquire"),
      resource: text,
      ttlMs: z.number().int().min(1).max(900000),
      reason: text,
    })
    .strict(),
  z.object({ type: z.literal("lock.release"), lockId: id }).strict(),
  z
    .object({
      type: z.literal("run.start"),
      request: z.string().min(1).max(12000),
    })
    .strict(),
  z.object({ type: z.literal("run.approve"), runId: id }).strict(),
  z.object({ type: z.literal("run.stop"), runId: id }).strict(),
  z.object({ type: z.literal("run.retry"), runId: id }).strict(),
  z.object({ type: z.literal("run.merge"), runId: id }).strict(),
  z
    .object({
      type: z.literal("agent.prompt"),
      agentId: id,
      command: z.string().min(1).max(12000),
    })
    .strict(),
  z.object({ type: z.literal("board.submit") }).strict(),
]);
