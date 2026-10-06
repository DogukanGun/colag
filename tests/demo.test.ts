import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSpec, missingScripts, specSchema } from "../packages/protocol/src/demo.ts";
import { EXTERNAL_MCP_PERMISSIONS, MEMBER_ACTIONS } from "../packages/protocol/src/index.ts";
import { remoteTools } from "../packages/adapters/src/catalog.ts";
import { clipKey, speak } from "../packages/runtime/src/tts.ts";
// @ts-ignore plain JS module shared with the recorder image
import { layout, subtract, srt } from "../infrastructure/demo-recorder/timeline.mjs";

const app = { start: "dev:web", port: 4401, api: { start: "dev:api", port: 4400 } };

test("a demo script: app start, steps and voice lines are validated", () => {
  const ok = parseSpec({ app, steps: [{ do: "goto", value: "/login", say: "Hi!" }, { do: "click", target: "text=Sign in" }] });
  assert.equal(ok.ok, true);
  const bad = parseSpec({
    app: { start: "dev; rm -rf /", port: 80 },
    steps: [
      { do: "goto", value: "https://evil.example" },
      { do: "click" },
      { do: "click", target: "js=document.cookie" },
      { do: "wait", value: "60000" },
      { do: "press", value: "Enter && ls" },
    ],
  });
  assert.equal(bad.ok, false);
  const errors = (bad as { errors: string[] }).errors.join("\n");
  assert.match(errors, /npm script name/);
  assert.match(errors, /app\.port/);
  assert.match(errors, /steps\.0: goto needs a value: a path inside the app/);
  assert.match(errors, /steps\.1: click needs a target/);
  assert.match(errors, /Script selectors are not allowed/);
  assert.match(errors, /wait is at most 10000 ms/);
  assert.match(errors, /press needs a key/);
  assert.match(errors, /at least one step a voice line/);
  // protocol-relative URLs are another site, not a path
  assert.equal(parseSpec({ app, steps: [{ do: "goto", value: "//evil.example/x", say: "x" }] }).ok, false);
  // too long: a line over 40 words, and more than 40 steps
  const long = Array.from({ length: 41 }, () => "word").join(" ");
  assert.equal(parseSpec({ app, steps: [{ do: "wait", say: long }] }).ok, false);
  assert.equal(parseSpec({ app, steps: Array.from({ length: 41 }, () => ({ do: "wait", say: "hi" })) }).ok, false);
  // unknown keys are refused (a typo should not silently do nothing)
  assert.equal(parseSpec({ app, steps: [{ do: "wait", say: "hi", selector: "#x" }] }).ok, false);
});

test("the scripts a demo starts must exist in the build's package.json", () => {
  const spec = specSchema.parse({ app, steps: [{ do: "wait", say: "hi" }] });
  assert.deepEqual(missingScripts(spec, { "dev:web": "vite", "dev:api": "node api" }), []);
  assert.deepEqual(missingScripts(spec, { "dev:web": "vite" }), ["dev:api"]);
  assert.deepEqual(missingScripts(spec, undefined), ["dev:web", "dev:api"]);
});

test("the coder gets the demo tools; approve and merge stay with members", () => {
  const names = remoteTools().map((t) => t.name);
  for (const n of ["create_demo_video", "update_demo_video", "render_demo_video", "get_demo_video"]) assert.ok(names.includes(n), n);
  for (const p of ["demo.write", "demo.render"]) {
    assert.ok(EXTERNAL_MCP_PERMISSIONS.includes(p));
    assert.ok(MEMBER_ACTIONS.includes(p));
  }
  assert.equal(EXTERNAL_MCP_PERMISSIONS.includes("run.merge"), false);
});

