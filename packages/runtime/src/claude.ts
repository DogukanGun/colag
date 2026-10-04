import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { root, command } from "../../git/src/index.ts";
import type { AgentRequest } from "./types.ts";
export type { AgentRequest, ClaudeRequest } from "./types.ts";
type Check = { ok: boolean; detail: string };
/** Claude Code must be installed and signed in on the host. */
export async function preflightClaude(): Promise<Check> {
  try {
    await command(
      process.env.CLAUDE_BIN || "claude",
      ["auth", "status", "--text"],
      undefined,
      10000,
    );
    return { ok: true, detail: "Claude authentication available" };
  } catch {
    return { ok: false, detail: "Run claude auth login in your terminal." };
  }
}
/** Docker, and optionally a real network-isolated container start. */
export async function preflightSandbox(
  options: { sandbox?: boolean } = {},
): Promise<Record<string, Check>> {
  const checks: Record<string, Check> = {};
  try {
    const out = await command(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      undefined,
      10000,
    );
    checks.docker = { ok: true, detail: `Docker ${out.trim()}` };
  } catch {
    checks.docker = {
      ok: false,
      detail: "Start Docker Desktop and wait for the engine.",
    };
  }
  if (options.sandbox && checks.docker?.ok) {
    const { runProcess } = await import("./process.ts");
    const name = `colag-preflight-${Date.now()}`;
    try {
      await command(
        "docker",
        ["image", "inspect", "node:22-alpine"],
        undefined,
        5000,
      );
      await command(
        "docker",
        [
          "create",
          "--name",
          name,
          "--pull",
          "never",
          "--network",
          "none",
          "--memory",
          "128m",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "node:22-alpine",
          "node",
          "-e",
          "process.exit(0)",
        ],
        undefined,
        10000,
      );
      await command("docker", ["start", name], undefined, 15000);
      const exit = await command("docker", ["wait", name], undefined, 10000);
      if (exit.trim() !== "0") throw new Error("Container smoke test failed");
      checks.sandbox = { ok: true, detail: "Container execution verified" };
    } catch (e: any) {
      checks.sandbox = {
        ok: false,
        detail: `Docker cannot start the test sandbox: ${e.message}. Start Docker Desktop, verify node:22-alpine is pulled, then retry.`,
      };
    } finally {
      await runProcess("docker", ["rm", "-f", name], { timeout: 5000 }).catch(
        () => {},
      );
    }
  }
  return checks;
}
/** @deprecated Use preflight from ./index.ts, which honors COLAG_MODEL_PROVIDER. */
export async function preflight(options: { sandbox?: boolean } = {}) {
  const checks = await preflightSandbox(options);
  return { ...checks, claude: await preflightClaude() };
}
export async function runClaude(r: AgentRequest): Promise<any> {
  const dir = path.join(root, "sessions", r.sessionId);
  await mkdir(dir, { recursive: true });
  const config = path.join(dir, "mcp.json");
  await writeFile(
    config,
    JSON.stringify({
      mcpServers: {
        colag: {
          command: process.execPath,
          args: [
            "--import",
            path.resolve("node_modules/tsx/dist/loader.mjs"),
            path.resolve("packages/adapters/src/mcp.ts"),
          ],
          env: {
            COLAG_AGENT_TOKEN: r.token,
            COLAG_API_URL: `http://127.0.0.1:${process.env.COLAG_PORT || 4310}`,
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    config,
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--allowedTools",
    "mcp__colag__*",
    "--max-turns",
    "60",
  ];
  if (r.schema) args.push("--json-schema", JSON.stringify(r.schema));
  const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  delete (env as any).CLAUDECODE;
  return new Promise((resolve, reject) => {
    let buffer = "",
      stderr = "",
      result: any;
    const child = spawn(process.env.CLAUDE_BIN || "claude", args, {
      cwd: dir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      signal: r.signal,
    });
    child.stdin.end(r.prompt);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
          const parsed = JSON.parse(line);
          r.onOutput?.(parsed);
          if (parsed.type === "result") result = parsed;
        } catch {}
      }
    });
    child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-12000)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 || result?.is_error)
        return reject(
          new Error(result?.result || stderr || `Claude exited ${code}`),
        );
      if (!result)
        return reject(new Error("Claude ended without a structured result"));
      resolve(result.structured_output ?? result.result);
    });
  }).finally(() => rm(config, { force: true }));
}
