import { spawn } from "node:child_process";
export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
}
/** A hard deadline independent of a child's signal handlers or inherited pipes. */
export function runProcess(
  bin: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Execution cancelled"));
      return;
    }
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "",
      settled = false;
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = (error?: Error, code = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) {
        kill();
        reject(error);
      } else resolve({ stdout, stderr, code });
    };
    const abort = () => finish(new Error("Execution cancelled"));
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `${bin} exceeded its ${options.timeout || 30000}ms deadline`,
          ),
        ),
      options.timeout || 30000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (b) => {
      stdout += b;
      if (stdout.length > 8_000_000)
        finish(new Error("Process output exceeded limit"));
    });
    child.stderr.on("data", (b) => {
      stderr = (stderr + b).slice(-1_000_000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(undefined, code ?? 1));
  });
}
