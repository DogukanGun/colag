import { tools as catalog } from "../../adapters/src/catalog.ts";
import { callTool } from "../../adapters/src/tool-client.ts";
import { fieldsToJsonSchema } from "./json-schema.ts";
import type { AgentRequest } from "./types.ts";

/**
 * Drives a Colag agent against any OpenAI-compatible chat endpoint
 * (Nebius Token Factory, a vLLM server on AMD Developer Cloud, a local
 * server). The model only sees Colag's tool catalog, and every tool call goes
 * through the same authorized HTTP tool endpoint the MCP bridge uses.
 *
 * Output lines mirror the Claude Code stream-json shapes the engine already
 * consumes: {type:"system",subtype:"init"}, {type:"assistant",message},
 * {type:"result"}.
 */
export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTurns: number;
  requestTimeoutMs: number;
  api: string;
}
export function modelConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const baseUrl = (env.COLAG_MODEL_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl)
    throw new Error(
      "COLAG_MODEL_BASE_URL is required when COLAG_MODEL_PROVIDER=openai",
    );
  const model = env.COLAG_MODEL_NAME || "";
  if (!model)
    throw new Error("COLAG_MODEL_NAME is required when COLAG_MODEL_PROVIDER=openai");
  return {
    baseUrl,
    apiKey: env.COLAG_MODEL_API_KEY || "",
    model,
    maxTurns: Number(env.COLAG_MODEL_MAX_TURNS || 60),
    requestTimeoutMs: Number(env.COLAG_MODEL_REQUEST_TIMEOUT_MS || 180000),
    api: env.COLAG_API_URL || `http://127.0.0.1:${env.COLAG_PORT || 4310}`,
  };
}
export function toolDefinitions() {
  return catalog.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: fieldsToJsonSchema(tool.schema),
    },
  }));
}
const SYSTEM = [
  "You are a coding agent inside Colag, a shared room where people and agents build one product.",
  "Use only the provided tools to inspect and change the room. Never invent tool results.",
  "When a tool returns an error, read it and adapt instead of retrying the identical call.",
  "When your work is complete, answer with a short plain summary and stop calling tools.",
].join(" ");
export async function preflightOpenAI(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; detail: string }> {
  let config: ModelConfig;
  try {
    config = modelConfig(env);
  } catch (e: any) {
    return { ok: false, detail: e.message };
  }
  try {
    const r = await fetch(`${config.baseUrl}/models`, {
      headers: authHeaders(config),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok)
      return {
        ok: false,
        detail: `Model endpoint ${config.baseUrl} answered ${r.status}. Check COLAG_MODEL_BASE_URL and COLAG_MODEL_API_KEY.`,
      };
    const body: any = await r.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body?.data)
      ? body.data.map((m: any) => m.id).filter(Boolean)
      : [];
    if (ids.length && !ids.includes(config.model))
      return {
        ok: false,
        detail: `Model ${config.model} is not served at ${config.baseUrl}. Available: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", …" : ""}`,
      };
    return {
      ok: true,
      detail: `Model ${config.model} reachable at ${new URL(config.baseUrl).host}`,
    };
  } catch (e: any) {
    return {
      ok: false,
      detail: `Model endpoint ${config.baseUrl} unreachable: ${e.message}`,
    };
  }
}
function authHeaders(config: ModelConfig) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return headers;
}
interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
async function complete(
  config: ModelConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const r = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ model: config.model, ...body }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)]),
  });
  const text = await r.text();
  if (!r.ok)
    throw new Error(
      `${config.model} at ${new URL(config.baseUrl).host} answered ${r.status}: ${text.slice(0, 600)}`,
    );
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Model returned a non-JSON completion: ${text.slice(0, 300)}`);
  }
  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error("Model completion had no message");
  return { message, usage: data.usage as Usage | undefined };
}
function parseArguments(raw: unknown) {
  if (raw == null || raw === "") return {};
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { __malformed_arguments: raw };
  }
}
/** Mirrors Claude's assistant line so engine.assistantText keeps working. */
function assistantLine(message: any) {
  const content: any[] = [];
  if (typeof message.content === "string" && message.content)
    content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls || [])
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name,
      input: parseArguments(call.function?.arguments),
    });
  return { type: "assistant", message: { role: "assistant", content } };
}
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [trimmed, fenced?.[1]?.trim()].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {}
  }
  const start = trimmed.indexOf("{"),
    end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }
  throw new Error("Model did not return the requested JSON");
}
export async function runOpenAI(
  r: AgentRequest,
  config: ModelConfig = modelConfig(),
): Promise<any> {
  const tools = toolDefinitions();
  const messages: any[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: r.schema
        ? `${r.prompt}\n\nWhen finished, reply with only a JSON object matching this schema:\n${JSON.stringify(r.schema)}`
        : r.prompt,
    },
  ];
  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const add = (u?: Usage) => {
    if (!u) return;
    usage.prompt_tokens += u.prompt_tokens || 0;
    usage.completion_tokens += u.completion_tokens || 0;
    usage.total_tokens += u.total_tokens || 0;
  };
  r.onOutput?.({
    type: "system",
    subtype: "init",
    provider: "openai",
    model: config.model,
    base_url: config.baseUrl,
    tools: tools.map((t) => t.function.name),
  });
  let final: any = null;
  for (let turn = 0; turn < config.maxTurns; turn++) {
    if (r.signal.aborted) throw new Error("Execution cancelled");
    const { message, usage: u } = await complete(
      config,
      { messages, tools, tool_choice: "auto", temperature: 0.2 },
      r.signal,
    );
    add(u);
    r.onOutput?.(assistantLine(message));
    messages.push({
      role: "assistant",
      content: message.content ?? null,
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    });
    if (!message.tool_calls?.length) {
      final = message;
      break;
    }
    for (const call of message.tool_calls) {
      const name = call.function?.name;
      const known = catalog.some((t) => t.name === name);
      const args = parseArguments(call.function?.arguments);
      let result: unknown;
      if (!known) result = { error: `Unknown tool ${name}`, code: "unknown_tool" };
      else {
        const res = await callTool(config.api, r.token, name, args, r.signal);
        result = res.ok
          ? res.data
          : { error: (res.data as any)?.error || res.data, code: (res.data as any)?.code || "tool_error", status: res.status };
      }
      r.onOutput?.({ type: "tool_result", tool_use_id: call.id, name, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 60000),
      });
    }
  }
  if (!final)
    throw new Error(
      `${config.model} did not finish within ${config.maxTurns} turns`,
    );
  const text = typeof final.content === "string" ? final.content : "";
  let output: unknown = text;
  if (r.schema) {
    try {
      output = extractJson(text);
    } catch {
      // One formatting pass without tools, for servers that reject
      // response_format alongside tools.
      const { message, usage: u } = await complete(
        config,
        {
          messages: [
            ...messages,
            {
              role: "user",
              content:
                "Reply with only the JSON object described earlier. No prose, no code fence.",
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "result", schema: r.schema },
          },
        },
        r.signal,
      ).catch(() =>
        complete(
          config,
          {
            messages: [
              ...messages,
              {
                role: "user",
                content:
                  "Reply with only the JSON object described earlier. No prose, no code fence.",
              },
            ],
          },
          r.signal,
        ),
      );
      add(u);
      r.onOutput?.(assistantLine(message));
      output = extractJson(typeof message.content === "string" ? message.content : "");
    }
  }
  r.onOutput?.({
    type: "result",
    subtype: "success",
    is_error: false,
    provider: "openai",
    model: config.model,
    usage,
    result: text,
    structured_output: r.schema ? output : undefined,
  });
  return output;
}
