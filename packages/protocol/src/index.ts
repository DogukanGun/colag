/** Blocked runs retain their workspace and must be retried or stopped. */
export function isActiveRunStatus(status: string): boolean {
  return !["completed", "failed", "cancelled"].includes(status);
}

export type TaskStatus =
  | "pending"
  | "claimed"
  | "working"
  | "blocked"
  | "review"
  | "completed"
  | "failed"
  | "cancelled";
export type RunStatus =
  | "planning"
  | "awaiting_approval"
  | "running"
  | "blocked"
  | "reviewing"
  | "awaiting_merge"
  | "completed"
  | "failed"
  | "cancelled";
export type Kind =
  | "project"
  | "agent"
  | "document"
  | "task"
  | "decision"
  | "artifact"
  | "change"
  | "review"
  | "run"
  | "delegation"
  | "lock"
  | "a2a"
  | "purchase"
  | "reply";
export interface Entity {
  id: string;
  projectId: string;
  kind: Kind;
  version: number;
  createdAt: string;
  updatedAt: string;
  data: Record<string, any>;
}
export interface Actor {
  id: string;
  type: "human" | "agent" | "system" | "external";
  projectId: string;
  permissions: string[];
  runId?: string;
  taskId?: string;
  /** Rooms a human belongs to. A human has no wildcard permission. */
  rooms?: string[];
  displayName?: string;
  connectionId?: string;
  clientName?: string;
}
/** Actions a signed-in room member can take. Approve and merge stay here, on the human. */
export const MEMBER_ACTIONS = [
  "project.read",
  "document.write",
  "agent.register",
  "task.create",
  "task.update",
  "task.delegate",
  "decision.create",
  "decision.update",
  "artifact.create",
  "review.create",
  "lock.acquire",
  "lock.release",
  "run.start",
  "run.approve",
  "run.stop",
  "run.retry",
  "run.merge",
  "agent.prompt",
  "board.submit",
  "change.propose",
];
/** Tools a connected coding client may call. Plan approval and merge are absent. */
export const EXTERNAL_MCP_PERMISSIONS = [
  "project.read",
  "document.write",
  "task.create",
  "task.claim",
  "task.update",
  "task.delegate",
  "decision.create",
  "artifact.create",
  "workspace.read",
  "workspace.write",
  "change.propose",
];
export interface CollaborationEvent {
  seq: number;
  id: string;
  projectId: string;
  actorId: string;
  type: string;
  resourceId: string;
  timestamp: string;
  payload: Record<string, any>;
}
export interface Snapshot {
  project: Entity;
  resources: Entity[];
  events: CollaborationEvent[];
  presence: Record<string, any>;
  lastSeq: number;
}
export interface TaskInput {
  title: string;
  description: string;
  role: string;
  dependencies: string[];
  relatedFiles: string[];
  runId: string;
}
export interface Plan {
  title: string;
  document: string;
  tasks: {
    key: string;
    title: string;
    description: string;
    role: string;
    dependencies: string[];
    relatedFiles: string[];
  }[];
}
export type Command =
  | {
      type: "agent.register";
      name: string;
      role: string;
      capabilities: string[];
      permissions?: string[];
    }
  | { type: "task.create"; task: TaskInput }
  | { type: "task.claim"; taskId: string }
  | {
      type: "task.update";
      taskId: string;
      status: TaskStatus;
      version?: number;
      reason?: string;
    }
  | {
      type: "task.delegate";
      taskId: string;
      targetAgentId: string;
      reason: string;
    }
  | {
      type: "decision.create";
      title: string;
      description: string;
      affectedTasks?: string[];
    }
  | {
      type: "decision.update";
      decisionId: string;
      status: "approved" | "rejected" | "superseded";
    }
  | {
      type: "artifact.create";
      name: string;
      content: string;
      taskId?: string;
      artifactType?: string;
    }
  | {
      type: "review.create";
      changeId: string;
      status: "approved" | "changes_requested";
      comments: string;
    }
  | { type: "change.propose"; taskId: string }
  | { type: "lock.acquire"; resource: string; ttlMs: number; reason: string }
  | { type: "lock.release"; lockId: string }
  | { type: "run.start"; request: string }
  | {
      type: "run.approve" | "run.stop" | "run.retry" | "run.merge";
      runId: string;
    }
  | { type: "agent.prompt"; agentId: string; command: string }
  | { type: "board.submit" };
export const DEFAULT_AGENTS = [
  {
    name: "Atlas",
    role: "Coordinator",
    capabilities: ["planning", "delegation"],
  },
  {
    name: "Ada",
    role: "Architect",
    capabilities: ["architecture", "typescript"],
  },
  {
    name: "Forge",
    role: "Backend",
    capabilities: ["nodejs", "typescript", "testing"],
  },
  { name: "Pixel", role: "Frontend", capabilities: ["react", "typescript"] },
  {
    name: "Sentinel",
    role: "QA",
    capabilities: ["testing", "security-review", "code-review"],
  },
];
