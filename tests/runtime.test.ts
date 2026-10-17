import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import { fieldsToJsonSchema, zodToJsonSchema } from "../packages/runtime/src/json-schema.ts";
import { tools } from "../packages/adapters/src/catalog.ts";
import { modelProvider } from "../packages/runtime/src/types.ts";
import {
  modelConfig,
  preflightOpenAI,
  runOpenAI,
  toolDefinitions,
} from "../packages/runtime/src/openai.ts";

type Handler = (req: { method: string; url: string; body: any; headers: any }) => {
  status?: number;
  body: unknown;
};
async function serve(handler: Handler): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = raw;
      try {
        body = JSON.parse(raw);
      } catch {}
      const out = handler({ method: req.method!, url: req.url!, body, headers: req.headers });
      res.writeHead(out.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as any;
  return { url: `http://127.0.0.1:${port}`, server };
}
const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

test("zod field maps convert to JSON schema with required lists", () => {
  const schema = fieldsToJsonSchema({
    taskId: z.string(),
    status: z.literal("blocked"),
    kind: z.enum(["a", "b"]),
    files: z.array(z.string()),
    note: z.string().optional(),
  });
  assert.deepEqual(schema, {
    type: "object",
    properties: {
      taskId: { type: "string" },
      status: { type: "string", enum: ["blocked"] },
      kind: { type: "string", enum: ["a", "b"] },
      files: { type: "array", items: { type: "string" } },
      note: { type: "string" },
    },
    required: ["taskId", "status", "kind", "files"],
    additionalProperties: false,
  });
  assert.deepEqual(zodToJsonSchema(z.object({ n: z.number() })), {
    type: "object",
    properties: { n: { type: "number" } },
    required: ["n"],
    additionalProperties: false,
  });
});

test("every catalog tool becomes a valid OpenAI tool definition", () => {
  const defs = toolDefinitions();
  assert.equal(defs.length, tools.length);
  for (const def of defs) {
    assert.equal(def.type, "function");
    assert.ok(def.function.name && def.function.description);
    assert.equal((def.function.parameters as any).type, "object");
  }
  const update = defs.find((d) => d.function.name === "update_task")!;
  assert.deepEqual((update.function.parameters as any).required, [
    "taskId",
    "status",
    "reason",
  ]);
});

test("nested, refined and described catalog schemas keep their structure", () => {
  const defs = toolDefinitions();
  const create = defs.find((d) => d.function.name === "create_demo_video");
  assert.ok(create, "create_demo_video is in the catalog");
  const params = create!.function.parameters as any;
  assert.deepEqual(params.required, ["title", "spec"]);
  assert.match(params.properties.title.description, /video title/);
  assert.deepEqual(params.properties.language.enum, ["en", "de"]);
  const spec = params.properties.spec;
  assert.equal(spec.type, "object");
  assert.match(spec.description, /start the app/);
  assert.deepEqual(spec.required, ["app", "steps"]);
  assert.equal(spec.properties.steps.type, "array");
  assert.deepEqual(spec.properties.steps.items.properties.do.enum.slice(0, 2), ["goto", "click"]);
  assert.deepEqual(spec.properties.app.required, ["start", "port"]);
  for (const def of defs)
    assert.doesNotThrow(() => JSON.stringify(def.function.parameters));
});

test("provider selection defaults to claude and rejects unknown values", () => {
  assert.equal(modelProvider({}), "claude");
  assert.equal(modelProvider({ COLAG_MODEL_PROVIDER: "OpenAI" }), "openai");
  assert.throws(() => modelProvider({ COLAG_MODEL_PROVIDER: "gemini" }), /COLAG_MODEL_PROVIDER/);
  assert.throws(
    () => modelConfig({ COLAG_MODEL_PROVIDER: "openai", COLAG_MODEL_NAME: "x" }),
    /COLAG_MODEL_BASE_URL/,
  );
  assert.throws(
    () => modelConfig({ COLAG_MODEL_BASE_URL: "http://h/v1/" }),
    /COLAG_MODEL_NAME/,
  );
  const c = modelConfig({
    COLAG_MODEL_BASE_URL: "http://h/v1/",
    COLAG_MODEL_NAME: "m",
    COLAG_PORT: "4999",
  });
  assert.equal(c.baseUrl, "http://h/v1");
  assert.equal(c.api, "http://127.0.0.1:4999");
});

test("preflight checks the endpoint and that the model is served", async () => {
  const model = await serve(({ url, headers }) => {
    assert.equal(url, "/v1/models");
    assert.equal(headers.authorization, "Bearer k");
    return { body: { data: [{ id: "served/model" }] } };
  });
  servers.push(model.server);
  const env = {
    COLAG_MODEL_BASE_URL: `${model.url}/v1`,
    COLAG_MODEL_API_KEY: "k",
    COLAG_MODEL_NAME: "served/model",
  };
  const ok = await preflightOpenAI(env);
  assert.equal(ok.ok, true, ok.detail);
  const missing = await preflightOpenAI({ ...env, COLAG_MODEL_NAME: "other" });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /not served/);
  const unreachable = await preflightOpenAI({
    ...env,
    COLAG_MODEL_BASE_URL: "http://127.0.0.1:1/v1",
  });
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.detail, /unreachable/);
});

