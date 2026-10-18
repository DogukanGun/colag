import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { speak, xaiKey } from "../packages/runtime/src/tts.ts";

export const lines = [
  {
    id: "intro",
    text: "Colag is one room for the people and the agent who build together.",
  },
  {
    id: "bring",
    text: "You bring Cursor or Claude Code.",
  },
  {
    id: "closed",
    text: "You name the client, and it joins the room over Colag's own connection.",
  },
  {
    id: "coder",
    text: "The client is named in the room, next to you.",
  },
  {
    id: "plan",
    text: "The plan is shared. What you write is what gets built.",
  },
  {
    id: "board",
    text: "Or start from one board. You connect the coder, and everyone writes in the same document.",
  },
  {
    id: "same",
    text: "Requirements, the algorithm, and a diagram take shape on the board. The sketch is the same drawing for everyone in the room.",
  },
  {
    id: "changes",
    text: "Changes stays empty until an agent proposes a diff. A member reviews it and merges.",
  },
  {
    id: "artifacts",
    text: "Test results and notes are published here, with the name of who made them.",
  },
  {
    id: "build",
    text: "The sandbox runs the room's commit. There is nothing to run until a build exists.",
  },
  {
    id: "desk",
    text: "The desk answers a customer only from the company documents. A member approves the reply.",
  },
  {
    id: "film",
    text: "A demo films that build, speaks with a voice, and keeps the video in the room.",
  },
  {
    id: "live",
    text: "Live is the room itself, while the people and the agents are working.",
  },
  {
    id: "hosted",
    text: "Hosted agents run on AMD Token Factory. DeepSeek on AMD GPUs plans the work, and you still approve and merge.",
  },
  {
    id: "cta",
    text: "Connect a client. Build in one room.",
  },
] as const;

export type LineId = (typeof lines)[number]["id"];
export type Durations = Record<LineId, number>;

const outDir = resolve("demos/sales/out/voice");

function duration(file: string) {
  const raw = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nokey=1:nw=1",
      file,
    ],
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
      }).catch((error: Error) => {
        throw new Error(`Voice ${line.id} failed: ${error.message}`);
      });
      copyFileSync(cached, file);
    } else {
      const aiff = resolve(outDir, `${line.id}.aiff`);
      execFileSync("say", ["-v", "Samantha", "-o", aiff, line.text]);
      execFileSync("ffmpeg", ["-y", "-i", aiff, "-codec:a", "libmp3lame", "-qscale:a", "4", file]);
    }
    durations[line.id] = duration(file);
    console.log(`${line.id} ${durations[line.id].toFixed(2)}s`);
  }
  writeFileSync(resolve(outDir, "durations.json"), JSON.stringify(durations, null, 2));
  return durations;
}

if (process.argv[1]?.includes("sales-voice")) {
  generateVoice().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
