import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { Hand, installHumanCursor } from "./sales-human.ts";
import { revokeDemo } from "./sales-walk.ts";
import type { Durations, LineId } from "./live-voice.ts";

const base = process.env.COLAG_E2E_URL || "https://colag-eight.vercel.app";
const roomId = process.env.COLAG_JUDGE_ROOM || "c3c56888-fe1e-4ddf-8006-e0f403e6cf30";
const outDir = resolve("demos/sales/out");
const email = "sales-demo@colag.test";

export type Take = {
  id: string;
  file: string;
  beats: Partial<Record<LineId, number>>;
};

function psql(sql: string) {
  execFileSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "root@2.28.123.220",
      "docker exec -i colag-postgres-1 psql -U colag -d colag -v ON_ERROR_STOP=1",
    ],
    { input: sql },
  );
}

function seed() {
  const userId = randomBytes(16).toString("hex");
  const sessionId = randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  psql(`
BEGIN;
DELETE FROM mcp_connections WHERE user_id IN (SELECT id FROM users WHERE email='${email}');
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email='${email}');
DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email='${email}');
DELETE FROM users WHERE email='${email}';
INSERT INTO users(id, email, display_name) VALUES ('${userId}', '${email}', 'Alex');
INSERT INTO sessions(id, user_id, token_hash, expires_at)
  VALUES ('${sessionId}', '${userId}', '${tokenHash}', now() + interval '1 day');
INSERT INTO memberships(room_id, user_id, role) VALUES ('${roomId}', '${userId}', 'member')
  ON CONFLICT DO NOTHING;
COMMIT;
`);
  return token;
}

function dressRoom() {
  const agents = ["coordinator", "backend", "frontend", "qa"]
    .map((role) => `'agent-${role}-${roomId}'`)
    .join(",");
  psql(`
BEGIN;
UPDATE resources SET data = jsonb_set(data, '{status}', '"working"')
  WHERE id IN (${agents});
UPDATE resources SET data = jsonb_set(data, '{status}', '"idle"')
  WHERE id = 'agent-architect-${roomId}';
INSERT INTO users(id, email, display_name)
  VALUES ('livedesk01', 'live-desk@colag.test', 'Sam')
  ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name;
INSERT INTO memberships(room_id, user_id, role)
  VALUES ('${roomId}', 'livedesk01', 'member')
  ON CONFLICT DO NOTHING;
INSERT INTO mcp_connections(id, room_id, user_id, name, token_hash, last_seen_at)
  VALUES ('livedeskconn01', '${roomId}', 'livedesk01', 'Cursor', 'livedeskconn01hash', now())
  ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), revoked_at = NULL;
UPDATE mcp_connections SET last_seen_at = now() WHERE id = 'livedeskconn01';
COMMIT;
`);
}

function speakNow() {
  psql(`
BEGIN;
DELETE FROM events WHERE project_id = '${roomId}' AND payload->>'film' = 'live';
INSERT INTO events(id, project_id, actor_id, type, resource_id, payload) VALUES
  ('live-atlas', '${roomId}', 'agent-coordinator-${roomId}', 'task.completed', 'agent-coordinator-${roomId}', '{"text":"The plan is set. Nearest driver takes the ride.","film":"live"}'),
  ('live-ada', '${roomId}', 'agent-architect-${roomId}', 'task.completed', 'agent-architect-${roomId}', '{"text":"Register, login, authenticate, logout.","film":"live"}'),
  ('live-forge', '${roomId}', 'agent-backend-${roomId}', 'workspace.file.updated', 'agent-backend-${roomId}', '{"text":"Sign-in is in the service.","film":"live"}'),
  ('live-pixel', '${roomId}', 'agent-frontend-${roomId}', 'task.completed', 'agent-frontend-${roomId}', '{"text":"The sign-up screen is on the desk.","film":"live"}'),
  ('live-sentinel', '${roomId}', 'agent-qa-${roomId}', 'task.completed', 'agent-qa-${roomId}', '{"text":"Tests passed. Ready to merge.","film":"live"}');
UPDATE mcp_connections SET last_seen_at = now() WHERE id = 'livedeskconn01';
COMMIT;
`);
}

