import { preflightClaude, runClaude, preflightSandbox } from "./claude.ts";
import { preflightOpenAI, runOpenAI } from "./openai.ts";
import { modelProvider, type AgentRequest } from "./types.ts";
export type { AgentRequest, ClaudeRequest, ModelProvider } from "./types.ts";
export { modelProvider } from "./types.ts";
export { runClaude } from "./claude.ts";
export { runOpenAI, modelConfig, toolDefinitions } from "./openai.ts";

export type Checks = Record<string, { ok: boolean; detail: string }>;
/**
 * Readiness for the configured model provider plus the Docker sandbox.
 * The check is keyed "model" so the UI and the engine do not depend on which
 * provider is active.
 */
export async function preflight(options: { sandbox?: boolean } = {}): Promise<Checks> {
  const checks: Checks = {};
  let provider;
  try {
    provider = modelProvider();
  } catch (e: any) {
    checks.model = { ok: false, detail: e.message };
  }
  const [sandbox, model] = await Promise.all([
    preflightSandbox(options),
    provider === "openai"
      ? preflightOpenAI()
      : provider === "claude"
        ? preflightClaude()
        : Promise.resolve(undefined),
  ]);
  Object.assign(checks, sandbox);
  if (model) checks.model = model;
  return checks;
}
export async function runAgent(r: AgentRequest): Promise<any> {
  return modelProvider() === "openai" ? runOpenAI(r) : runClaude(r);
}
