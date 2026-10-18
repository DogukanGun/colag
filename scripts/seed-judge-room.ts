import { randomUUID } from "node:crypto";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pool, transaction } from "../packages/database/src.ts";
import * as git from "../packages/git/src/index.ts";
import * as desk from "../apps/service/src/desk.ts";
import * as identity from "../apps/service/src/identity.ts";
import * as store from "../apps/service/src/store.ts";

const auth = `import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
const users = new Map();
const sessions = new Map();
export function register(email, password) {
  const id = randomBytes(8).toString("hex");
  users.set(email, { id, email, hash: scryptSync(password, id, 32).toString("hex") });
  return { id, email };
}
export function login(email, password) {
  const user = users.get(email);
  if (!user) throw new Error("Unknown account");
  const hash = scryptSync(password, user.id, 32);
  const saved = Buffer.from(user.hash, "hex");
  if (hash.length !== saved.length || !timingSafeEqual(hash, saved)) throw new Error("Wrong password");
  const token = randomBytes(16).toString("hex");
  sessions.set(token, user.id);
  return { token, user: { id: user.id, email } };
}
export function authenticate(token) {
  const id = sessions.get(token);
  if (!id) return null;
  const user = [...users.values()].find((item) => item.id === id);
  return user ? { id: user.id, email: user.email } : null;
}
export function logout(token) { sessions.delete(token); }
`;

const person = await identity.upsertUser("judge-demo@colag.test", "Alex");
const room = await store.provisionRoom(person.id, "Ride matching");
const runId = randomUUID();
const taskId = randomUUID();
const system = store.systemActor(room.id);
const repo = await git.createRepository(runId);
const work = await git.createWorktree(runId, taskId, repo.baseSha);
await git.writeWorkspace(work, "backend/auth.mjs", auth);
const commit = await git.commitTask(runId, taskId);
await transaction(system, randomUUID(), { runId }, (tx) =>
  tx.create(
    "run",
    {
      request: "Riders request a car. The nearest driver accepts.",
      status: "awaiting_merge",
      baseSha: repo.baseSha,
      candidateSha: commit.sha,
    },
    "run.started",
    runId,
  ),
);
await transaction(system, randomUUID(), { taskId }, (tx) =>
  tx.create(
    "task",
    {
      title: "Implement sign-in",
      description: "register, login, authenticate, and logout.",
      role: "Backend",
      status: "review",
      assigneeAgentId: `agent-backend-${room.id}`,
      runId,
    },
    "task.created",
    taskId,
  ),
);
await transaction(system, randomUUID(), { sha: commit.sha }, (tx) =>
  tx.create("change", {
    runId,
    taskId,
    branch: commit.branch,
    sha: commit.sha,
    baseSha: repo.baseSha,
    filesChanged: commit.filesChanged,
    status: "proposed",
  }, "change.proposed"),
);
await transaction(system, randomUUID(), { name: "Authentication tests" }, (tx) =>
  tx.create("artifact", {
    name: "Authentication tests",
    contentType: "text/plain",
    content: "register, login, authenticate, and logout passed.",
    createdBy: `agent-backend-${room.id}`,
    runId,
  }, "artifact.published"),
);
const human = await identity.memberActor(person, room.id);
await desk.draftReply(human, "How many days does a customer have to return a lamp?");
const demoId = randomUUID();
await transaction(system, randomUUID(), { demoId }, (tx) =>
  tx.create("demo", {
    title: "Sign-up",
    language: "en",
    music: true,
    emailKit: false,
    status: "ready",
    files: ["video.mp4"],
    sha: commit.sha,
    createdByName: "Forge",
  }, "demo.created", demoId),
);
const video = process.env.COLAG_DEMO_MP4;
if (!video) throw new Error("COLAG_DEMO_MP4 required");
const safe = (value: string) => value.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 60) || "x";
const out = path.join(process.env.COLAG_DATA_DIR || ".colag", "demos", safe(room.id), safe(demoId), "out");
await mkdir(out, { recursive: true });
await copyFile(video, path.join(out, "video.mp4"));
await store.update(
  `agent-backend-${room.id}`,
  { status: "working", taskId },
  "agent.updated",
  system,
);
await writeFile("/data/judge-room.txt", room.id);
console.log(room.id);
await pool.end();
if (store.redis.isOpen) await store.redis.quit();
