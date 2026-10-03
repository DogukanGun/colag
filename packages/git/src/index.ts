import { runProcess } from "../../runtime/src/process.ts";

import {
  cp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  lstat,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { assert } from "../../domain/src/index.ts";

export const root = path.resolve(process.env.COLAG_DATA_DIR || ".colag");
export async function command(
  bin: string,
  args: string[],
  cwd?: string,
  timeout = 30000,
) {
  const result = await runProcess(bin, args, { cwd, timeout });
  if (result.code !== 0)
    throw new Error(
      result.stderr || result.stdout || `${bin} exited ${result.code}`,
    );
  return result.stdout + result.stderr;
}
export async function git(repo: string, ...args: string[]) {
  return (await command("git", args, repo)).trim();
}
export const repoPath = (runId: string) =>
  path.join(root, "runs", runId, "repo");
export const workPath = (runId: string, taskId: string) =>
  path.join(root, "runs", runId, "worktrees", taskId);
export async function createRepository(runId: string) {
  const repo = repoPath(runId);
  await mkdir(repo, { recursive: true });
  await cp(path.resolve("fixtures/sample"), repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "agents@colag.local");
  await git(repo, "config", "user.name", "Colag");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "Initialize disposable authentication app");
  return { repo, baseSha: await git(repo, "rev-parse", "HEAD") };
}
export async function createWorktree(
  runId: string,
  taskId: string,
  base: string,
) {
  const repo = repoPath(runId),
    work = workPath(runId, taskId);
  await mkdir(path.dirname(work), { recursive: true });
  try {
    await lstat(work);
    return work;
  } catch {}
  await git(repo, "worktree", "add", "-b", `colag/${taskId}`, work, base);
  return work;
}
export async function safePath(
  work: string,
  relative: string,
  writing = false,
) {
  assert(
    relative &&
      !path.isAbsolute(relative) &&
      !relative
        .split(/[\\/]/)
        .some(
          (x) =>
            x === ".." ||
            x === ".git" ||
            x === ".env" ||
            x === ".claude" ||
            x === "node_modules",
        ),
    "Path is outside the allowed workspace",
    "forbidden",
    403,
  );
  const base = await realpath(work);
  const resolved = path.resolve(base, relative);
  assert(
    resolved.startsWith(base + path.sep),
    "Invalid path",
    "forbidden",
    403,
  );
  let check = resolved;
  while (check !== base) {
    try {
      const s = await lstat(check);
      assert(!s.isSymbolicLink(), "Symlinks are not allowed", "forbidden", 403);
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      if (!writing && check === resolved) throw e;
    }
    check = path.dirname(check);
  }
  return resolved;
}
export async function files(work: string, dir = ""): Promise<string[]> {
  const result: string[] = [];
  for (const e of await readdir(path.join(work, dir), {
    withFileTypes: true,
  })) {
    if (
      [".git", "node_modules", ".claude"].includes(e.name) ||
      e.isSymbolicLink()
    )
      continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) result.push(...(await files(work, rel)));
    else result.push(rel);
  }
  return result;
}
export async function readWorkspace(work: string, file: string) {
  return readFile(await safePath(work, file), "utf8");
}
export async function writeWorkspace(
  work: string,
  file: string,
  content: string,
) {
  assert(content.length < 1_000_000, "File too large");
  const target = await safePath(work, file, true);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
export async function commitTask(runId: string, taskId: string) {
  const work = workPath(runId, taskId);
  await git(work, "add", "--all");
  const status = await git(work, "status", "--porcelain");
  if (status) await git(work, "commit", "-m", `Task ${taskId}`);
  else if (
    await git(work, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD").catch(
      () => "",
    )
  )
    await git(work, "cherry-pick", "--skip");
  return {
    sha: await git(work, "rev-parse", "HEAD"),
    branch: `colag/${taskId}`,
    filesChanged: (await git(work, "diff", "--name-only", "main...HEAD"))
      .split("\n")
      .filter(Boolean),
  };
}
export class IntegrationConflict extends Error {
  constructor(
    public details: {
      failedSha: string;
      remainingShas: string[];
      baseSha: string;
      files: string[];
    },
  ) {
    super(
      `Integration conflict in ${details.files.join(", ") || details.failedSha}`,
    );
  }
}
export async function applyConflict(
  runId: string,
  taskId: string,
  details: IntegrationConflict["details"],
) {
  const work = await createWorktree(runId, taskId, details.baseSha);
  const state = await git(work, "status", "--porcelain");
  if (!state) await git(work, "cherry-pick", details.failedSha).catch(() => {});
  return work;
}
export async function integrate(
  runId: string,
  shas: string[],
  baseSha: string,
) {
  const repo = repoPath(runId);
  const work = path.join(root, "runs", runId, "integration");
  try {
    await git(repo, "worktree", "remove", "--force", work);
  } catch {}
  await git(repo, "worktree", "add", "-B", "colag/integration", work, baseSha);
  const ordered = [...new Set(shas)];
  for (const [index, sha] of ordered.entries()) {
    if (sha === baseSha) continue;
    try {
      await git(work, "cherry-pick", sha);
    } catch (e) {
      const conflicts = await git(
        work,
        "diff",
        "--name-only",
        "--diff-filter=U",
      );
      const head = await git(work, "rev-parse", "HEAD");
      await git(work, "cherry-pick", "--abort");
      if (!conflicts) throw e;
      throw new IntegrationConflict({
        failedSha: sha,
        remainingShas: ordered.slice(index + 1),
        baseSha: head,
        files: conflicts.split("\n").filter(Boolean),
      });
    }
  }
  return { work, sha: await git(work, "rev-parse", "HEAD") };
}
export async function diffFiles(runId: string, base: string, sha: string) {
  const repo = repoPath(runId);
  const names = (await git(repo, "diff", "--name-only", base, sha))
    .split("\n")
    .filter(Boolean);
  return Promise.all(
    names.map(async (file) => ({
      file,
      original: await git(repo, "show", `${base}:${file}`).catch(() => ""),
      modified: await git(repo, "show", `${sha}:${file}`).catch(() => ""),
    })),
  );
}
export async function testSandbox(work: string, signal?: AbortSignal) {
  const name = `colag-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const args = [
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
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "-v",
    `${path.resolve(work)}:/workspace:ro`,
    "-w",
    "/workspace",
    "node:22-alpine",
    "node",
    "--test",
    "backend/auth.test.mjs",
  ];
  try {
    const created = await runProcess("docker", args, {
      timeout: 15000,
      signal,
    });
    if (created.code !== 0) throw new Error(created.stderr);
    const started = await runProcess("docker", ["start", name], {
      timeout: 15000,
      signal,
    });
    if (started.code !== 0) throw new Error(started.stderr);
    const waited = await runProcess("docker", ["wait", name], {
      timeout: 120000,
      signal,
    });
    if (waited.code !== 0) throw new Error(waited.stderr);
    const logs = await runProcess("docker", ["logs", name], {
      timeout: 5000,
      signal,
    });
    return {
      passed: waited.stdout.trim() === "0",
      output: logs.stdout + logs.stderr,
    };
  } catch (e: any) {
    throw new Error(
      `Sandbox unavailable: ${e.message}. Check Docker Desktop; generated code was not run on the host.`,
    );
  } finally {
    await runProcess("docker", ["rm", "-f", name], { timeout: 5000 }).catch(
      () => {},
    );
  }
}
