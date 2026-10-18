import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { Hand, installHumanCursor } from "./sales-human.ts";
import type { Durations, LineId } from "./sales-voice.ts";

const base = process.env.COLAG_E2E_URL || "https://colag-eight.vercel.app";
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
  const judge = process.env.COLAG_JUDGE_ROOM || "";
  if (judge && !/^[0-9a-f-]{36}$/.test(judge)) throw new Error("COLAG_JUDGE_ROOM is not a room id");
  const userId = randomBytes(16).toString("hex");
  const sessionId = randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  psql(`
BEGIN;
DELETE FROM mcp_connections WHERE user_id IN (SELECT id FROM users WHERE email='${email}');
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email='${email}');
DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email='${email}');
DELETE FROM invites WHERE created_by IN (SELECT id FROM users WHERE email='${email}')
  OR accepted_by IN (SELECT id FROM users WHERE email='${email}');
DELETE FROM users WHERE email='${email}';
INSERT INTO users(id, email, display_name) VALUES ('${userId}', '${email}', 'Alex');
INSERT INTO sessions(id, user_id, token_hash, expires_at)
  VALUES ('${sessionId}', '${userId}', '${tokenHash}', now() + interval '1 day');
${
  judge
    ? `INSERT INTO memberships(room_id, user_id, role) VALUES ('${judge}', '${userId}', 'member') ON CONFLICT DO NOTHING;`
    : ""
}
COMMIT;
`);
  return token;
}

export function revokeDemo() {
  psql(`
UPDATE mcp_connections SET revoked_at=now()
  WHERE user_id IN (SELECT id FROM users WHERE email='${email}') AND revoked_at IS NULL;
UPDATE sessions SET revoked_at=now()
  WHERE user_id IN (SELECT id FROM users WHERE email='${email}') AND revoked_at IS NULL;
DELETE FROM mcp_connections WHERE user_id IN (SELECT id FROM users WHERE email='${email}');
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email='${email}');
DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email='${email}');
DELETE FROM invites WHERE created_by IN (SELECT id FROM users WHERE email='${email}')
  OR accepted_by IN (SELECT id FROM users WHERE email='${email}');
DELETE FROM users WHERE email='${email}';
`);
}

function loadDurations(): Durations {
  return JSON.parse(readFileSync(resolve(outDir, "voice/durations.json"), "utf8"));
}

async function shoot(
  context: BrowserContext,
  id: string,
  run: (
    page: Page,
    hand: Hand,
    beat: (id: LineId) => void,
    hold: (id: LineId, started: number) => Promise<void>,
  ) => Promise<void>,
  pace = 1,
) {
  const page = await context.newPage();
  const t0 = Date.now();
  const beats: Take["beats"] = {};
  const beat = (line: LineId) => {
    beats[line] = Date.now() - t0;
  };
  const hold = async (line: LineId, started: number) => {
    const need = (loadDurations()[line] + 0.45) * 1000;
    const left = need - (Date.now() - started);
    if (left > 0) await page.waitForTimeout(left);
  };
  await installHumanCursor(page);
  const hand = new Hand(page, pace);
  await run(page, hand, beat, hold);
  await page.close();
  const src = await page.video()?.path();
  if (!src) throw new Error(`No video for ${id}`);
  const file = resolve(outDir, `${id}.webm`);
  renameSync(src, file);
  return { id, file, beats } satisfies Take;
}

