/**
 * Demo videos of the app a room builds.
 *
 * The room's coder (over MCP) or a member writes a script: the npm script that starts the app, then steps (goto, click,
 * type, …) with one voice line each. A render:
 *   1. exports the room's current build (candidate, or main once merged),
 *   2. installs its dependencies in a throwaway container (the only step with network; lifecycle scripts never run),
 *   3. starts the app in a container without network,
 *   4. records it from the recorder image, which shares only the app's loopback: headless Chromium + ffmpeg,
 *      voice-over (spoken here with xAI, so the key never enters a container), music bed, e-mail kit,
 *   5. keeps the files under .colag/demos and publishes a video artifact in the room.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile, copyFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Actor, Entity } from "../../../packages/protocol/src/index.ts";
import { DomainError, assert, authorize } from "../../../packages/domain/src/index.ts";
import {
  missingScripts,
  parseSpec,
  settingsSchema,
  issues,
  type DemoSpec,
} from "../../../packages/protocol/src/demo.ts";
import { exportCommit, git, repoPath, root } from "../../../packages/git/src/index.ts";
import { runProcess } from "../../../packages/runtime/src/process.ts";
import { redact, speak } from "../../../packages/runtime/src/tts.ts";
import { loadBuild } from "./sandbox.ts";
import * as store from "./store.ts";

export const DEMO_FILES = ["video.mp4", "preview.gif", "thumbnail.png", "subtitles.srt", "fail.png"] as const;
const CONTENT_TYPES: Record<string, string> = {
  "video.mp4": "video/mp4",
  "preview.gif": "image/gif",
  "thumbnail.png": "image/png",
  "fail.png": "image/png",
  "subtitles.srt": "application/x-subrip; charset=utf-8",
};
const ACTIVE = ["queued", "rendering"];
const RENDER_TIMEOUT_MS = Number(process.env.COLAG_DEMO_TIMEOUT_MS || 10 * 60 * 1000);
const recorderImage = () => process.env.COLAG_DEMO_RECORDER_IMAGE || "colag-demo-recorder";
const dailyLimit = () => Number(process.env.COLAG_DEMO_DAILY_LIMIT || 10);
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 60) || "x";
export const demoDir = (projectId: string, demoId: string) => path.join(root, "demos", safe(projectId), safe(demoId));

type Progress = { phase: string; step?: number; of?: number };
export type RenderJob = {
  demo: Entity;
  dir: string;
  appDir: string;
  jobDir: string;
  outDir: string;
  spec: DemoSpec;
  onProgress: (p: Progress) => void;
  signal: AbortSignal;
};
export type RenderResult = { ok: boolean; duration?: number; files?: string[]; step?: number; action?: string; target?: string; error?: string };

// ── runtime (replaceable in tests) ───────────────────────────────────────────────────────────────────────────
const runtime = {
  speak,
  install: installDependencies,
  record: recordInContainers,
};
export function configureDemoRuntime(overrides: Partial<typeof runtime>) {
  assert(process.env.NODE_ENV === "test", "Test runtime is disabled outside tests");
  Object.assign(runtime, overrides);
}

// ── room actions (MCP tools and REST routes) ─────────────────────────────────────────────────────────────────
function invalid(errors: string[]): never {
  throw new DomainError("invalid_demo", `The demo script needs changes: ${errors.join("; ")}`, 400);
}

function view(demo: Entity) {
  const d = demo.data;
  const base = `/api/v1/projects/${demo.projectId}/demos/${demo.id}/files`;
  return {
    id: demo.id,
    title: d.title,
    language: d.language,
    music: d.music,
    emailKit: d.emailKit,
    status: d.status,
    sha: d.sha ?? null,
    progress: d.progress ?? null,
    error: d.error ?? null,
    duration: d.duration ?? null,
    files: Object.fromEntries((d.files ?? []).map((f: string) => [f, `${base}/${f}`])),
    artifactId: d.artifactId ?? null,
    steps: d.spec?.steps?.length ?? 0,
    spec: d.spec,
    updatedAt: demo.updatedAt,
  };
}

async function demoOf(actor: Actor, id: string) {
  const demo = await store.get(id);
  assert(demo.kind === "demo" && demo.projectId === actor.projectId && !demo.data.deleted, "Demo not found", "not_found", 404);
  return demo;
}

export async function listDemos(actor: Actor) {
  authorize(actor, actor.projectId, "project.read");
  return (await store.resources(actor.projectId))
    .filter((r) => r.kind === "demo" && !r.data.deleted)
    .map(view)
    .reverse();
}

export async function getDemo(actor: Actor, id: string) {
  authorize(actor, actor.projectId, "project.read");
  return view(await demoOf(actor, id));
}

export async function createDemo(actor: Actor, input: any) {
  authorize(actor, actor.projectId, "demo.write");
  const settings = settingsSchema.safeParse({
    title: input?.title,
    language: input?.language,
    music: input?.music,
    emailKit: input?.emailKit,
  });
  if (!settings.success) invalid(issues(settings.error));
  const parsed = parseSpec(input?.spec);
  if (!parsed.ok) invalid(parsed.errors);
  const build = await loadBuild(actor.projectId);
  assert(build, "Nothing has been built yet: a demo films the room's current build", "not_found", 404);
  const demo = await store.create(
    "demo",
    {
      ...settings.data,
      spec: parsed.spec,
      status: "draft",
      createdBy: actor.id,
      createdByName: actor.displayName || actor.clientName || actor.type,
      renders: [],
    },
    "demo.created",
    actor,
  );
  return view(demo);
}

export async function updateDemo(actor: Actor, id: string, input: any) {
  authorize(actor, actor.projectId, "demo.write");
  const demo = await demoOf(actor, id);
  assert(!ACTIVE.includes(demo.data.status), "The demo is rendering; wait until it is done", "conflict", 409);
  const settings = settingsSchema.partial().safeParse(
    Object.fromEntries(Object.entries({ title: input?.title, language: input?.language, music: input?.music, emailKit: input?.emailKit }).filter(([, v]) => v !== undefined)),
  );
  if (!settings.success) invalid(issues(settings.error));
  const patch: Record<string, any> = { ...settings.data, status: "draft", error: null, progress: null };
  if (input?.spec !== undefined) {
    const parsed = parseSpec(input.spec);
    if (!parsed.ok) invalid(parsed.errors);
    patch.spec = parsed.spec;
  }
  return view(await store.update(id, patch, "demo.updated", actor));
}

export async function deleteDemo(actor: Actor, id: string) {
  authorize(actor, actor.projectId, "demo.write");
  const demo = await demoOf(actor, id);
  assert(!ACTIVE.includes(demo.data.status), "The demo is rendering; wait until it is done", "conflict", 409);
  await rm(demoDir(demo.projectId, demo.id), { recursive: true, force: true });
  await store.update(id, { deleted: true, files: [] }, "demo.deleted", actor);
}

/** The app's npm scripts at the build being filmed. */
async function appScripts(runId: string, sha: string): Promise<Record<string, string> | undefined> {
  try {
    return JSON.parse(await git(repoPath(runId), "show", `${sha}:package.json`)).scripts;
  } catch {
    return undefined;
  }
}

