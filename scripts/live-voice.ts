import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { speak, xaiKey } from "../packages/runtime/src/tts.ts";

export const lines = [
  {
    id: "studio",
    text: "This is the live room. The plan, the people, and the agents share one studio.",
  },
  {
    id: "walk",
    text: "Arrow keys carry you across the floor. You are in the room with them.",
  },
  {
    id: "crew",
    text: "Atlas keeps the plan. Ada draws the architecture. Forge builds the service. Pixel designs what you see. Sentinel reviews the change.",
  },
  {
    id: "stations",
    text: "When the work is on, they go to their stations. The board fills in, the monitors show the code, and the desk lamp comes on.",
  },
  {
    id: "talk",
    text: "Step close and press space. You talk to them here, and the room holds the line above their head.",
  },
  {
    id: "client",
    text: "Cursor sits at the desk, in the room, writing with the crew.",
  },
  {
    id: "floor",
    text: "The same floor holds the review, the demo, and the customer at the desk. You approve the merge from where you stand.",
  },
  {
    id: "close",
    text: "Walk in. The room is already at work.",
  },
] as const;

export type LineId = (typeof lines)[number]["id"];
export type Durations = Record<LineId, number>;

const outDir = resolve("demos/sales/out/live-voice");

function duration(file: string) {
  const raw = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:nw=1", file],
    { encoding: "utf8" },
  );
  return Number(raw.trim());
}

export async function generateVoice() {
  mkdirSync(outDir, { recursive: true });
  const durations = {} as Durations;
  const spoken = Boolean(xaiKey());
  for (const line of lines) {
    const file = resolve(outDir, `${line.id}.mp3`);
    if (spoken) {
      const cached = await speak(line.text, {
        voice: "eve",
        language: "en",
        format: "mp3",
        cacheDir: resolve(outDir, ".cache"),
      });
      copyFileSync(cached, file);
    } else {
      const aiff = resolve(outDir, `${line.id}.aiff`);
      execFileSync("say", ["-v", "Samantha", "-o", aiff, line.text]);
      execFileSync("ffmpeg", ["-y", "-i", aiff, "-c:a", "libmp3lame", "-q:a", "4", file]);
    }
    durations[line.id] = duration(file);
    console.log(`${line.id} ${durations[line.id].toFixed(2)}s`);
  }
  writeFileSync(resolve(outDir, "durations.json"), JSON.stringify(durations, null, 2));
}