test("timeline: lines sit at their steps, page loads are cut, long lines hold the frame", () => {
  const steps = [
    { start: 0, end: 4 },
    { start: 4, end: 9 }, // contains a 3 s page load (5–8)
    { start: 9, end: 10 },
  ];
  const plan = layout({
    steps,
    dead: [[5, 8]],
    clips: [
      { step: 0, duration: 2 },
      { step: 1, duration: 1 },
      { step: 2, duration: 3 }, // longer than its 1 s step: hold
    ],
    total: 11,
    fps: 30,
    leadIn: 0.2,
    gap: 0.3,
    tail: 0.35,
    margin: 0.05,
  });
  const [a, b, c] = plan.lines;
  assert.equal(a.start, 0.2);
  assert.equal(b.start, 4.2); // its step starts at 4
  // step 2 starts at 9 in the source; the cut (5.05–7.95 = 2.9 s) moves it to 6.1
  assert.ok(Math.abs(c.start - 6.3) < 1e-9, `step 2 line at ${c.start}`);
  const held = plan.pieces.reduce((n: number, p: { hold: number }) => n + p.hold, 0);
  // the third line ends at 9.3 (+0.35 tail) but its step ends at 7.1: hold about 2.55 s
  assert.ok(Math.abs(held - 2.5667) < 0.04, `held ${held}`);
  // nothing from inside the page load is kept (the cut edges sit on the frame grid: 5.0667–7.9667)
  for (const p of plan.pieces) assert.ok(p.to <= 152 / 30 + 1e-9 || p.from >= 239 / 30 - 1e-9, JSON.stringify(p));
  // every boundary is on the 30 fps grid, so the rendered pieces add up exactly
  for (const p of plan.pieces) for (const t of [p.from, p.to, p.hold]) assert.ok(Math.abs(t * 30 - Math.round(t * 30)) < 1e-6, String(t));
  assert.ok(Math.abs(plan.length - (11 - 2.9 + held)) < 0.05, `length ${plan.length}`);
  // a later line never starts before the previous one is done
  assert.ok(b.start >= a.start + a.duration + 0.3 - 1e-9);
});

test("timeline helpers: subtract and subtitles", () => {
  assert.deepEqual(subtract([0, 10], [[2, 3], [5, 6]]), [[0, 2], [3, 5], [6, 10]]);
  assert.deepEqual(subtract([2, 3], [[0, 10]]), []);
  assert.equal(
    srt([{ start: 1.5, duration: 2, text: "Hello" }]),
    "1\n00:00:01,500 --> 00:00:03,500\nHello\n",
  );
});

test("voice clips are cached by text, voice, language and format", async () => {
  assert.notEqual(clipKey("Hi", "eve", "en", "wav"), clipKey("Hi", "ara", "de", "wav"));
  assert.equal(clipKey("Hi", "eve", "en", "wav"), clipKey("Hi", "eve", "en", "wav"));
  const dir = await mkdtemp(path.join(os.tmpdir(), "colag-tts-"));
  const previous = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "test-key";
  let calls = 0;
  const fake = (async (_url: string, init: any) => {
    calls += 1;
    const body = JSON.parse(init.body);
    assert.equal(body.voice_id, "ara");
    assert.equal(body.language, "de");
    assert.equal(init.headers.Authorization, "Bearer test-key");
    if (calls === 1) return new Response("busy", { status: 429 });
    return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "content-type": "audio/wav" } });
  }) as typeof fetch;
  try {
    const first = await speak("Hallo!", { language: "de", cacheDir: dir, fetchImpl: fake });
    const again = await speak("Hallo!", { language: "de", cacheDir: dir, fetchImpl: fake });
    assert.equal(first, again);
    assert.equal(calls, 2); // one rate-limited retry, then cached
    assert.deepEqual(await readdir(dir), [path.basename(first)]);
  } finally {
    if (previous === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous;
  }
});

