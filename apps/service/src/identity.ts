import { randomBytes, randomInt } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { pool, hash } from "../../../packages/database/src.ts";
import { assert, DomainError } from "../../../packages/domain/src/index.ts";
import type { Actor } from "../../../packages/protocol/src/index.ts";
import { EXTERNAL_MCP_PERMISSIONS } from "../../../packages/protocol/src/index.ts";
import * as store from "./store.ts";

export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}
const user = (r: any): User => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  createdAt: r.created_at.toISOString(),
});
const emailOf = (value: unknown) => {
  assert(typeof value === "string", "Email is required");
  const email = value.trim().toLowerCase();
  assert(
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length < 200,
    "Enter a valid email address",
  );
  return email;
};
function labelOf(value: unknown, label: string) {
  assert(typeof value === "string" && value.trim(), `${label} is required`);
  const name = value.trim().replace(/\s+/g, " ");
  assert(name.length <= 80, `${label} must be 80 characters or fewer`);
  return name;
}
const nameOf = (value: unknown) => labelOf(value, "Display name");
export function authRequestBody(
  code: string,
  mailed: boolean,
  env = process.env.NODE_ENV,
) {
  if (mailed) return { ok: true as const };
  if (env !== "production") return { ok: true as const, code };
  return { ok: true as const };
}
export async function requestCode(rawEmail: unknown) {
  const email = emailOf(rawEmail);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await pool.query(
    "UPDATE login_codes SET consumed_at=now() WHERE email=$1 AND consumed_at IS NULL",
    [email],
  );
  await pool.query(
    "INSERT INTO login_codes(id,email,code_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
    [randomBytes(16).toString("hex"), email, hash(code)],
  );
  let mailed = false;
  if (process.env.COLAG_SMTP_HOST) {
    try {
      await sendLoginCode(email, code);
      mailed = true;
    } catch (e: any) {
      await pool.query(
        "UPDATE login_codes SET consumed_at=now() WHERE email=$1 AND code_hash=$2",
        [email, hash(code)],
      );
      throw new DomainError(
        "unavailable",
        e.message || "Could not send the sign-in code",
        503,
      );
    }
  }
  return { email, ...authRequestBody(code, mailed) };
}
export async function verifyCode(body: any) {
  const email = emailOf(body?.email);
  assert(typeof body?.code === "string", "Code is required");
  const code = body.code.trim();
  const found = await pool.query(
    "SELECT * FROM login_codes WHERE email=$1 AND code_hash=$2 ORDER BY expires_at DESC LIMIT 1",
    [email, hash(code)],
  );
  const row = found.rows[0];
  assert(row, "That code is wrong", "unauthorized", 401);
  assert(
    !row.consumed_at,
    "That code has already been used",
    "unauthorized",
    401,
  );
  assert(
    new Date(row.expires_at).getTime() > Date.now(),
    "That code has expired",
    "unauthorized",
    401,
  );
  let existing = await pool.query("SELECT * FROM users WHERE email=$1", [
    email,
  ]);
  if (!existing.rows[0] && !body?.displayName)
    throw new DomainError(
      "name_required",
      "Choose a display name to finish signing in",
      400,
    );
  await pool.query("UPDATE login_codes SET consumed_at=now() WHERE id=$1", [
    row.id,
  ]);
  if (!existing.rows[0]) {
    const displayName = nameOf(body.displayName);
    existing = await pool.query(
      "INSERT INTO users(id,email,display_name) VALUES($1,$2,$3) RETURNING *",
      [randomBytes(16).toString("hex"), email, displayName],
    );
  }
  const session = await createSession(existing.rows[0].id);
  return { user: user(existing.rows[0]), token: session };
}
export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '14 days')",
    [randomBytes(16).toString("hex"), userId, hash(token)],
  );
  return token;
}
export async function userFromSession(token: string | undefined) {
  assert(token, "Sign in required", "unauthorized", 401);
  const r = await pool.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`,
    [hash(token)],
  );
  assert(r.rows[0], "Sign in required", "unauthorized", 401);
  return user(r.rows[0]);
}
export async function revokeSession(token: string | undefined) {
  if (!token) return;
  await pool.query(
    "UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL",
    [hash(token)],
  );
}
export async function openMe(cookie?: string, bearer?: string) {
  if (bearer) {
    const cred = await pool.query(
      "SELECT actor FROM credentials WHERE hash=$1",
      [hash(bearer)],
    );
    if (cred.rows[0]?.actor?.type === "agent")
      assert(false, "Agent tokens cannot open the UI", "unauthorized", 401);
    assert(!cred.rows[0], "Sign in required", "unauthorized", 401);
  }
  return userFromSession(cookie);
}
export async function updateProfile(id: string, displayName: unknown) {
  const name = nameOf(displayName);
  const r = await pool.query(
    "UPDATE users SET display_name=$2 WHERE id=$1 RETURNING *",
    [id, name],
  );
  assert(r.rows[0], "User not found", "not_found", 404);
  return user(r.rows[0]);
}
export async function upsertUser(email: string, displayName: string) {
  const normalized = emailOf(email);
  const name = nameOf(displayName);
  const r = await pool.query(
    `INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)
     ON CONFLICT(email) DO UPDATE SET display_name=EXCLUDED.display_name
     RETURNING *`,
    [randomBytes(16).toString("hex"), normalized, name],
  );
  return user(r.rows[0]);
}
export async function memberships(userId: string) {
  return (
    await pool.query(
      "SELECT room_id, role FROM memberships WHERE user_id=$1 ORDER BY created_at",
      [userId],
    )
  ).rows.map((r) => ({ roomId: r.room_id as string, role: r.role as string }));
}
export async function memberActor(person: User, roomId: string): Promise<Actor> {
  const rooms = (await memberships(person.id)).map((m) => m.roomId);
  const actor: Actor = {
    id: person.id,
    type: "human",
    projectId: roomId,
    permissions: [],
    rooms,
    displayName: person.displayName,
  };
  const { authorize } = await import("../../../packages/domain/src/index.ts");
  authorize(actor, roomId, "project.read");
  return actor;
}
export async function listRooms(userId: string) {
  const r = await pool.query(
    `SELECT m.role, m.created_at, p.id, p.data
     FROM memberships m JOIN resources p ON p.id=m.room_id AND p.kind='project'
     WHERE m.user_id=$1 ORDER BY m.created_at DESC`,
    [userId],
  );
  return r.rows.map((row) => ({
    id: row.id as string,
    name: row.data.name as string,
    role: row.role as string,
    purpose: row.data.purpose as string | undefined,
    createdAt: row.created_at.toISOString(),
  }));
}
export async function createRoom(
  person: User,
  name: unknown,
  purpose?: unknown,
) {
  const title = labelOf(
    typeof name === "string" && name.trim() ? name : "New room",
    "Room name",
  );
  return store.provisionRoom(
    person.id,
    title,
    purpose === "app" ? "app" : "room",
  );
}
export async function renameRoom(roomId: string, name: unknown) {
  const title = labelOf(name, "Room name");
  return store.update(roomId, { name: title }, "project.renamed");
}
export async function createInvite(person: User, roomId: string, origin: string) {
  const token = randomBytes(24).toString("hex");
  await pool.query(
    "INSERT INTO invites(id,room_id,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days')",
    [randomBytes(16).toString("hex"), roomId, hash(token), person.id],
  );
  return {
    token,
    url: `${origin.replace(/\/$/, "")}/join/${token}`,
  };
}
export async function acceptInvite(person: User, token: unknown) {
  assert(typeof token === "string" && token.length > 10, "Invite is invalid");
  const r = await pool.query("SELECT * FROM invites WHERE token_hash=$1", [
    hash(token),
  ]);
  const row = r.rows[0];
  assert(row, "That invite is invalid", "not_found", 404);
  assert(!row.accepted_at, "That invite has already been used", "conflict", 409);
  assert(
    new Date(row.expires_at).getTime() > Date.now(),
    "That invite has expired",
    "conflict",
    409,
  );
  await pool.query(
    "INSERT INTO memberships(room_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING",
    [row.room_id, person.id],
  );
  await pool.query(
    "UPDATE invites SET accepted_by=$2, accepted_at=now() WHERE id=$1 AND accepted_at IS NULL",
    [row.id, person.id],
  );
  return { roomId: row.room_id as string };
}
export async function roomPeople(roomId: string) {
  const members = (
    await pool.query(
      `SELECT u.id, u.display_name, u.email, m.role FROM memberships m
       JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 ORDER BY m.created_at`,
      [roomId],
    )
  ).rows.map((r) => ({
    id: r.id as string,
    displayName: r.display_name as string,
    email: r.email as string,
    role: r.role as string,
  }));
  const connections = (
    await pool.query(
      `SELECT c.id, c.name, c.user_id, c.revoked_at, c.last_seen_at, u.display_name
       FROM mcp_connections c JOIN users u ON u.id=c.user_id
       WHERE c.room_id=$1 AND c.revoked_at IS NULL ORDER BY c.created_at`,
      [roomId],
    )
  ).rows.map((r) => {
    const seen = r.last_seen_at ? new Date(r.last_seen_at).getTime() : 0;
    return {
      id: r.id as string,
      name: r.name as string,
      userId: r.user_id as string,
      displayName: r.display_name as string,
      label: `${r.display_name} · ${r.name}`,
      live: Date.now() - seen < 45000,
    };
  });
  return { members, connections };
}
export function mcpUrl() {
  return (
    process.env.COLAG_MCP_PUBLIC_URL ||
    `http://${process.env.COLAG_HOST || "127.0.0.1"}:${process.env.COLAG_PORT || 4310}/mcp`
  );
}
export function connectionConfig(url: string, token: string, clientName: string) {
  const header = { Authorization: `Bearer ${token}` };
  return {
    cursor: {
      mcpServers: {
        colag: { url, headers: header },
      },
    },
    claudeCode: {
      mcpServers: {
        colag: { type: "http", url, headers: header },
      },
    },
    label: clientName,
  };
}
export async function createConnection(
  person: User,
  roomId: string,
  rawName: unknown,
) {
  const name = labelOf(rawName, "Client name");
  const token = randomBytes(32).toString("hex");
  const id = randomBytes(16).toString("hex");
  await pool.query(
    "INSERT INTO mcp_connections(id,room_id,user_id,name,token_hash) VALUES($1,$2,$3,$4,$5)",
    [id, roomId, person.id, name, hash(token)],
  );
  const url = mcpUrl();
  return {
    id,
    name,
    url,
    token,
    config: connectionConfig(url, token, name),
  };
}
export async function revokeConnection(
  roomId: string,
  connectionId: string,
  userId: string,
) {
  const r = await pool.query(
    "UPDATE mcp_connections SET revoked_at=now() WHERE id=$1 AND room_id=$2 AND user_id=$3 AND revoked_at IS NULL RETURNING id",
    [connectionId, roomId, userId],
  );
  assert(r.rows[0], "Connection not found", "not_found", 404);
  if (store.redis.isReady) await store.redis.del(`presence:mcp:${connectionId}`);
  return { ok: true };
}
export async function authenticateMcp(token: string | undefined) {
  assert(token, "Connection token required", "unauthorized", 401);
  const r = await pool.query(
    `SELECT c.*, u.display_name FROM mcp_connections c JOIN users u ON u.id=c.user_id
     WHERE c.token_hash=$1`,
    [hash(token)],
  );
  const row = r.rows[0];
  assert(row, "Invalid or revoked connection", "unauthorized", 401);
  assert(!row.revoked_at, "Invalid or revoked connection", "unauthorized", 401);
  await pool.query(
    "UPDATE mcp_connections SET last_seen_at=now() WHERE id=$1",
    [row.id],
  );
  const actor: Actor = {
    id: `mcp:${row.id}`,
    type: "external",
    projectId: row.room_id,
    permissions: [...EXTERNAL_MCP_PERMISSIONS],
    connectionId: row.id,
    clientName: row.name,
    displayName: row.display_name,
  };
  await store.pulse(`mcp:${row.id}`, "live");
  if (store.redis.isReady)
    await store.redis.set(
      `presence:mcp:${row.id}`,
      JSON.stringify({
        status: "live",
        label: `${row.display_name} · ${row.name}`,
        at: new Date().toISOString(),
      }),
      { EX: 45 },
    );
  return actor;
}
async function sendLoginCode(to: string, code: string) {
  const host = process.env.COLAG_SMTP_HOST || "";
  const port = Number(process.env.COLAG_SMTP_PORT || 587);
  const user = process.env.COLAG_SMTP_USER || "";
  const pass = process.env.COLAG_SMTP_PASS || "";
  const from = process.env.COLAG_SMTP_FROM || user;
  assert(from, "COLAG_SMTP_FROM is required when SMTP is configured");
  const body = `Your Colag sign-in code is ${code}. It expires in 10 minutes.`;
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    "Subject: Your Colag sign-in code",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
  await smtpSend({ host, port, user, pass, from, to, message });
}
function smtpSend(opts: {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  to: string;
  message: string;
}) {
  return new Promise<void>((resolve, reject) => {
    const secure = opts.port === 465;
    const socket = secure
      ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host })
      : net.connect({ host: opts.host, port: opts.port });
    let buffer = "";
    let step = 0;
    const fail = (e: Error) => {
      socket.destroy();
      reject(e);
    };
    const send = (line: string) => socket.write(line + "\r\n");
    const next = (line: string) => {
      const code = Number(line.slice(0, 3));
      if (code >= 400) return fail(new Error(line));
      const commands = [
        "EHLO colag",
        opts.user ? "AUTH LOGIN" : `MAIL FROM:<${opts.from}>`,
        opts.user ? Buffer.from(opts.user).toString("base64") : `RCPT TO:<${opts.to}>`,
        opts.user ? Buffer.from(opts.pass).toString("base64") : "DATA",
        opts.user ? `MAIL FROM:<${opts.from}>` : opts.message + "\r\n.",
        opts.user ? `RCPT TO:<${opts.to}>` : "QUIT",
        opts.user ? "DATA" : "",
        opts.user ? opts.message + "\r\n." : "",
        opts.user ? "QUIT" : "",
      ].filter((c, i) => (opts.user ? true : i < 6));
      const command = commands[step];
      step += 1;
      if (!command) return resolve();
      send(command);
      if (command === "QUIT") socket.once("close", () => resolve());
    };
    socket.setTimeout(15000, () => fail(new Error("SMTP timed out")));
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split("\r\n");
      buffer = parts.pop() || "";
      for (const line of parts) if (line && line[3] !== "-") next(line);
    });
  });
}
