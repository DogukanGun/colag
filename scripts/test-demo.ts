/**
 * End-to-end demo video, without a database: the sample app with a finished sign-up (fixtures/demo-app) is installed,
 * started without network and filmed by the recorder image, with a real xAI voice.
 *
 *   pnpm demo:image && XAI_API_KEY=… pnpm test:demo [en|de]
 *
 * Checks the files, the length, that both streams exist and that the app container had no internet.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
process.env.COLAG_DATA_DIR ||= path.resolve(".colag");
const demo = await import("../apps/service/src/demo.ts");
const { specSchema } = await import("../packages/protocol/src/demo.ts");

const language = (process.argv[2] === "de" ? "de" : "en") as "en" | "de";
const id = `smoke-${randomUUID().slice(0, 8)}`;
const dir = path.resolve(".colag", "demos", "smoke", id);
const appDir = path.join(dir, "app");
await rm(dir, { recursive: true, force: true });
await cp(path.resolve("fixtures/sample"), appDir, { recursive: true });
await cp(path.resolve("fixtures/demo-app"), appDir, { recursive: true });

const lines = {
  en: [
    "Here is the sign-up we built today. Let's create an account!",
    "Type an e-mail address,",
    "pick a password,",
    "and sign up. That's it: you're in!",
    "Signing out is one click, too.",
  ],
  de: [
    "Das ist die Registrierung, die wir heute gebaut haben. Los geht's!",
    "Eine E-Mail-Adresse eingeben,",
    "ein Passwort wählen,",
    "und registrieren. Fertig, Sie sind drin!",
    "Abmelden geht mit einem Klick.",
  ],
}[language];
const spec = specSchema.parse({
  app: { start: "dev:web", port: 4401, api: { start: "dev:api", port: 4400 } },
  steps: [
    { do: "hover", target: "h1", say: lines[0] },
    { do: "type", target: "#email", value: "ada@example.com", say: lines[1] },
    { do: "type", target: "#password", value: "correct horse battery", say: lines[2] },
    { do: "click", target: "role=button[name=\"Sign up\"]", say: lines[3] },
    { do: "click", target: "text=Sign out", say: lines[4] },
    { do: "wait", value: "800" },
  ],
});
const events: string[] = [];
const job = {
  demo: { id, projectId: "smoke", kind: "demo", version: 1, createdAt: "", updatedAt: "", data: {} },
  dir,
  appDir,
  jobDir: path.join(dir, "job"),
  outDir: path.join(dir, "out"),
  spec,
  signal: new AbortController().signal,
  onProgress: (p: any) => {
    const line = `${p.phase}${p.step ? ` ${p.step}/${p.of}` : ""}`;
    if (events.at(-1) !== line) console.log(`  · ${line}`);
    events.push(line);
  },
} as any;
await mkdir(job.outDir, { recursive: true });
const started = Date.now();
await demo.prepareJob(job, { title: language === "de" ? "Registrierung" : "Sign-up", language, music: true, emailKit: true });
console.log("install …");
await demo.installDependencies(job);
console.log("record …");
const result = await demo.recordInContainers(job);
try {
  // the app container had no way out (still running: removed below)
  const probe = execFileSync("docker", ["exec", `colag-demo-${id}-app`, "sh", "-c", "wget -q -T 3 -O - https://example.com >/dev/null 2>&1 && echo online || echo offline"], { encoding: "utf8" }).trim();
  assert.equal(probe, "offline", "the app container must not reach the internet");
  console.log(`result: ${JSON.stringify({ ...result, lines: undefined })}`);
  assert.ok(result.ok, result.error);
  for (const f of ["video.mp4", "preview.gif", "thumbnail.png", "subtitles.srt"]) assert.ok(result.files?.includes(f), `missing ${f}`);
  const streams = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path.join(job.outDir, "video.mp4")], { encoding: "utf8" });
  assert.match(streams, /video/);
  assert.match(streams, /audio/);
  assert.ok(result.duration! > 10 && result.duration! < 90, `duration ${result.duration}`);
  console.log(`ok: ${result.duration?.toFixed(1)} s video in ${((Date.now() - started) / 1000).toFixed(0)} s → ${job.outDir}`);
} finally {
  execFileSync("docker", ["rm", "-f", `colag-demo-${id}-app`], { stdio: "ignore" });
  await rm(appDir, { recursive: true, force: true });
  await rm(job.jobDir, { recursive: true, force: true });
}