test(
  "a room's demo: the coder writes and renders it, members watch and download it, other rooms cannot",
  { skip: process.env.COLAG_DATABASE_TESTS !== "1" },
  async () => {
    process.env.NODE_ENV = "test";
    process.env.COLAG_DATA_DIR = path.resolve(".colag/demo-test-" + Math.random().toString(36).slice(2, 8));
    const { randomUUID } = await import("node:crypto");
    const { writeFile, mkdir, rm } = await import("node:fs/promises");
    const { migrate, pool } = await import("../packages/database/src.ts");
    const store = await import("../apps/service/src/store.ts");
    const identity = await import("../apps/service/src/identity.ts");
    const engine = await import("../apps/service/src/engine.ts");
    const demo = await import("../apps/service/src/demo.ts");
    const git = await import("../packages/git/src/index.ts");
    try {
      await migrate();
      const owner = await identity.upsertUser(`demo-${randomUUID()}@colag.test`, "Ada");
      const stranger = await identity.upsertUser(`stranger-${randomUUID()}@colag.test`, "Mallory");
      const room = await store.provisionRoom(owner.id, "Demo room");
      const otherRoom = await store.provisionRoom(stranger.id, "Other room");
      const member = await identity.memberActor(owner, room.id);
      const coder = await identity.authenticateMcp((await identity.createConnection(owner, room.id, "Cursor")).token);
      const outsider = await identity.authenticateMcp((await identity.createConnection(stranger, otherRoom.id, "Cursor")).token);

      const script = {
        title: "Sign-up in 20 seconds",
        language: "de",
        spec: { app, steps: [{ do: "goto", value: "/", say: "Hallo!" }, { do: "click", target: "text=Sign up", say: "Los geht's!" }] },
      };
      // nothing built yet
      await assert.rejects(() => engine.tools(coder, "create_demo_video", script, randomUUID()), /Nothing has been built/);
      // a build: the sample app at its first commit
      const runId = randomUUID();
      const { baseSha } = await git.createRepository(runId);
      await store.create("run", { status: "completed", baseSha, request: "Sign-up" }, "run.created", store.systemActor(room.id));
      await pool.query("UPDATE resources SET id=$1 WHERE project_id=$2 AND kind='run'", [runId, room.id]);

      // the coder's mistakes come back as readable errors
      await assert.rejects(
        () => engine.tools(coder, "create_demo_video", { ...script, spec: { app, steps: [{ do: "click" }] } }, randomUUID()),
        /steps\.0: click needs a target/,
      );
      const created = await engine.tools(coder, "create_demo_video", script, randomUUID());
      assert.equal(created.status, "draft");
      assert.equal(created.language, "de");
      // another room's coder cannot see or render it
      await assert.rejects(() => engine.tools(outsider, "get_demo_video", { demoId: created.id }, randomUUID()), /not found/i);
      await assert.rejects(() => engine.tools(outsider, "render_demo_video", { demoId: created.id }, randomUUID()), /not found/i);
      await assert.rejects(() => identity.memberActor(stranger, room.id), /membership/i);

      // the scripts must exist in the build (the sample has dev:web and dev:api)
      const wrong = await engine.tools(coder, "update_demo_video", { demoId: created.id, spec: { ...script.spec, app: { start: "start", port: 4401 } } }, randomUUID());
      await assert.rejects(() => engine.tools(coder, "render_demo_video", { demoId: wrong.id }, randomUUID()), /no npm script "start"/);
      await engine.tools(coder, "update_demo_video", { demoId: created.id, spec: script.spec }, randomUUID());

      // render with the containers stubbed: the voice is spoken per line, the files land in the room
      const spoken: string[] = [];
      demo.configureDemoRuntime({
        speak: async (text, options) => {
          spoken.push(`${options.language}:${text}`);
          await mkdir(options.cacheDir, { recursive: true });
          const f = path.join(options.cacheDir, `${spoken.length}.wav`);
          await writeFile(f, "RIFF");
          return f;
        },
        install: async () => {},
        record: async (job) => {
          const queued = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(job.jobDir, "job.json"), "utf8"));
          assert.equal(queued.clips.length, 2);
          assert.equal(queued.appUrl, "http://127.0.0.1:4401");
          job.onProgress({ phase: "recording", step: 1, of: 2 });
          await writeFile(path.join(job.outDir, "video.mp4"), Buffer.alloc(1000, 7));
          await writeFile(path.join(job.outDir, "thumbnail.png"), "png");
          return { ok: true, duration: 21.5, files: ["video.mp4", "thumbnail.png", "../../etc/passwd"] };
        },
      });
      const queued = await engine.tools(coder, "render_demo_video", { demoId: created.id }, randomUUID());
      assert.equal(queued.status, "queued");
      await assert.rejects(() => demo.queueRender(member, created.id), /already rendering|one at a time/);
      await demo.idle();
      const ready = await engine.tools(coder, "get_demo_video", { demoId: created.id }, randomUUID());
      assert.equal(ready.status, "ready", ready.error);
      assert.deepEqual(Object.keys(ready.files).sort(), ["thumbnail.png", "video.mp4"]);
      assert.deepEqual(spoken, ["de:Hallo!", "de:Los geht's!"]);
      const artifact = await store.get(ready.artifactId);
      assert.equal(artifact.data.artifactType, "video");
      assert.equal(JSON.parse(artifact.data.content).duration, 21.5);

      // members download it; other names and other rooms are refused
      const file = await demo.demoFile(member, created.id, "video.mp4");
      assert.equal(file.size, 1000);
      assert.equal(file.type, "video/mp4");
      await assert.rejects(() => demo.demoFile(member, created.id, "../../etc/passwd"), /not found/i);
      await assert.rejects(() => demo.demoFile(member, created.id, "preview.gif"), /not found/i);
      const strangerActor = await identity.memberActor(stranger, otherRoom.id);
      await assert.rejects(() => demo.demoFile({ ...strangerActor, projectId: room.id }, created.id, "video.mp4"), /membership/i);

      // a failing step is reported with its number and keeps the screenshot
      demo.configureDemoRuntime({
        record: async (job) => {
          await writeFile(path.join(job.outDir, "fail.png"), "png");
          return { ok: false, step: 2, action: "click", target: "text=Sign up", error: "locator.waitFor: Timeout 15000ms exceeded" };
        },
      });
      await demo.queueRender(member, created.id);
      await demo.idle();
      const failed = await demo.getDemo(member, created.id);
      assert.equal(failed.status, "failed");
      assert.match(failed.error, /^Step 2 \(click text=Sign up\): locator\.waitFor/);
      assert.deepEqual(Object.keys(failed.files), ["fail.png"]);

      // the daily limit counts every render of the room
      process.env.COLAG_DEMO_DAILY_LIMIT = "2";
      await assert.rejects(() => demo.queueRender(member, created.id), /rendered 2 demos today/);
      delete process.env.COLAG_DEMO_DAILY_LIMIT;

      // deleting removes it from the room
      await demo.deleteDemo(member, created.id);
      assert.equal((await demo.listDemos(member)).length, 0);
      await rm(process.env.COLAG_DATA_DIR!, { recursive: true, force: true });
    } finally {
      await pool.end();
    }
  },
);

