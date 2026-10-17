#!/usr/bin/env node
/**
 * Colag demo recorder. Runs in its own container that shares only the app's loopback network (no internet).
 *
 *   /job/job.json   { appUrl, title, language, music, emailKit, tempo, spec, clips: [{ step, file, text }] }
 *   /job/voice/*    the voice clips (spoken by the service with xAI)
 *   /out            video.mp4, preview.gif, thumbnail.png, subtitles.srt, result.json (or fail.png + result.json)
 *
 * Progress goes to stdout as `@@progress {json}` lines; the service turns them into room events.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { layout, srt } from "./timeline.mjs";

const JOB = process.env.JOB_DIR || "/job";
const OUT = process.env.OUT_DIR || "/out";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const BED = process.env.MUSIC_BED || path.join(HERE, "bed.wav");
const FPS = 30;
const SCALE = Number(process.env.SCALE || 2);
const WORK = path.join(OUT, ".work");

const job = JSON.parse(fs.readFileSync(path.join(JOB, "job.json"), "utf8"));
const [W, H] = (job.spec.viewport || "1920x1080").split("x").map(Number);
const app = new URL(job.appUrl);
const progress = (data) => console.log(`@@progress ${JSON.stringify(data)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "frames"), { recursive: true });

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} failed: ${(r.stderr || "").split("\n").slice(-5).join(" ")}`);
  return r.stdout;
}
const duration = (file) => Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());

function finish(result, code) {
  fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(code);
}

// ── 1. wait for the app ────────────────────────────────────────────────────────────────────────────────────────
async function waitForApp() {
  const ready = new URL(job.spec.app.readyPath || job.spec.app.path || "/", app);
  const deadline = Date.now() + 120_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(ready, { signal: AbortSignal.timeout(3000) });
      if (r.status < 500) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.cause?.code || e.message;
    }
    await sleep(1000);
  }
  throw new Error(`The app did not start on port ${app.port} within 2 minutes (${last}). Check app.start and app.port.`);
}

// ── 2. record ──────────────────────────────────────────────────────────────────────────────────────────────────
const CURSOR_SCRIPT = `(() => {
  const install = () => {
    if (document.getElementById('__demo_cursor')) return;
    const style = document.createElement('style');
    style.textContent = '#__demo_cursor{position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}'
      + '.__demo_ripple{position:fixed;z-index:2147483646;pointer-events:none;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid rgba(37,99,235,.85);background:rgba(37,99,235,.15);animation:__demo_r .55s ease-out forwards}'
      + '@keyframes __demo_r{from{transform:scale(.3);opacity:1}to{transform:scale(1.5);opacity:0}}';
    document.documentElement.appendChild(style);
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    c.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2l15 10.5-6.6 1.2 4 7.6-3 1.6-4-7.7L4 20z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    let p = { x: ${W / 2}, y: ${H / 2} };
    try { p = JSON.parse(sessionStorage.getItem('__demo_pos') || 'null') || p; } catch {}
    const place = (x, y) => { c.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 2) + 'px)'; try { sessionStorage.setItem('__demo_pos', JSON.stringify({ x, y })); } catch {} };
    place(p.x, p.y);
    addEventListener('mousemove', (e) => place(e.clientX, e.clientY), true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = '__demo_ripple'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
      document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700);
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})()`;

async function record() {
  const browser = await chromium.launch({ args: [`--force-device-scale-factor=${SCALE}`] });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: SCALE,
    locale: job.language === "de" ? "de-DE" : "en-GB",
    timezoneId: "Europe/Berlin",
  });
  // only the app itself: anything else (another site, a tracker) is refused
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (["data:", "blob:"].includes(u.protocol) || (u.hostname === app.hostname && u.port === app.port)) return route.continue();
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return route.continue(); // the app's own API port
    return route.abort();
  });
  await context.addInitScript(CURSOR_SCRIPT);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const startPath = job.spec.app.path || "/";
  await page.goto(new URL(startPath, app).href, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await sleep(600);

  const frames = [];
  const t0 = Date.now();
  const vt = () => (Date.now() - t0) / 1000;
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    const at = metadata?.timestamp ? metadata.timestamp * 1000 : Date.now();
    const file = path.join(WORK, "frames", `${String(frames.length).padStart(7, "0")}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: Math.max(0, (at - t0) / 1000) });
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1, maxWidth: W * SCALE, maxHeight: H * SCALE });

  const pos = { x: W / 2, y: H / 2 };
  const moveTo = async (x, y) => {
    const dx = x - pos.x, dy = y - pos.y;
    const steps = Math.max(10, Math.min(40, Math.round(Math.hypot(dx, dy) / 22)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      await page.mouse.move(pos.x + dx * e, pos.y + dy * e);
      await sleep(14);
    }
    pos.x = x;
    pos.y = y;
  };
  const point = async (target) => {
    const loc = page.locator(target).first();
    await loc.waitFor({ state: "visible" });
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const box = await loc.boundingBox();
    if (!box) throw new Error("the element has no size on screen");
    await moveTo(box.x + box.width / 2, box.y + Math.min(box.height / 2, 20));
    return loc;
  };
  const settle = async (ms) => {
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    await sleep(ms);
  };

  const dead = [];
  const steps = [];
  for (const [i, step] of job.spec.steps.entries()) {
    progress({ phase: "recording", step: i + 1, of: job.spec.steps.length });
    const start = vt();
    try {
      switch (step.do) {
        case "goto": {
          const from = vt();
          await page.goto(new URL(step.value, app).href, { waitUntil: "load" });
          await settle(300);
          dead.push([from, vt()]);
          await sleep(500);
          break;
        }
        case "click": {
          const loc = await point(step.target);
          await sleep(200);
          await loc.click();
          await settle(700);
          break;
        }
        case "type": {
          const loc = await point(step.target);
          await loc.click();
          await loc.pressSequentially(step.value ?? "", { delay: 45 });
          await sleep(400);
          break;
        }
        case "press":
          await page.keyboard.press(step.value);
          await settle(600);
          break;
        case "hover":
          await point(step.target);
          await sleep(900);
          break;
        case "scroll": {
          const pixels = Number(step.value ?? 400);
          if (step.target) await point(step.target);
          for (let done = 0; Math.abs(done) < Math.abs(pixels); done += Math.sign(pixels) * 40) {
            await page.mouse.wheel(0, Math.sign(pixels) * 40);
            await sleep(22);
          }
          await sleep(500);
          break;
        }
        case "wait":
          await sleep(Number(step.value ?? 1000));
          break;
      }
    } catch (e) {
      await page.screenshot({ path: path.join(OUT, "fail.png") }).catch(() => {});
      await browser.close().catch(() => {});
      const message = String(e?.message || e).split("\n")[0];
      finish({ ok: false, step: i + 1, action: step.do, target: step.target, error: message }, 2);
    }
    steps.push({ start, end: vt() });
  }
  await sleep(1500); // end frame
  const total = vt();
  await cdp.send("Page.stopScreencast").catch(() => {});
  await browser.close();
  if (!frames.length) throw new Error("The browser produced no frames");

  // a constant 30 fps take from the frames' real timestamps (Chrome sends a frame only when something changed)
  const lines = [];
  frames.forEach((f, i) => {
    const to = i + 1 < frames.length ? frames[i + 1].t : total;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, to - f.t).toFixed(4)}`);
  });
  lines.push(`file '${frames.at(-1).file}'`);
  fs.writeFileSync(path.join(WORK, "frames.txt"), lines.join("\n"));
  const raw = path.join(WORK, "raw.mp4");
  progress({ phase: "encoding" });
  run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", path.join(WORK, "frames.txt"),
    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-fps_mode", "cfr", "-r", String(FPS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", raw]);
  return { raw, steps, dead, total: duration(raw) };
}

// ── 3. voice, timeline, picture, sound ───────────────────────────────────────────────────────────────────────
function voiceClips() {
  const tempo = job.tempo || 1.08;
  return job.clips.map((c, i) => {
    const src = path.join(JOB, c.file);
    const file = path.join(WORK, `line-${i}.wav`);
    run("ffmpeg", ["-v", "error", "-y", "-i", src, "-af", `atempo=${tempo}`, "-ar", "48000", "-ac", "1", file]);
    return { ...c, file, duration: duration(file) };
  });
}

function render(take, clips) {
  const plan = layout({ steps: take.steps, dead: take.dead, clips, total: take.total, fps: FPS });
  const n = plan.pieces.length;
  const graph = [`[0:v]split=${n}${plan.pieces.map((_, i) => `[s${i}]`).join("")}`];
  plan.pieces.forEach((p, i) => {
    const pad = p.hold > 0 ? `,tpad=stop_mode=clone:stop_duration=${p.hold.toFixed(3)}` : "";
    graph.push(`[s${i}]trim=start=${p.from.toFixed(3)}:end=${p.to.toFixed(3)},setpts=PTS-STARTPTS${pad}[p${i}]`);
  });
  graph.push(`${plan.pieces.map((_, i) => `[p${i}]`).join("")}concat=n=${n}:v=1:a=0,scale=${W}:${H}:flags=lanczos,fps=${FPS}[v]`);
  const picture = path.join(WORK, "picture.mp4");
  progress({ phase: "editing" });
  fs.writeFileSync(path.join(WORK, "graph.txt"), graph.join(";\n"));
  run("ffmpeg", ["-v", "error", "-y", "-i", take.raw, "-filter_complex_script", path.join(WORK, "graph.txt"), "-map", "[v]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", picture]);
  const length = duration(picture);

  // the voice at its places, levelled; the music bed under it, ducked while the voice speaks
  const timed = plan.lines.map((l) => ({ ...l, ...clips.find((c) => c.step === l.step) }));
  const inputs = timed.flatMap((t) => ["-i", t.file]);
  const delays = timed.map((t, i) => `[${i}:a]adelay=${Math.round(t.start * 1000)}:all=1[a${i}]`);
  let mix = `${timed.map((_, i) => `[a${i}]`).join("")}amix=inputs=${timed.length}:normalize=0:dropout_transition=0,loudnorm=I=-16:TP=-1.5:LRA=11,apad=whole_dur=${length.toFixed(3)},aformat=sample_rates=48000:channel_layouts=mono`;
  const extra = [];
  if (job.music && fs.existsSync(BED)) {
    const m = timed.length;
    extra.push("-stream_loop", "-1", "-i", BED);
    mix += `,asplit=2[voice][key];[${m}:a]aformat=sample_rates=48000:channel_layouts=mono,atrim=0:${length.toFixed(3)},volume=-20dB,afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, length - 1.5).toFixed(3)}:d=1.5[bed];[bed][key]sidechaincompress=threshold=0.03:ratio=6:attack=30:release=400[ducked];[voice][ducked]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.89[out]`;
  } else mix += "[out]";
  const sound = path.join(WORK, "sound.m4a");
  progress({ phase: "mixing" });
  run("ffmpeg", ["-v", "error", "-y", ...inputs, ...extra, "-filter_complex", [...delays, mix].join(";"), "-map", "[out]", "-ar", "48000", "-c:a", "aac", "-b:a", "160k", sound]);

  const subtitles = path.join(OUT, "subtitles.srt");
  fs.writeFileSync(subtitles, srt(timed));
  const lang = job.language === "de" ? "deu" : "eng";
  run("ffmpeg", ["-v", "error", "-y", "-i", picture, "-i", sound, "-i", subtitles, "-map", "0:v", "-map", "1:a", "-map", "2:s",
    "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", "-metadata", `title=${job.title}`,
    "-metadata:s:a:0", `language=${lang}`, "-metadata:s:s:0", `language=${lang}`, "-movflags", "+faststart", path.join(OUT, "video.mp4")]);
  return { length: duration(path.join(OUT, "video.mp4")), lines: timed.map(({ step, start, duration: d, text }) => ({ step, start, duration: d, text })) };
}

// ── 4. the e-mail kit: a GIF preview and a thumbnail with a play button ──────────────────────────────────────
async function emailKit(seconds) {
  progress({ phase: "email kit" });
  const video = path.join(OUT, "video.mp4");
  run("ffmpeg", ["-v", "error", "-y", "-t", "8", "-i", video, "-vf",
    "fps=12,scale=600:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    path.join(OUT, "preview.gif")]);
  const still = path.join(WORK, "still.jpg");
  run("ffmpeg", ["-v", "error", "-y", "-ss", "1.2", "-i", video, "-frames:v", "1", "-vf", "scale=1280:-2:flags=lanczos", "-q:v", "3", still]);
  const caption = `${job.title} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;width:1280px;height:720px;overflow:hidden;font-family:"DejaVu Sans",Arial,sans-serif}
    .bg{position:absolute;inset:0;background:url(data:image/jpeg;base64,${fs.readFileSync(still).toString("base64")}) center/cover}
    .shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(10,20,40,.05) 35%,rgba(10,20,40,.55))}
    .play{position:absolute;left:50%;top:44%;width:180px;height:180px;margin:-90px 0 0 -90px;border-radius:50%;background:rgba(37,99,235,.92);
      border:7px solid #fff;box-shadow:0 12px 40px rgba(0,0,0,.35)}
    .play:after{content:"";position:absolute;left:68px;top:46px;border-style:solid;border-width:37px 0 37px 62px;border-color:transparent transparent transparent #fff}
    .cap{position:absolute;left:50%;bottom:70px;transform:translateX(-50%);max-width:1140px;padding:16px 38px;border-radius:44px;
      background:rgba(10,20,40,.86);color:#fff;font-size:40px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  </style></head><body><div class="bg"></div><div class="shade"></div><div class="play"></div><div class="cap"></div></body></html>`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.route("**/*", (r) => (r.request().url().startsWith("data:") ? r.continue() : r.abort()));
  await page.setContent(html);
  await page.locator(".cap").evaluate((el, text) => (el.textContent = text), caption);
  await page.screenshot({ path: path.join(OUT, "thumbnail.png") });
  await browser.close();
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────────────────
try {
  progress({ phase: "starting app" });
  await waitForApp();
  const clips = voiceClips();
  const take = await record();
  const cut = render(take, clips);
  const seconds = Math.round(cut.length);
  if (job.emailKit) await emailKit(seconds);
  const files = ["video.mp4", "subtitles.srt", ...(job.emailKit ? ["preview.gif", "thumbnail.png"] : [])];
  finish({ ok: true, duration: cut.length, files, lines: cut.lines }, 0);
} catch (e) {
  finish({ ok: false, error: String(e?.message || e).split("\n")[0] }, 1);
}
