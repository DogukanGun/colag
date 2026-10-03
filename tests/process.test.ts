import { test } from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../packages/runtime/src/process.ts";
test("hard process deadline works even when child ignores SIGTERM", async () => {
  const start = Date.now();
  await assert.rejects(
    () =>
      runProcess(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        { timeout: 150 },
      ),
    /deadline/,
  );
  assert.ok(Date.now() - start < 1500);
});
test("abort terminates the task process and returns promptly", async () => {
  const controller = new AbortController();
  const promise = runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { signal: controller.signal, timeout: 5000 },
  );
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(() => promise, /cancelled/);
});
