import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { migrate } from "../../../packages/database/src.ts";
import { assert, authorize } from "../../../packages/domain/src/index.ts";
import type { Actor, Command } from "../../../packages/protocol/src/index.ts";
import * as store from "./store.ts";
import * as engine from "./engine.ts";
import * as identity from "./identity.ts";
import { diffFiles } from "../../../packages/git/src/index.ts";
import { preflight } from "../../../packages/runtime/src/claude.ts";
import { collaboration } from "./documents.ts";
import { startA2A } from "../../../packages/adapters/src/a2a.ts";
import { handleMcp } from "./mcp-http.ts";
import { mkdir } from "node:fs/promises";
import { root } from "../../../packages/git/src/index.ts";
const app = Fastify({
  logger: true,
  bodyLimit: 2_100_000,
  forceCloseConnections: true,
});
const bindHost = process.env.COLAG_HOST || "127.0.0.1";
const origin =
  process.env.COLAG_PUBLIC_ORIGIN ||
  process.env.COLAG_WEB_ORIGIN ||
  "http://localhost:3000";
const allowedOrigins = Array.from(
  new Set([
    origin,
    ...(process.env.COLAG_PUBLIC_ORIGIN
      ? []
      : ["http://127.0.0.1:3000", "http://localhost:3000"]),
  ]),
);
await app.register(cors, { origin: allowedOrigins, credentials: true });
await app.register(cookie);
await mkdir(root, { recursive: true });
app.addHook("onRequest", async (req) => {
  const requestOrigin = req.headers.origin;
  if (!requestOrigin) return;
  if (req.url.startsWith("/mcp") && req.headers.authorization) return;
  assert(
    allowedOrigins.includes(requestOrigin),
    "Origin not allowed",
    "forbidden",
    403,
  );
});
app.setErrorHandler((error: any, _req, reply) => {
  reply
    .status(error.status || error.statusCode || 500)
    .send({ error: error.message, code: error.code || "internal_error" });
});
const bearer = (req: any) =>
  req.headers.authorization?.replace(/^Bearer /, "") || "";
function sessionCookie(reply: any, token: string) {
  reply.setCookie("colag_session", token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
    secure: origin.startsWith("https://"),
  });
}
async function requireUser(req: any) {
  assert(ready, bootError, "unavailable", 503);
  if (bearer(req)) await identity.openMe(undefined, bearer(req));
  return identity.userFromSession(req.cookies.colag_session);
}
async function roomActor(req: any) {
  const person = await requireUser(req);
  return identity.memberActor(person, (req.params as any).id);
}
async function commandActor(req: any): Promise<Actor> {
  const roomId = (req.params as any).id as string;
  const token = bearer(req);
  if (token) {
    const actor = await store.authenticate(token);
    assert(
      actor.type !== "agent" || actor.projectId === roomId,
      "Project membership required",
      "forbidden",
      403,
    );
    if (actor.type === "human") {
      authorize(actor, roomId, "project.read");
      return { ...actor, projectId: roomId };
    }
    assert(
      actor.projectId === roomId,
      "Project membership required",
      "forbidden",
      403,
    );
    return actor;
  }
  const person = await identity.userFromSession(req.cookies.colag_session);
  return identity.memberActor(person, roomId);
}
const key = (req: any) => {
  const k = req.headers["idempotency-key"];
  assert(
    typeof k === "string" && k.length > 0 && k.length < 200,
    "Idempotency-Key is required",
  );
  return k;
};
let ready = false,
  bootError = "Starting services";
let lastHealth: any = {},
  healthAt = 0;