test("the tool loop executes Colag tools and returns the final answer", async () => {
  const toolCalls: { name: string; args: any; auth: string }[] = [];
  const api = await serve(({ url, body, headers }) => {
    const name = url.replace("/api/v1/tools/", "");
    toolCalls.push({ name, args: body, auth: headers.authorization });
    if (name === "inspect_project")
      return { body: { project: { name: "Demo" }, agents: [1, 2, 3] } };
    return { status: 403, body: { error: "Not allowed", code: "forbidden" } };
  });
  servers.push(api.server);
  let turn = 0;
  const requests: any[] = [];
  const model = await serve(({ url, body }) => {
    assert.equal(url, "/v1/chat/completions");
    requests.push(body);
    turn++;
    if (turn === 1)
      return {
        body: {
          choices: [
            {
              message: {
                role: "assistant",
                content: "Looking at the room.",
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: { name: "inspect_project", arguments: "{}" },
                  },
                  {
                    id: "c2",
                    type: "function",
                    function: { name: "write_file", arguments: '{"path":"x","content":"y"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      };
    return {
      body: {
        choices: [{ message: { role: "assistant", content: "Demo has 3 agents." } }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
      },
    };
  });
  servers.push(model.server);
  const lines: any[] = [];
  const result = await runOpenAI(
    {
      sessionId: "s",
      prompt: "Report the room.",
      token: "agent-token",
      signal: new AbortController().signal,
      onOutput: (l) => lines.push(l),
    },
    {
      baseUrl: `${model.url}/v1`,
      apiKey: "k",
      model: "m",
      maxTurns: 5,
      requestTimeoutMs: 5000,
      api: api.url,
    },
  );
  assert.equal(result, "Demo has 3 agents.");
  assert.deepEqual(
    toolCalls.map((c) => [c.name, c.auth]),
    [
      ["inspect_project", "Bearer agent-token"],
      ["write_file", "Bearer agent-token"],
    ],
  );
  assert.deepEqual(toolCalls[1].args, { path: "x", content: "y" });
  // Tool results, including the error, went back to the model.
  const toolMessages = requests[1].messages.filter((m: any) => m.role === "tool");
  assert.equal(toolMessages.length, 2);
  assert.match(toolMessages[1].content, /forbidden/);
  assert.equal(requests[0].tools.length, tools.length);
  // Engine-compatible output shapes.
  assert.equal(lines[0].type, "system");
  assert.equal(lines[0].subtype, "init");
  const assistant = lines.filter((l) => l.type === "assistant");
  assert.equal(assistant.length, 2);
  assert.equal(assistant[0].message.content[0].text, "Looking at the room.");
  assert.equal(assistant[0].message.content[1].type, "tool_use");
  const final = lines.at(-1);
  assert.equal(final.type, "result");
  assert.deepEqual(final.usage, { prompt_tokens: 30, completion_tokens: 9, total_tokens: 39 });
});

test("structured output is parsed, with a formatting pass when prose leaks in", async () => {
  let turn = 0;
  const model = await serve(({ body }) => {
    turn++;
    if (turn === 1)
      return {
        body: {
          choices: [
            { message: { role: "assistant", content: "Here is the plan:\n```json\n{\"title\":\"T\",\"tasks\":[]}\n```" } },
          ],
        },
      };
    assert.ok(body.response_format || turn > 2);
    return { body: { choices: [{ message: { role: "assistant", content: '{"title":"T2","tasks":[]}' } }] } };
  });
  servers.push(model.server);
  const config = {
    baseUrl: `${model.url}/v1`,
    apiKey: "",
    model: "m",
    maxTurns: 3,
    requestTimeoutMs: 5000,
    api: "http://127.0.0.1:1",
  };
  const schema = { type: "object", properties: { title: { type: "string" } } };
  const fenced = await runOpenAI(
    { sessionId: "s", prompt: "Plan.", token: "t", signal: new AbortController().signal, schema },
    config,
  );
  assert.deepEqual(fenced, { title: "T", tasks: [] });
  turn = 0;
  const prose = await serve(({ body }) => {
    turn++;
    if (turn === 1)
      return { body: { choices: [{ message: { role: "assistant", content: "I made a plan with two tasks." } }] } };
    assert.equal(body.response_format?.type, "json_schema");
    return { body: { choices: [{ message: { role: "assistant", content: '{"title":"Formatted"}' } }] } };
  });
  servers.push(prose.server);
  const formatted = await runOpenAI(
    { sessionId: "s", prompt: "Plan.", token: "t", signal: new AbortController().signal, schema },
    { ...config, baseUrl: `${prose.url}/v1` },
  );
  assert.deepEqual(formatted, { title: "Formatted" });
});

test("turn limits, server errors and cancellation surface as errors", async () => {
  const looping = await serve(() => ({
    body: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "c", type: "function", function: { name: "nope", arguments: "{}" } }],
          },
        },
      ],
    },
  }));
  servers.push(looping.server);
  const config = {
    baseUrl: `${looping.url}/v1`,
    apiKey: "",
    model: "m",
    maxTurns: 2,
    requestTimeoutMs: 5000,
    api: "http://127.0.0.1:1",
  };
  await assert.rejects(
    runOpenAI({ sessionId: "s", prompt: "p", token: "t", signal: new AbortController().signal }, config),
    /did not finish within 2 turns/,
  );
  const failing = await serve(() => ({ status: 401, body: { error: { message: "bad key" } } }));
  servers.push(failing.server);
  await assert.rejects(
    runOpenAI(
      { sessionId: "s", prompt: "p", token: "t", signal: new AbortController().signal },
      { ...config, baseUrl: `${failing.url}/v1` },
    ),
    /answered 401: .*bad key/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runOpenAI({ sessionId: "s", prompt: "p", token: "t", signal: controller.signal }, config),
    /cancelled/,
  );
});
