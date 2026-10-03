import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  safePath,
  git,
  integrate,
  createRepository,
  createWorktree,
  commitTask,
  root,
  IntegrationConflict,
  applyConflict,
} from "../packages/git/src/index.ts";
import { randomUUID } from "node:crypto";
test("workspace paths reject traversal, protected metadata and symlinks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "colag-path-"));
  try {
    await writeFile(path.join(dir, "ok.txt"), "ok");
    await symlink("/tmp", path.join(dir, "escape"));
    for (const p of [
      "../outside",
      "/etc/passwd",
      ".git/config",
      ".env",
      "escape/secret",
    ])
      await assert.rejects(() => safePath(dir, p, true));
    assert.equal(
      await safePath(dir, "ok.txt"),
      path.join(await realpath(dir), "ok.txt"),
    );
    await safePath(dir, "new/file.txt", true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("isolated worktrees generate real diffs and conflicting branches do not change main", async () => {
  const id = randomUUID();
  try {
    const { repo, baseSha } = await createRepository(id);
    for (const t of ["one", "two"]) {
      const work = await createWorktree(id, t, baseSha);
      await writeFile(
        path.join(work, "backend/auth.mjs"),
        `export const variant = '${t}';\n`,
      );
    }
    const one = await commitTask(id, "one"),
      two = await commitTask(id, "two");
    let conflict: IntegrationConflict | undefined;
    try {
      await integrate(id, [one.sha, two.sha], baseSha);
    } catch (e) {
      assert.ok(e instanceof IntegrationConflict);
      conflict = e;
    }
    assert.ok(conflict);
    const repair = await applyConflict(id, "repair", conflict.details);
    await writeFile(
      path.join(repair, "backend/auth.mjs"),
      "export const variant = 'resolved';\n",
    );
    const fixed = await commitTask(id, "repair");
    const resolved = await integrate(
      id,
      conflict.details.remainingShas,
      fixed.sha,
    );
    assert.match(
      await git(resolved.work, "show", "HEAD:backend/auth.mjs"),
      /resolved/,
    );
    assert.equal(await git(repo, "rev-parse", "main"), baseSha);
    const clean = await integrate(id, [one.sha], baseSha);
    assert.notEqual(clean.sha, baseSha);
  } finally {
    await rm(path.join(root, "runs", id), { recursive: true, force: true });
  }
});
