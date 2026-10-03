import {
  MEMBER_ACTIONS,
  type Actor,
  type Entity,
  type TaskStatus,
} from "../../protocol/src/index.ts";
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  message: string,
  code = "invalid",
  status = 400,
): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}
export function authorize(actor: Actor, projectId: string, action: string) {
  if (actor.type === "human") {
    assert(
      actor.rooms?.includes(projectId),
      "Project membership required",
      "forbidden",
      403,
    );
    const allowed = actor.permissions.length
      ? actor.permissions
      : MEMBER_ACTIONS;
    assert(
      !actor.permissions.includes("*") && allowed.includes(action),
      "Permission denied: " + action,
      "forbidden",
      403,
    );
    return;
  }
  assert(
    actor.projectId === projectId,
    "Project membership required",
    "forbidden",
    403,
  );
  assert(
    actor.type === "system" ||
      actor.permissions.includes("*") ||
      actor.permissions.includes(action),
    "Permission denied: " + action,
    "forbidden",
    403,
  );
}
const transitions: Record<TaskStatus, TaskStatus[]> = {
  pending: ["claimed", "cancelled"],
  claimed: ["working", "failed", "cancelled"],
  working: ["blocked", "review", "completed", "failed", "cancelled"],
  blocked: ["pending", "cancelled"],
  review: ["completed", "working", "failed", "cancelled"],
  completed: [],
  failed: ["pending", "cancelled"],
  cancelled: [],
};
export function transition(from: TaskStatus, to: TaskStatus) {
  assert(
    transitions[from]?.includes(to),
    `Cannot transition ${from} to ${to}`,
    "conflict",
    409,
  );
}
export function validateDependencies(
  tasks: Entity[],
  id: string,
  deps: string[],
  runId: string,
) {
  assert(!deps.includes(id), "Task cannot depend on itself");
  const map = new Map(tasks.map((t) => [t.id, t]));
  for (const dep of deps)
    assert(
      map.get(dep)?.data.runId === runId,
      "Dependencies must belong to the same run",
    );
  const visit = (key: string, path: Set<string>) => {
    assert(!path.has(key), "Dependency cycle");
    const next = new Set(path).add(key);
    for (const d of key === id ? deps : map.get(key)?.data.dependencies || [])
      visit(d, next);
  };
  visit(id, new Set());
}
export function canClaim(task: Entity, tasks: Entity[], run: Entity) {
  assert(
    run.data.status === "running",
    "Plan must be approved and run active",
    "conflict",
    409,
  );
  assert(
    task.data.status === "pending",
    "Task is already claimed or unavailable",
    "conflict",
    409,
  );
  for (const id of task.data.dependencies || [])
    assert(
      tasks.find((t) => t.id === id)?.data.status === "completed",
      "Dependencies are incomplete",
      "dependency_blocked",
      409,
    );
}
export function mergeable(
  run: Entity,
  review: Entity | undefined,
  targetHead: string,
) {
  assert(
    run.data.status === "awaiting_merge",
    "Run is not awaiting merge",
    "conflict",
    409,
  );
  assert(
    run.data.candidateSha &&
      run.data.testSha === run.data.candidateSha &&
      run.data.testsPassed === true,
    "Tests do not match candidate",
    "conflict",
    409,
  );
  assert(
    review?.data.status === "approved" &&
      review.data.sha === run.data.candidateSha,
    "Review does not match candidate",
    "conflict",
    409,
  );
  assert(
    run.data.baseSha === targetHead,
    "Target changed; rebuild and review candidate",
    "conflict",
    409,
  );
}