function loadDurations(): Durations {
  return JSON.parse(readFileSync(resolve(outDir, "live-voice/durations.json"), "utf8"));
}

async function shoot(
  context: BrowserContext,
  id: string,
  run: (page: Page, hand: Hand, beat: (id: LineId) => void, hold: (id: LineId, started: number) => Promise<void>) => Promise<void>,
) {
  const page = await context.newPage();
  const t0 = Date.now();
  const beats: Take["beats"] = {};
  const beat = (line: LineId) => {
    beats[line] = Date.now() - t0;
  };
  const hold = async (line: LineId, started: number) => {
    const need = (loadDurations()[line] + 0.35) * 1000;
    const left = need - (Date.now() - started);
    if (left > 0) await page.waitForTimeout(left);
  };
  await installHumanCursor(page);
  const hand = new Hand(page, 1);
  await run(page, hand, beat, hold);
  await page.close();
  const src = await page.video()?.path();
  if (!src) throw new Error(`No video for ${id}`);
  const file = resolve(outDir, `live-${id}.webm`);
  renameSync(src, file);
  return { id, file, beats } satisfies Take;
}

async function orbit(page: Page, dx: number, dy: number) {
  const canvas = page.locator(".live-stage canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("The room has no picture");
  const x = box.x + box.width * 0.55;
  const y = box.y + box.height * 0.48;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 28 });
  await page.mouse.up();
}

export async function recordWalk() {
  mkdirSync(outDir, { recursive: true });
  let token = "";
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const takes: Take[] = [];
  try {
    token = seed();
    dressRoom();
    browser = await chromium.launch({ headless: false, channel: "chrome" });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } },
    });
    context.setDefaultTimeout(30_000);
    await context.addCookies([
      {
        name: "colag_session",
        value: token,
        domain: new URL(base).hostname,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
      },
    ]);
    takes.push(
      await shoot(context, "floor", async (page, hand, beat, hold) => {
        await page.goto(`${base}/rooms/${roomId}`, { waitUntil: "domcontentloaded" });
        await hand.click(page.getByRole("button", { name: /^Live$/ }));
        const stage = page.locator(".live-stage");
        await stage.waitFor();
        await page.locator(".live-stage canvas").waitFor();
        speakNow();
        await page.reload({ waitUntil: "domcontentloaded" });
        await hand.click(page.getByRole("button", { name: /^Live$/ }));
        await page.locator(".live-stage canvas").waitFor();
        await page.waitForTimeout(800);
        let started = Date.now();
        beat("studio");
        await hand.hover(stage);
        await hold("studio", started);

        started = Date.now();
        beat("walk");
        await page.locator(".live-stage canvas").click();
        await page.keyboard.down("ArrowUp");
        await page.waitForTimeout(900);
        await page.keyboard.down("ArrowLeft");
        await page.waitForTimeout(700);
        await page.keyboard.up("ArrowUp");
        await page.keyboard.up("ArrowLeft");
        await hold("walk", started);

        started = Date.now();
        beat("crew");
        await orbit(page, 90, 12);
        await hold("crew", started);

        started = Date.now();
        beat("stations");
        await orbit(page, -70, 8);
        await page.mouse.wheel(0, -40);
        await hold("stations", started);

        started = Date.now();
        beat("talk");
        await page.keyboard.press(" ");
        const talk = page.locator(".live-talk");
        try {
          await talk.waitFor({ timeout: 4000 });
        } catch {
          await page.keyboard.down("ArrowDown");
          await page.waitForTimeout(600);
          await page.keyboard.up("ArrowDown");
          await page.keyboard.press(" ");
          await talk.waitFor();
        }
        await hand.typeInto(page.locator("#live-say"), "Ada, the sign-in is ready for review.", false);
        await hold("talk", started);
        await page.keyboard.press("Escape");

        started = Date.now();
        beat("client");
        await orbit(page, 50, 6);
        await hold("client", started);

        started = Date.now();
        beat("floor");
        await orbit(page, -40, -6);
        await hold("floor", started);

        started = Date.now();
        beat("close");
        await hand.hover(stage);
        await hold("close", started);
      }),
    );
    await context.close();
  } finally {
    await browser?.close();
    if (token) revokeDemo();
  }
  return takes;
}