export async function rendersToday(projectId: string, now = Date.now()) {
  return (await store.resources(projectId))
    .filter((r) => r.kind === "demo")
    .flatMap((r) => (r.data.renders ?? []) as string[])
    .filter((at) => now - Date.parse(at) < 24 * 3600 * 1000).length;
}

export async function queueRender(actor: Actor, id: string) {
  authorize(actor, actor.projectId, "demo.render");
  const demo = await demoOf(actor, id);
  assert(!ACTIVE.includes(demo.data.status), "This demo is already rendering", "conflict", 409);
  const all = await store.resources(actor.projectId);
  assert(
    !all.some((r) => r.kind === "demo" && !r.data.deleted && ACTIVE.includes(r.data.status)),
    "Another demo of this room is rendering; one at a time",
    "conflict",
    409,
  );
  const limit = dailyLimit();
  assert((await rendersToday(actor.projectId)) < limit, `This room has rendered ${limit} demos today; try again tomorrow`, "rate_limited", 429);
  const build = await loadBuild(actor.projectId);
  assert(build, "Nothing has been built yet", "not_found", 404);
  const missing = missingScripts(demo.data.spec, await appScripts(build.runId, build.sha));
  if (missing.length)
    invalid(missing.map((s) => `the app has no npm script "${s}" (package.json at ${build.sha.slice(0, 8)})`));
  const updated = await store.update(
    id,
    {
      status: "queued",
      sha: build.sha,
      ref: build.ref,
      runId: build.runId,
      progress: { phase: "queued" },
      error: null,
      files: [],
      renders: [...(demo.data.renders ?? []), new Date().toISOString()],
      requestedBy: actor.id,
    },
    "demo.queued",
    actor,
  );
  queue.push(id);
  void pump();
  return view(updated);
}