test("the voice key never appears in an error", async () => {
  const { redact } = await import("../packages/runtime/src/tts.ts");
  const previous = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "xai-TESTKEY1234567890abcdef";
  try {
    assert.equal(redact('Headers.append: "Bearer xai-TESTKEY1234567890abcdef" is invalid'), 'Headers.append: "Bearer [key]" is invalid');
    assert.equal(redact("leaked xai-OTHERKEY1234567890 here"), "leaked xai-[key] here");
    // a key with a line break in it is refused before any request
    process.env.XAI_API_KEY = "\nxai-TESTKEY1234567890abcdef\nmore";
    const dir = await mkdtemp(path.join(os.tmpdir(), "colag-tts-"));
    await assert.rejects(() => speak("Hi", { language: "en", cacheDir: dir, fetchImpl: (async () => { throw new Error("must not be called"); }) as any }), (e: Error) => {
      assert.match(e.message, /malformed/);
      assert.doesNotMatch(e.message, /TESTKEY/);
      return true;
    });
    // a quoted key from an .env file still works
    process.env.XAI_API_KEY = '"xai-TESTKEY1234567890abcdef"';
    const { xaiKey } = await import("../packages/runtime/src/tts.ts");
    assert.equal(xaiKey(), "xai-TESTKEY1234567890abcdef");
  } finally {
    if (previous === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous;
  }
});
