/**
 * Calls one Colag tool over the service's HTTP tool endpoint.
 * Shared by the stdio MCP bridge and the OpenAI-compatible runtime so every
 * model path reaches the same authorized command service.
 */
export interface ToolCallResult {
  ok: boolean;
  status: number;
  data: unknown;
}
export async function callTool(
  api: string,
  token: string,
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<ToolCallResult> {
  const r = await fetch(`${api}/api/v1/tools/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(args ?? {}),
    signal,
  });
  const text = await r.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { ok: r.ok, status: r.status, data };
}