export async function demoFile(actor: Actor, id: string, name: string) {
  authorize(actor, actor.projectId, "project.read");
  assert((DEMO_FILES as readonly string[]).includes(name), "File not found", "not_found", 404);
  const demo = await demoOf(actor, id);
  assert((demo.data.files ?? []).includes(name), "File not found", "not_found", 404);
  const file = path.join(demoDir(demo.projectId, demo.id), "out", name);
  const info = await stat(file).catch(() => null);
  assert(info, "File not found", "not_found", 404);
  const ext = path.extname(name);
  const base = (demo.data.title || "demo").replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/\s+/g, "-").slice(0, 60) || "demo";
  return { file, size: info.size, type: CONTENT_TYPES[name], download: `${base}${name === "video.mp4" ? "" : "-" + name.replace(ext, "")}${ext}` };
}

// ── the queue ─────────────────────────────────────────────────────────────────────────────────────────────────
const queue: string[] = [];
let busy = false;
const controllers = new Map<string, AbortController>();

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      await renderDemo(id).catch(() => {});
    }
  } finally {
    busy = false;
  }
}

/** Resolves when the queue is empty (tests). */
export async function idle() {
  while (busy || queue.length) await new Promise((r) => setTimeout(r, 20));
}

async function system(projectId: string): Promise<Actor> {
  return store.systemActor(projectId);
}

export async function renderDemo(id: string) {
  const demo = await store.get(id);
  if (demo.data.status !== "queued") return;
  const actor = await system(demo.projectId);
  const dir = demoDir(demo.projectId, demo.id);
  const job: RenderJob = {
    demo,
    dir,
    appDir: path.join(dir, "app"),
    jobDir: path.join(dir, "job"),
    outDir: path.join(dir, "out"),
    spec: demo.data.spec,
    signal: new AbortController().signal,
    onProgress: () => {},
  };
  const controller = new AbortController();
  controllers.set(id, controller);
  const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  timer.unref?.();
  job.signal = controller.signal;
  let last = "";
  job.onProgress = (p) => {
    const key = `${p.phase}|${p.step ?? ""}`;
    if (key === last) return;
    last = key;
    void store.update(id, { progress: p }, "demo.progress", actor).catch(() => {});
  };
  try {
    await store.update(id, { status: "rendering", progress: { phase: "preparing" } }, "demo.rendering", actor);
    await rm(dir, { recursive: true, force: true });
    await mkdir(job.outDir, { recursive: true });

    await prepareJob(job, demo.data as Settings);

    job.onProgress({ phase: "exporting" });
    await exportCommit(demo.data.runId, demo.data.sha, job.appDir);
    job.onProgress({ phase: "installing" });
    await runtime.install(job);
    const result = await runtime.record(job);
    if (!result.ok) {
      const where = result.step ? `Step ${result.step} (${result.action}${result.target ? ` ${result.target}` : ""}): ` : "";
      const files = existsSync(path.join(job.outDir, "fail.png")) ? ["fail.png"] : [];
      await store.update(id, { status: "failed", error: redact(`${where}${result.error || "the recording failed"}`).slice(0, 1000), failedStep: result.step ?? null, files, progress: null }, "demo.failed", actor);
      return;
    }
    const files = (result.files ?? []).filter((f) => (DEMO_FILES as readonly string[]).includes(f) && existsSync(path.join(job.outDir, f)));
    assert(files.includes("video.mp4"), "The recorder produced no video");
    const artifact = await store.create(
      "artifact",
      {
        name: `Demo video: ${demo.data.title}`,
        artifactType: "video",
        demoId: demo.id,
        content: JSON.stringify({ demoId: demo.id, title: demo.data.title, language: demo.data.language, duration: result.duration, files, sha: demo.data.sha }, null, 2),
        runId: demo.data.runId,
        createdBy: demo.data.requestedBy || demo.data.createdBy,
      },
      "artifact.created",
      actor,
    );
    await store.update(id, { status: "ready", files, duration: result.duration ?? null, artifactId: artifact.id, progress: null, error: null, renderedAt: new Date().toISOString() }, "demo.ready", actor);
  } catch (e: any) {
    const message = controller.signal.aborted ? `The render took longer than ${Math.round(RENDER_TIMEOUT_MS / 60000)} minutes` : e?.message || String(e);
    await store.update(id, { status: "failed", error: redact(message).slice(0, 600), progress: null }, "demo.failed", actor).catch(() => {});
  } finally {
    clearTimeout(timer);
    controllers.delete(id);
    await rm(job.appDir, { recursive: true, force: true }).catch(() => {});
    await rm(job.jobDir, { recursive: true, force: true }).catch(() => {});
    await removeContainers(demo.id);
  }
}

