export interface AgentRequest {
  sessionId: string;
  prompt: string;
  token: string;
  signal: AbortSignal;
  schema?: object;
  onOutput?: (line: any) => void;
}
/** Kept for callers that still import the Claude-specific name. */
export type ClaudeRequest = AgentRequest;
export type ModelProvider = "claude" | "openai";
export function modelProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const value = (env.COLAG_MODEL_PROVIDER || "claude").toLowerCase();
  if (value === "claude" || value === "openai") return value;
  throw new Error(
    `COLAG_MODEL_PROVIDER must be "claude" or "openai", got "${value}"`,
  );
}