export async function recordWalk() {
  mkdirSync(outDir, { recursive: true });
  const durations = loadDurations();
  let token = "";
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const takes: Take[] = [];
  try {
    token = seed();
    browser = await chromium.launch({ headless: false, channel: "chrome" });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } },
    });
    context.setDefaultTimeout(25_000);
    takes.push(
      await shoot(context, "landing", async (page, hand, beat, hold) => {
        await page.goto(base, { waitUntil: "domcontentloaded" });
        const headline = page.getByRole("heading", { name: "Sign in to Colag" });
        await headline.waitFor();
        const started = Date.now();
        beat("intro");
        await hand.move(240, 280);
        await hand.hover(headline);
        await hold("intro", started);
      }),
    );

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

    let roomUrl = "";
    takes.push(
      await shoot(context, "app", async (page, hand, beat, hold) => {
        await page.goto(base, { waitUntil: "domcontentloaded" });
        const home = page.getByRole("heading", { name: "How do you want to work?" });
        await home.waitFor();
        let started = Date.now();
        beat("bring");
        await hand.hover(home);
        await hand.click(page.getByRole("button", { name: /Bring your agent/ }));
        await hold("bring", started);

        const gate = page.getByRole("dialog", { name: "Connect a client" });
        await gate.waitFor();
        started = Date.now();
        beat("closed");
        await hand.typeInto(page.getByLabel("Client name"), "Cursor", true);
        await hand.click(page.getByRole("button", { name: "Create connection" }));
        await page.getByLabel("Token").waitFor();
        const token = await page.getByLabel("Token").inputValue();
        const server = await page.getByLabel("Server").inputValue();
        const joined = await page.request.post(server, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          data: {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "cursor", version: "1.0" },
            },
          },
        });
        if (!joined.ok()) throw new Error(`Cursor could not join the room (${joined.status()})`);
        await hand.pause(600);
        await hand.click(page.getByRole("button", { name: "Close" }));
        const client = page.getByText("Alex · Cursor");
        await client.waitFor();
        await hold("closed", started);

        started = Date.now();
        beat("coder");
        await hand.hover(client);
        await hold("coder", started);

        started = Date.now();
        beat("plan");
        const plan = page.getByLabel("Shared planning document");
        await plan.waitFor();
        await hand.typeInto(plan, "Riders request a car. The nearest driver accepts.");
        await hold("plan", started);

        started = Date.now();
        beat("board");
        await hand.click(page.getByRole("link", { name: "Colag home" }));
        await home.waitFor();
        await hand.click(page.getByRole("button", { name: /Make an app together/ }));
        const board = page.getByLabel("Shared design board");
        await board.waitFor();
        await hold("board", started);

        started = Date.now();
        beat("same");
        await hand.typeInto(board, "Ride matching");
        await hand.click(page.getByRole("button", { name: "Requirements" }));
        await hand.typeInto(
          page.locator(".requirements-body").last(),
          "A rider can request a car\nA driver accepts the nearest request",
        );
        await hand.click(page.getByRole("button", { name: "Algorithm" }));
        const steps = page.locator(".block-source").last();
        await hand.typeInto(
          steps,
          "Rider sends a request\n2. Match the nearest free driver\n3. Driver accepts the ride\n4. Start the trip",
        );
        const stepList = page.locator(".step-list").last();
        await stepList.getByText("Match the nearest free driver", { exact: true }).waitFor();
        await stepList.scrollIntoViewIfNeeded();
        await hand.hover(stepList);
        await hand.pause(1600);
        await hand.click(page.getByRole("button", { name: "Diagram" }));
        const diagram = page.locator(".block-source").last();
        await diagram.scrollIntoViewIfNeeded();
        await page.evaluate(`(() => {
          let host = document.querySelector(".ProseMirror");
          while (host && !Object.keys(host).some((name) => name.startsWith("__reactFiber$"))) host = host.parentElement;
          const key = host && Object.keys(host).find((name) => name.startsWith("__reactFiber$"));
          let fiber = key ? host[key] : null;
          let editor = null;
          while (fiber) {
            const props = fiber.memoizedProps || (fiber.stateNode && fiber.stateNode.props) || {};
            const candidate = props.editor;
            if (candidate && candidate.state && candidate.state.doc) {
              editor = candidate;
              break;
            }
            fiber = fiber.return;
          }
          if (!editor) throw new Error("editor missing");
          let from = 0;
          let to = 0;
          editor.state.doc.descendants((node, pos) => {
            if (node.type.name === "diagram") {
              from = pos + 1;
              to = pos + node.nodeSize - 1;
            }
          });
          if (to <= from) throw new Error("diagram text missing");
          editor.chain().focus().setTextSelection({ from, to }).deleteSelection().run();
        })()`);
        await hand.pause(200);
        await hand.typeInto(
          diagram,
          "flowchart TD\n  Request([Rider requests]) --> Match[Find nearest driver]\n  Match --> Accept[Driver accepts]\n  Accept --> Trip[Trip starts]",
          false,
        );
        const preview = page.locator(".diagram-preview").last();
        try {
          await preview.waitFor({ timeout: 20_000 });
        } catch (error) {
          const source = await diagram.innerText().catch(() => "");
          const message = await page.locator(".diagram-error").last().innerText().catch(() => "");
          throw new Error(`Diagram did not render.\n${source}\n${message}\n${error}`);
        }
        await preview.scrollIntoViewIfNeeded();
        await hand.hover(preview);
        await hand.pause(2200);
        await hand.click(page.getByRole("button", { name: "Drawing" }));
        const pad = page.locator(".sketch-pad");
        await pad.scrollIntoViewIfNeeded();
        await hand.stroke(pad, [
          { x: 0.12, y: 0.72 },
          { x: 0.28, y: 0.48 },
          { x: 0.46, y: 0.42 },
          { x: 0.62, y: 0.55 },
          { x: 0.84, y: 0.34 },
        ]);
        await hand.stroke(pad, [
          { x: 0.18, y: 0.28 },
          { x: 0.34, y: 0.22 },
          { x: 0.5, y: 0.3 },
        ]);
        await hand.typeInto(page.locator(".sketch-caption"), "Pickup to dropoff", true);
        await page.locator(".sketch-pad path").first().waitFor();
        await pad.scrollIntoViewIfNeeded();
        await hand.hover(pad);
        await hand.pause(1800);
        roomUrl = page.url();
        await hold("same", started);
      }, 0.82),
    );

    const judgeRoom = process.env.COLAG_JUDGE_ROOM;
    if (!judgeRoom) throw new Error("COLAG_JUDGE_ROOM is required");
    if (!roomUrl) throw new Error("The board room did not open");
    takes.push(
      await shoot(context, "room", async (page, hand, beat, hold) => {
        await page.goto(`${base}/rooms/${judgeRoom}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: /Changes/ }).waitFor();
        const changesStarted = Date.now();
        beat("changes");
        await hand.click(page.getByRole("button", { name: /Changes/ }).first());
        const change = page.getByRole("button", { name: /Code change/ });
        await change.waitFor();
        await hand.click(change);
        const diffFile = page.getByRole("button", { name: "backend/auth.mjs" });
        await diffFile.waitFor();
        await page
          .locator(".monaco-editor .view-line")
          .first()
          .waitFor({ timeout: 8_000 })
          .catch(() => undefined);
        await hand.hover(diffFile);
        await hand.pause(1200);
        await hold("changes", changesStarted);
        await hand.click(page.getByRole("button", { name: "Close details" }));
        const artifactsStarted = Date.now();
        beat("artifacts");
        await hand.click(page.getByRole("button", { name: /Artifacts/ }).first());
        const tests = page.getByRole("button", { name: /Authentication tests/ });
        await tests.waitFor();
        await hand.click(tests);
        const passed = page.getByText("register, login, authenticate, and logout passed.");
        await passed.waitFor();
        await hand.hover(passed);
        await hold("artifacts", artifactsStarted);
        await hand.click(page.getByRole("button", { name: "Close details" }));
        const buildStarted = Date.now();
        beat("build");
        await hand.click(page.getByRole("button", { name: /^Build/ }).first());
        const candidate = page.getByText("Candidate");
        await candidate.waitFor();
        await hand.hover(page.getByRole("button", { name: "Buy this build" }));
        await hold("build", buildStarted);
        const deskStarted = Date.now();
        beat("desk");
        await hand.click(page.getByRole("button", { name: /^Desk$/ }));
        const reply = page.locator(".desk-reply");
        await reply.waitFor();
        await hand.hover(reply);
        await hold("desk", deskStarted);
        const filmStarted = Date.now();
        beat("film");
        await hand.click(page.getByRole("button", { name: /^Demo/ }).first());
        const player = page.locator("video.demo-video");
        await player.waitFor();
        await player.evaluate((node) => {
          const video = node as HTMLVideoElement;
          video.currentTime = 15;
          return video.play().catch(() => undefined);
        });
        await hand.pause(900);
        await hand.hover(player);
        await hold("film", filmStarted);
        const liveStarted = Date.now();
        beat("live");
        await hand.click(page.getByRole("button", { name: /^Live$/ }));
        const stage = page.locator(".live-stage");
        await stage.waitFor();
        await hand.hover(stage);
        await hold("live", liveStarted);
      }),
    );
    takes.push(
      await shoot(context, "second", async (page, hand) => {
        await page.goto(roomUrl, { waitUntil: "domcontentloaded" });
        const board = page.getByLabel("Shared design board");
        await board.getByText("Ride matching").waitFor({ timeout: 20_000 });
        const steps = page.locator(".step-list").last();
        await steps.scrollIntoViewIfNeeded();
        await hand.hover(steps);
        await hand.pause(1400);
        const preview = page.locator(".diagram-preview").last();
        await preview.scrollIntoViewIfNeeded();
        await hand.hover(preview);
        await hand.pause(1800);
        const pad = page.locator(".sketch-pad");
        await pad.scrollIntoViewIfNeeded();
        await hand.hover(pad);
        await hand.pause(1400);
      }),
    );

    takes.push(
      await shoot(context, "soon", async (page, hand, beat, hold) => {
        await page.goto(base, { waitUntil: "domcontentloaded" });
        const soon = page.getByRole("button", { name: /Use a Colag agent/ });
        await soon.waitFor();
        await hand.hover(soon);
        await hand.click(soon);
        const roster = page.getByRole("dialog", { name: "Command an agent" });
        await roster.waitFor();
        const started = Date.now();
        beat("hosted");
        await hand.hover(roster.getByRole("button", { name: /Atlas/ }));
        await hand.pause(700);
        await hand.hover(roster.getByRole("button", { name: /Forge/ }));
        await hand.pause(500);
        await hand.hover(roster.getByRole("button", { name: /Pixel/ }));
        await hold("hosted", started);
      }),
    );
    await context.close();
  } finally {
    await browser?.close();
    if (token) revokeDemo();
  }
  return takes;
}

if (process.argv[1]?.includes("sales-walk")) {
  recordWalk()
    .then(async (takes) => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(resolve("demos/sales/out/takes.json"), JSON.stringify(takes, null, 2));
      console.log(JSON.stringify(takes, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exit(1);
    });
}
