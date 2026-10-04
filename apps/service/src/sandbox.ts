import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import type { Actor } from "../../../packages/protocol/src/index.ts";
import { DomainError, assert } from "../../../packages/domain/src/index.ts";
import {
  exportCommit,
  git,
  repoPath,
  root,
  zipCommit,
} from "../../../packages/git/src/index.ts";
import { runProcess } from "../../../packages/runtime/src/process.ts";
import { buildTarget } from "./build-target.ts";
import * as store from "./store.ts";

const IDLE_MS = 20 * 60 * 1000;
const require = createRequire(import.meta.url);

type Box = {
  projectId: string;
  runId: string;
  sha: string;
  name: string;
  dir: string;
  shells: number;
  idle?: NodeJS.Timeout;
};

type Ticket = { projectId: string; userId: string; expires: number };

const boxes = new Map<string, Box>();
const tickets = new Map<string, Ticket>();

export async function loadBuild(projectId: string) {
  const runs = (await store.resources(projectId))
    .filter((item) => item.kind === "run" && item.data.baseSha)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const run = runs.at(-1);
  const target = buildTarget(run);
  if (!run || !target) return null;
  const sha =
    target.ref === "candidate"
      ? target.sha
      : await git(repoPath(run.id), "rev-parse", "main");
  const box = boxes.get(projectId);
  return {
    runId: run.id,
    sha,
    ref: target.ref,
    running: !!box && box.sha === sha,
  };
}

export async function hasPurchase(
  projectId: string,
  userId: string,
  sha: string,
) {
  const all = await store.resources(projectId);
  return all.some(
    (item) =>
      item.kind === "purchase" &&
      item.data.sha === sha &&
      item.data.userId === userId,
  );
}

export async function buy(actor: Actor, sha: string) {
  assert(actor.type === "human", "Only a member can buy a build", "forbidden", 403);
  const current = await loadBuild(actor.projectId);
  assert(current && current.sha === sha, "That build is not the current one", "conflict", 409);
  const existing = (await store.resources(actor.projectId)).find(
    (item) =>
      item.kind === "purchase" &&
      item.data.sha === sha &&
      item.data.userId === actor.id,
  );
  if (existing) return existing;
  return store.create(
    "purchase",
    { sha, userId: actor.id },
    "build.bought",
    actor,
  );
}

function containerName(projectId: string) {
  const safe = projectId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 50);
  return `colag-sandbox-${safe || "room"}`;
}

async function docker(args: string[], timeout = 20_000) {
  try {
    const result = await runProcess("docker", args, { timeout });
    if (result.code !== 0)
      throw new Error(result.stderr || result.stdout || `docker ${args[0]} failed`);
    return result;
  } catch (error: any) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "unavailable",
      `Sandbox unavailable: ${error.message}. Check Docker; the build was not run on the host.`,
      503,
    );
  }
}
async function removeContainer(name: string) {
  await runProcess("docker", ["rm", "-f", name], { timeout: 20_000 }).catch(
    () => {},
  );
}

export async function destroy(projectId: string) {
  const box = boxes.get(projectId);
  if (!box) return;
  if (box.idle) clearTimeout(box.idle);
  boxes.delete(projectId);
  await removeContainer(box.name);
}

function armIdle(box: Box) {
  if (box.idle) clearTimeout(box.idle);
  if (box.shells > 0) return;
  box.idle = setTimeout(() => {
    void destroy(box.projectId);
  }, IDLE_MS);
  box.idle.unref?.();
}

export async function ensure(projectId: string, runId: string, sha: string) {
  const existing = boxes.get(projectId);
  if (existing?.sha === sha) {
    await docker(["start", existing.name]);
    return existing;
  }
  if (existing) await destroy(projectId);
  const name = containerName(projectId);
  const dir = path.join(root, "sandboxes", projectId);
  await removeContainer(name);
  try {
    await exportCommit(runId, sha, dir);
    await docker(
      [
        "create",
        "--name",
        name,
        "--pull",
        "never",
        "--network",
        "none",
        "--cpus",
        "1",
        "--memory",
        "512m",
        "--pids-limit",
        "128",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,size=64m",
        "-v",
        `${dir}:/workspace`,
        "-w",
        "/workspace",
        "node:22-alpine",
        "sleep",
        "infinity",
      ],
      60_000,
    );
    await docker(["start", name]);
  } catch (error: any) {
    await removeContainer(name);
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "unavailable",
      `Sandbox unavailable: ${error.message}. Check Docker; the build was not run on the host.`,
      503,
    );
  }
  const box: Box = { projectId, runId, sha, name, dir, shells: 0 };
  boxes.set(projectId, box);
  armIdle(box);
  return box;
}

