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
import { preflight } from "../../../packages/runtime/src/index.ts";
import { collaboration } from "./documents.ts";
import { startA2A } from "../../../packages/adapters/src/a2a.ts";
import { handleMcp } from "./mcp-http.ts";
import * as sandbox from "./sandbox.ts";
import * as desk from "./desk.ts";
import * as demo from "./demo.ts";
import { createReadStream } from "node:fs";
import { WebSocketServer } from "ws";
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
app.get("/api/v1/projects/:id/build", async (req) => {
  const actor = await roomActor(req);
  const current = await sandbox.loadBuild(actor.projectId);
  if (!current)
    return { sha: null, ref: null, running: false, bought: false };
  return {
    sha: current.sha,
    ref: current.ref,
    running: current.running,
    bought: await sandbox.hasPurchase(actor.projectId, actor.id, current.sha),
  };
});
app.post("/api/v1/projects/:id/sandbox", async (req) => {
  const actor = await roomActor(req);
  assert(actor.type === "human", "Only a member can open the sandbox", "forbidden", 403);
  const current = await sandbox.loadBuild(actor.projectId);
  assert(current, "Nothing has been built", "not_found", 404);
  await sandbox.ensure(actor.projectId, current.runId, current.sha);
  const ticket = sandbox.issueTicket(actor.projectId, actor.id);
  return {
    sha: current.sha,
    ref: current.ref,
    running: true,
    bought: await sandbox.hasPurchase(actor.projectId, actor.id, current.sha),
    streamUrl: sandbox.streamUrl(actor.projectId, ticket),
  };
});
app.delete("/api/v1/projects/:id/sandbox", async (req, reply) => {
  const actor = await roomActor(req);
  assert(actor.type === "human", "Only a member can stop the sandbox", "forbidden", 403);
  await sandbox.destroy(actor.projectId);
  reply.status(204).send();
});
app.post("/api/v1/projects/:id/build/buy", async (req) => {
  const actor = await roomActor(req);
  const sha = (req.body as { sha?: string } | undefined)?.sha;
  assert(typeof sha === "string" && sha.length > 0, "Build sha required");
  const record = await sandbox.buy(actor, sha);
  return { sha: record.data.sha, bought: true };
});
app.get("/api/v1/projects/:id/build/archive", async (req, reply) => {
  const actor = await roomActor(req);
  assert(actor.type === "human", "Only a member can download a build", "forbidden", 403);
  const current = await sandbox.loadBuild(actor.projectId);
  assert(current, "Nothing has been built", "not_found", 404);
  assert(
    await sandbox.hasPurchase(actor.projectId, actor.id, current.sha),
    "Buy this build before downloading it",
    "not_purchased",
    409,
  );
  reply.header("Content-Type", "application/zip");
  reply.header(
    "Content-Disposition",
    `attachment; filename="colag-${current.sha.slice(0, 8)}.zip"`,
  );
  return reply.send(sandbox.zipStream(current.runId, current.sha));
});
app.post("/api/v1/projects/:id/desk", async (req) => {
  const actor = await roomActor(req);
  const message = (req.body as { message?: string } | undefined)?.message;
  assert(typeof message === "string", "A customer message is required");
  const reply = await desk.draftReply(actor, message);
  return reply;
});
app.post("/api/v1/projects/:id/desk/:replyId/approve", async (req) => {
  const actor = await roomActor(req);
  return desk.settle(actor, (req.params as { replyId: string }).replyId, "approved");
});
app.post("/api/v1/projects/:id/desk/:replyId/return", async (req) => {
  const actor = await roomActor(req);
  return desk.settle(actor, (req.params as { replyId: string }).replyId, "returned");
});
app.get("/api/v1/projects/:id/demos", async (req) => demo.listDemos(await roomActor(req)));
app.post("/api/v1/projects/:id/demos", async (req) => demo.createDemo(await roomActor(req), req.body));
app.get("/api/v1/projects/:id/demos/:demoId", async (req) =>
  demo.getDemo(await roomActor(req), (req.params as { demoId: string }).demoId),
);
app.patch("/api/v1/projects/:id/demos/:demoId", async (req) =>
  demo.updateDemo(await roomActor(req), (req.params as { demoId: string }).demoId, req.body),
);
app.delete("/api/v1/projects/:id/demos/:demoId", async (req, reply) => {
  await demo.deleteDemo(await roomActor(req), (req.params as { demoId: string }).demoId);
  reply.status(204).send();
});
app.post("/api/v1/projects/:id/demos/:demoId/render", async (req) =>
  demo.queueRender(await roomActor(req), (req.params as { demoId: string }).demoId),
);
app.get("/api/v1/projects/:id/demos/:demoId/files/:name", async (req, reply) => {
  const params = req.params as { demoId: string; name: string };
  const file = await demo.demoFile(await roomActor(req), params.demoId, params.name);
  const download = (req.query as { download?: string }).download !== undefined;
  reply.header("Content-Type", file.type);
  reply.header("Accept-Ranges", "bytes");
  reply.header("Cache-Control", "private, max-age=300");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(file.download)}"`,
  );
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : file.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : file.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, file.size - 1);
    if (start > end) {
      reply.status(416).header("Content-Range", `bytes */${file.size}`);
      return reply.send();
    }
    reply.status(206);
    reply.header("Content-Range", `bytes ${start}-${end}/${file.size}`);
    reply.header("Content-Length", String(end - start + 1));
    return reply.send(createReadStream(file.file, { start, end }));
  }
  reply.header("Content-Length", String(file.size));
  return reply.send(createReadStream(file.file));
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
const sockets = new WebSocketServer({ noServer: true });
app.server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", "http://localhost");
  const match = url.pathname.match(
    /^\/api\/v1\/projects\/([^/]+)\/sandbox\/stream$/,
  );
  if (!match) {
    socket.destroy();
    return;
  }
  const requestOrigin = request.headers.origin;
  if (requestOrigin && !allowedOrigins.includes(requestOrigin)) {
    socket.destroy();
    return;
  }
  const session = sandbox.takeTicket(url.searchParams.get("ticket") || "");
  if (!session || session.projectId !== decodeURIComponent(match[1])) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (ws) => {
    try {
      sandbox.attach(session.projectId, ws);
    } catch (error: any) {
      ws.send(error.message || "The sandbox is not running");
      ws.close();
    }
  });
});
console.log(`Colag service listening on ${bindHost}:${port}`);
async function boot() {
  try {
    await migrate();
    void store.redis.connect().catch(() => {});
    await collaboration.listen();
    await startA2A();
    await engine.recover();
    await sandbox.reap();
    await demo.recoverDemos();
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
  void demo
    .stopDemos()
    .then(() => sandbox.stopAll())
    .finally(() => engine.shutdown())
    .finally(() => app.close())
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});