app.get("/api/v1/health", async () => {
  if (Date.now() - healthAt > 15000) {
    healthAt = Date.now();
    lastHealth = await preflight();
  }
  return {
    ready,
    error: ready ? null : bootError,
    checks: {
      postgres: { ok: ready, detail: ready ? "Connected" : bootError },
      redis: {
        ok: store.redis.isReady,
        detail: store.redis.isReady ? "Connected" : "Redis unavailable",
      },
      ...lastHealth,
    },
  };
});
app.post("/api/v1/auth/request", async (req) => {
  assert(ready, bootError, "unavailable", 503);
  return identity.requestCode((req.body as any)?.email);
});
app.post("/api/v1/auth/verify", async (req, reply) => {
  assert(ready, bootError, "unavailable", 503);
  const result = await identity.verifyCode(req.body);
  sessionCookie(reply, result.token);
  return { user: result.user };
});
app.post("/api/v1/auth/logout", async (req, reply) => {
  await identity.revokeSession(req.cookies.colag_session);
  reply.clearCookie("colag_session", { path: "/" });
  return { ok: true };
});
app.get("/api/v1/me", async (req) => identity.openMe(req.cookies.colag_session, bearer(req) || undefined));
app.patch("/api/v1/me", async (req) => {
  const person = await requireUser(req);
  return identity.updateProfile(person.id, (req.body as any)?.displayName);
});
app.get("/api/v1/projects", async (req) => {
  const person = await requireUser(req);
  return identity.listRooms(person.id);
});
app.post("/api/v1/projects", async (req) => {
  const person = await requireUser(req);
  return identity.createRoom(
    person,
    (req.body as any)?.name,
    (req.body as any)?.purpose,
  );
});
app.get("/api/v1/projects/:id", async (req) => {
  const person = await requireUser(req);
  const actor = await identity.memberActor(person, (req.params as any).id);
  const people = await identity.roomPeople(actor.projectId);
  return {
    ...(await store.snapshot(actor.projectId)),
    ...people,
    you: person,
  };
});
app.get("/api/v1/projects/:id/document-token", async (req) => {
  const person = await requireUser(req);
  const actor = await identity.memberActor(person, (req.params as any).id);
  return {
    token: await store.issue({ ...actor, permissions: ["document.write"] }, 12),
  };
});
app.patch("/api/v1/projects/:id", async (req) => {
  const actor = await roomActor(req);
  assert(actor.type === "human", "Human required", "forbidden", 403);
  return identity.renameRoom(actor.projectId, (req.body as any)?.name);
});
app.post("/api/v1/projects/:id/invites", async (req) => {
  const person = await requireUser(req);
  const actor = await identity.memberActor(person, (req.params as any).id);
  return identity.createInvite(person, actor.projectId, origin);
});
app.post("/api/v1/invites/accept", async (req) => {
  const person = await requireUser(req);
  return identity.acceptInvite(person, (req.body as any)?.token);
});
app.post("/api/v1/projects/:id/connections", async (req) => {
  const person = await requireUser(req);
  const actor = await identity.memberActor(person, (req.params as any).id);
  return identity.createConnection(person, actor.projectId, (req.body as any)?.name);
});
app.delete("/api/v1/projects/:id/connections/:connectionId", async (req) => {
  const person = await requireUser(req);
  const actor = await identity.memberActor(person, (req.params as any).id);
  return identity.revokeConnection(
    actor.projectId,
    (req.params as any).connectionId,
    person.id,
  );
});
app.post("/api/v1/projects/:id/external-token", async (req) => {
  const person = await requireUser(req);
  const roomId = (req.params as any).id as string;
  await identity.memberActor(person, roomId);
  return {
    token: await store.issue({
      id: `external-${person.id}`,
      type: "external",
      projectId: roomId,
      permissions: ["project.read", "run.start", "run.stop"],
    }),
  };
});
app.get("/api/v1/projects/:id/events", async (req, reply) => {
  const actor = await roomActor(req);
  authorize(actor, actor.projectId, "project.read");
  const q = req.query as any;
  let cursor = Number(req.headers["last-event-id"] || q.after || 0);
  assert(Number.isSafeInteger(cursor) && cursor >= 0, "Invalid event cursor");
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": req.headers.origin || origin,
    "Access-Control-Allow-Credentials": "true",
  });
  let closed = false,
    busy = false;
  const tick = async () => {
    if (closed || busy) return;
    busy = true;
    try {
      for (const e of await store.events(cursor, actor.projectId)) {
        if (closed) break;
        reply.raw.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
        cursor = e.seq;
      }
      reply.raw.write(": heartbeat\n\n");
    } catch {
      reply.raw.end();
      closed = true;
    } finally {
      busy = false;
    }
  };
  await tick();
  const timer = setInterval(tick, 1000);
  req.raw.on("close", () => {
    closed = true;
    clearInterval(timer);
  });
});
app.post("/api/v1/projects/:id/commands", async (req) => {
  const a = await commandActor(req);
  authorize(a, a.projectId, "project.read");
  const c = req.body as Command;
  assert(c && typeof c.type === "string", "Command type required");
  return engine.command(a, key(req), c);
});
app.get("/api/v1/projects/:id/changes/:changeId/diff", async (req) => {
  const a = await roomActor(req);
  authorize(a, a.projectId, "project.read");
  const change = await store.get((req.params as any).changeId);
  assert(
    change.projectId === a.projectId && change.kind === "change",
    "Change not found",
    "not_found",
    404,
  );
  const run = await store.get(change.data.runId);
  return diffFiles(run.id, run.data.baseSha, change.data.sha);
});
app.get("/api/v1/projects/:id/artifacts/:artifactId", async (req) => {
  const a = await roomActor(req);
  authorize(a, a.projectId, "project.read");
  const artifact = await store.get((req.params as any).artifactId);
  assert(
    artifact.kind === "artifact" && artifact.projectId === a.projectId,
    "Artifact not found",
    "not_found",
    404,
  );
  return artifact;
});
app.post("/api/v1/tools/:name", async (req) => {
  const token = bearer(req);
  assert(token, "Agent credential required", "unauthorized", 401);
  const a = await store.authenticate(token);
  assert(a.type === "agent", "Agent credential required", "forbidden", 403);
  return engine.tools(a, (req.params as any).name, req.body, key(req));
});
app.route({
  method: ["GET", "POST", "DELETE"],
  url: "/mcp",
  handler: async (req, reply) => {
    const actor = await identity.authenticateMcp(bearer(req) || undefined);
    reply.hijack();
    await handleMcp(req.raw, reply.raw, req.body, actor);
  },
});
const port = Number(process.env.COLAG_PORT || 4310);
await app.listen({ host: bindHost, port });
console.log(`Colag service listening on ${bindHost}:${port}`);
async function boot() {
  try {
    await migrate();
    void store.redis.connect().catch(() => {});
    await collaboration.listen();
    await startA2A();
    await engine.recover();
    ready = true;
    setInterval(
      () => void store.expireLeases().catch((e) => app.log.error(e)),
      10000,
    ).unref();
    console.log("Colag services ready");
  } catch (e: any) {
    bootError = e.message;
    console.error("Startup blocked:", bootError);
  }
}
void boot();
process.on("SIGTERM", () => {
  void engine
    .shutdown()
    .finally(() => app.close())
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});