export function issueTicket(projectId: string, userId: string) {
  const ticket = randomBytes(24).toString("hex");
  tickets.set(ticket, { projectId, userId, expires: Date.now() + 60_000 });
  return ticket;
}

export function takeTicket(ticket: string) {
  const row = tickets.get(ticket);
  tickets.delete(ticket);
  if (!row || row.expires < Date.now()) return null;
  return row;
}

export function streamUrl(projectId: string, ticket: string) {
  const mcp = process.env.COLAG_MCP_PUBLIC_URL;
  const http = mcp
    ? mcp.replace(/\/mcp\/?$/, "")
    : `http://${!process.env.COLAG_HOST || process.env.COLAG_HOST === "0.0.0.0" ? "127.0.0.1" : process.env.COLAG_HOST}:${process.env.COLAG_PORT || 4310}`;
  const ws = http.replace(/^http/, "ws");
  return `${ws}/api/v1/projects/${projectId}/sandbox/stream?ticket=${ticket}`;
}

export function attach(projectId: string, ws: WebSocket) {
  const box = boxes.get(projectId);
  assert(box, "The sandbox is not running", "not_found", 404);
  const pty = require("node-pty") as typeof import("node-pty");
  const helper = path.join(
    path.dirname(require.resolve("node-pty")),
    "..",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  if (existsSync(helper)) chmodSync(helper, 0o755);
  const term = pty.spawn(
    "docker",
    [
      "exec",
      "-it",
      "-e",
      "TERM=xterm-256color",
      "-e",
      "HOME=/tmp",
      "-w",
      "/workspace",
      box.name,
      "/bin/sh",
    ],
    {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: box.dir,
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin",
        HOME: process.env.HOME || "/tmp",
        ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      },
    },
  );
  box.shells += 1;
  armIdle(box);
  let released = false;
  const release = () => {
    if (released || !boxes.get(projectId)) return;
    released = true;
    box.shells = Math.max(0, box.shells - 1);
    armIdle(box);
  };
  term.onData((data) => {
    if (ws.readyState === 1) ws.send(data);
  });
  term.onExit(() => {
    release();
    if (ws.readyState === 1) ws.close();
  });
  ws.on("message", (data, isBinary) => {
    const text = data.toString();
    if (!isBinary) {
      try {
        const message = JSON.parse(text) as { type?: string; cols?: number; rows?: number };
        if (message.type === "resize" && message.cols && message.rows) {
          term.resize(
            Math.max(20, Math.min(240, message.cols)),
            Math.max(5, Math.min(80, message.rows)),
          );
          return;
        }
      } catch {
        /* keyboard text */
      }
    }
    term.write(text);
  });
  ws.on("close", () => {
    release();
    try {
      term.kill();
    } catch {
      /* already exited */
    }
  });
  ws.on("error", () => {
    release();
    try {
      term.kill();
    } catch {
      /* already exited */
    }
  });
}

export function zipStream(runId: string, sha: string) {
  const child = zipCommit(runId, sha);
  assert(child.stdout, "Archive failed");
  return child.stdout;
}

export async function reap() {
  const listed = await runProcess(
    "docker",
    ["ps", "-aq", "--filter", "name=colag-sandbox-"],
    { timeout: 15_000 },
  ).catch(() => null);
  boxes.clear();
  if (!listed || listed.code !== 0) return;
  const ids = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (ids.length)
    await runProcess("docker", ["rm", "-f", ...ids], { timeout: 20_000 }).catch(
      () => {},
    );
}

export async function stopAll() {
  const names = [...boxes.values()].map((box) => box.name);
  for (const box of boxes.values()) if (box.idle) clearTimeout(box.idle);
  boxes.clear();
  if (names.length)
    await runProcess("docker", ["rm", "-f", ...names], { timeout: 20_000 }).catch(
      () => {},
    );
}