type Settings = { title: string; language: "en" | "de"; music: boolean; emailKit: boolean };

/** Speaks the voice lines (here, so the xAI key never enters a container) and writes job.json for the recorder. */
export async function prepareJob(job: RenderJob, settings: Settings) {
  await mkdir(path.join(job.jobDir, "voice"), { recursive: true });
  job.onProgress({ phase: "voice" });
  const clips = [];
  for (const [step, s] of job.spec.steps.entries()) {
    if (!s.say?.trim()) continue;
    const cached = await runtime.speak(s.say.trim(), { language: settings.language, cacheDir: path.join(root, "voice-cache") });
    const file = `voice/${String(step).padStart(2, "0")}${path.extname(cached)}`;
    await copyFile(cached, path.join(job.jobDir, file));
    clips.push({ step, file, text: s.say.trim() });
  }
  await writeFile(
    path.join(job.jobDir, "job.json"),
    JSON.stringify({
      appUrl: `http://127.0.0.1:${job.spec.app.port}`,
      title: settings.title,
      language: settings.language,
      music: settings.music,
      emailKit: settings.emailKit,
      tempo: 1.08,
      spec: job.spec,
      clips,
    }),
  );
}

/** After a restart: renders that were cut off are marked failed (they can be started again). */
export async function recoverDemos() {
  const rows = await (await import("../../../packages/database/src.ts")).pool.query(
    "SELECT id, project_id FROM resources WHERE kind='demo' AND data->>'status' IN ('queued','rendering')",
  );
  for (const row of rows.rows)
    await store
      .update(row.id, { status: "failed", error: "The service restarted during the render; start it again", progress: null }, "demo.failed", store.systemActor(row.project_id))
      .catch(() => {});
  const listed = await runProcess("docker", ["ps", "-aq", "--filter", "name=colag-demo-"], { timeout: 15_000 }).catch(() => null);
  const ids = listed?.code === 0 ? listed.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  if (ids.length) await runProcess("docker", ["rm", "-f", ...ids], { timeout: 20_000 }).catch(() => {});
}

export async function stopDemos() {
  for (const c of controllers.values()) c.abort();
}

// ── containers ────────────────────────────────────────────────────────────────────────────────────────────────
const names = (demoId: string) => ({ install: `colag-demo-${safe(demoId)}-install`, app: `colag-demo-${safe(demoId)}-app`, rec: `colag-demo-${safe(demoId)}-rec` });

async function removeContainers(demoId: string) {
  const n = names(demoId);
  await runProcess("docker", ["rm", "-f", n.install, n.app, n.rec], { timeout: 20_000 }).catch(() => {});
}

function user() {
  return typeof process.getuid === "function" ? ["--user", `${process.getuid()}:${process.getgid!()}`] : [];
}

const hardening = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=256m", "-e", "HOME=/tmp"];

async function docker(args: string[], timeout: number, signal: AbortSignal, what: string) {
  const r = await runProcess("docker", args, { timeout, signal }).catch((e: any) => {
    throw new DomainError("unavailable", `${what}: ${e.message}. Check Docker on the server.`, 503);
  });
  if (r.code !== 0) throw new DomainError("render_failed", `${what}: ${(r.stderr || r.stdout).trim().split("\n").slice(-4).join(" ")}`, 500);
  return r;
}

