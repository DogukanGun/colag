import { tools as catalog } from "../../adapters/src/catalog.ts";
import { callTool } from "../../adapters/src/tool-client.ts";
import { fieldsToJsonSchema, schemaProblems } from "./json-schema.ts";
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
  maxRetries: number;
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
    maxRetries: Number(env.COLAG_MODEL_MAX_RETRIES ?? 5),
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
/** Rate limits (429) and overloaded upstreams (502/503/504) are worth waiting out; a shared team key hits them often. */
function retryable(status: number) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}
export function retryDelay(retryAfter: string | null, attempt: number) {
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds)) return Math.min(seconds * 1000, 60000);
  const date = retryAfter ? Date.parse(retryAfter) : NaN;
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 60000);
  return Math.min(1000 * 2 ** attempt, 30000) + Math.floor(Math.random() * 250);
}
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function complete(
  config: ModelConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  let r: Response, text: string;
  for (let attempt = 0; ; attempt++) {
    r = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: authHeaders(config),
      body: JSON.stringify({ model: config.model, ...body }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)]),
    });
    text = await r.text();
    if (!retryable(r.status) || attempt >= config.maxRetries) break;
    await sleep(retryDelay(r.headers.get("retry-after"), attempt), signal);
  }
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
function structuredProblems(text: string, schema: object): string[] {
  let value: unknown;
  try {
    value = extractJson(text);
  } catch {
    return ["it is not a JSON object"];
  }
  const v = value as any;
  if (v && typeof v === "object" && v.type === "object" && v.properties && typeof v.properties === "object")
    return ["it repeats the JSON Schema instead of filling it in"];
  return schemaProblems(value, schema);
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
        ? `${r.prompt}\n\nWhen finished, reply with only a JSON object whose content follows this JSON Schema. Fill in real values; do not repeat the schema itself:\n${JSON.stringify(r.schema)}`
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
    let problems = structuredProblems(text, r.schema);
    let reply = text;
    // Up to two formatting passes without tools. Each names what was wrong,
    // and response_format falls back from json_schema to json_object to none
    // for servers that support less.
    const history = [...messages];
    for (let pass = 0; problems.length && pass < 2; pass++) {
      if (pass > 0) history.push({ role: "assistant", content: reply });
      const ask = [
        ...history,
        {
          role: "user",
          content:
            `That reply is not the requested result: ${problems.slice(0, 12).join("; ")}. ` +
            "Reply with only the JSON object, filled in with real values that follow the schema given earlier. " +
            "Do not return the schema itself. No prose, no code fence.",
        },
      ];
      history.push(ask[ask.length - 1]);
      let result: Awaited<ReturnType<typeof complete>> | undefined;
      let failure: unknown;
      for (const response_format of [
        { type: "json_schema", json_schema: { name: "result", schema: r.schema } },
        { type: "json_object" },
        undefined,
      ]) {
        try {
          result = await complete(
            config,
            response_format ? { messages: ask, response_format } : { messages: ask },
            r.signal,
          );
          break;
        } catch (e) {
          if (r.signal.aborted) throw e;
          failure = e;
        }
      }
      if (!result) throw failure;
      add(result.usage);
      r.onOutput?.(assistantLine(result.message));
      reply = typeof result.message.content === "string" ? result.message.content : "";
      problems = structuredProblems(reply, r.schema);
    }
    if (problems.length)
      throw new Error(`Model did not return the requested JSON: ${problems.slice(0, 5).join("; ")}`);
    output = extractJson(reply);
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
