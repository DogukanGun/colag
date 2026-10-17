import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { speak } from "../packages/runtime/src/tts.ts";

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
    text: "That client is the coder, and the room stays closed until it is connected.",
  },
  {
    id: "coder",
    text: "The coder is named in the room. You replace them with another client. The work does not lose its coder.",
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
    id: "hosted",
    text: "Hosted Colag agents are coming. Today, your own agent does the building.",
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
  for (const line of lines) {
    const cached = await speak(line.text, {
      voice: "leo",
      language: "en",
      format: "mp3",
      cacheDir: resolve(outDir, ".cache"),
    }).catch((error: Error) => {
      throw new Error(`Voice ${line.id} failed: ${error.message}`);
    });
    const file = resolve(outDir, `${line.id}.mp3`);
    copyFileSync(cached, file);
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