/** npm install in a throwaway container: the only step with network, and lifecycle scripts never run. */
export async function installDependencies(job: RenderJob) {
  if (!existsSync(path.join(job.appDir, "package.json"))) return;
  const cache = path.join(root, "npm-cache");
  await mkdir(cache, { recursive: true });
  const lock = existsSync(path.join(job.appDir, "package-lock.json"));
  await docker(
    ["run", "--rm", "--name", names(job.demo.id).install, "--pull", "never", ...user(), ...hardening,
      "--cpus", "1", "--memory", "1g", "--pids-limit", "256",
      "-v", `${job.appDir}:/workspace`, "-v", `${cache}:/npm-cache`, "-w", "/workspace", "-e", "npm_config_cache=/npm-cache",
      "node:22-alpine", "npm", lock ? "ci" : "install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
    180_000,
    job.signal,
    "Installing the app's dependencies failed",
  );
}

/** The app (no network) and the recorder, which joins only the app's loopback. */
export async function recordInContainers(job: RenderJob): Promise<RenderResult> {
  const n = names(job.demo.id);
  const app = job.spec.app;
  const start = app.api ? `npm run ${app.api.start} & npm run ${app.start} & wait` : `npm run ${app.start}`;
  await docker(
    ["run", "-d", "--name", n.app, "--pull", "never", "--network", "none", ...user(), ...hardening,
      "--cpus", "1", "--memory", "1g", "--pids-limit", "256",
      "-v", `${job.appDir}:/workspace`, "-w", "/workspace", "-e", "BROWSER=none", "-e", "CI=1",
      "node:22-alpine", "sh", "-c", start],
    60_000,
    job.signal,
    "Starting the app failed",
  );
  return new Promise<RenderResult>((resolve, reject) => {
    const child = spawn(
      "docker",
      ["run", "--rm", "--name", n.rec, "--pull", "never", "--network", `container:${n.app}`, ...user(),
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
        "--tmpfs", "/tmp:rw,nosuid,size=512m", "--shm-size", "1g", "-e", "HOME=/tmp",
        "--cpus", "2", "--memory", "3g", "--pids-limit", "512",
        "-v", `${job.jobDir}:/job:ro`, "-v", `${job.outDir}:/out`, recorderImage()],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines)
        if (line.startsWith("@@progress "))
          try {
            job.onProgress(JSON.parse(line.slice(11)));
          } catch {
            /* not progress */
          }
    });
    child.stderr.on("data", (chunk) => {
      err = (err + chunk).slice(-4000);
    });
    const abort = () => {
      void runProcess("docker", ["rm", "-f", n.rec], { timeout: 20_000 }).catch(() => {});
      child.kill("SIGKILL");
    };
    job.signal.addEventListener("abort", abort, { once: true });
    child.on("error", (e) => reject(new DomainError("unavailable", `The recorder could not start: ${e.message}`, 503)));
    child.on("close", async () => {
      job.signal.removeEventListener("abort", abort);
      if (job.signal.aborted) return reject(new Error("aborted"));
      const resultFile = path.join(job.outDir, "result.json");
      if (!existsSync(resultFile)) {
        const appLog = await runProcess("docker", ["logs", "--tail", "15", n.app], { timeout: 10_000 }).catch(() => null);
        return resolve({ ok: false, error: `The recorder stopped without a result. ${err.trim().split("\n").slice(-3).join(" ")} ${appLog ? `App log: ${(appLog.stdout + appLog.stderr).trim().split("\n").slice(-5).join(" ")}` : ""}`.trim() });
      }
      try {
        const result = JSON.parse(readFileSync(resultFile, "utf8")) as RenderResult;
        if (!result.ok && /did not start/.test(result.error || "")) {
          const appLog = await runProcess("docker", ["logs", "--tail", "15", n.app], { timeout: 10_000 }).catch(() => null);
          if (appLog) result.error += ` App log: ${(appLog.stdout + appLog.stderr).trim().split("\n").slice(-6).join(" ")}`;
        }
        resolve(result);
      } catch (e: any) {
        reject(e);
      }
    });
  });
}

/** Lists what a render left behind (CLI and tests). */
export async function outFiles(projectId: string, demoId: string) {
  return readdir(path.join(demoDir(projectId, demoId), "out")).catch(() => [] as string[]);
}
