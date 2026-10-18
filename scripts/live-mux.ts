import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Take } from "./live-walk.ts";
import { lines, type LineId } from "./live-voice.ts";

const outDir = resolve("demos/sales/out");
const cardScript = `
from PIL import Image, ImageDraw, ImageFont
import os
image = Image.new("RGB", (1920, 1080), "#101c22")
draw = ImageDraw.Draw(image)
font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 76)
def line(text, y, fill):
    box = draw.textbbox((0, 0), text, font=font)
    width = box[2] - box[0]
    draw.text(((1920 - width) / 2, y), text, font=font, fill=fill)
line(os.environ["CARD_A"], 452, "#f4f1e8")
line(os.environ["CARD_B"], 548, "#8fd0c8")
image.save(os.environ["CARD_PNG"])
`;

function probe(file: string) {
  const raw = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:nw=1", file],
    { encoding: "utf8" },
  );
  return Number(raw.trim());
}

function card(file: string, seconds: number, primary: string, secondary: string) {
  const dir = resolve(outDir, "cards");
  mkdirSync(dir, { recursive: true });
  const png = resolve(dir, `${file}.png`);
  execFileSync("python3", ["-c", cardScript], {
    env: { ...process.env, CARD_PNG: png, CARD_A: primary, CARD_B: secondary },
  });
  execFileSync("ffmpeg", [
    "-y",
    "-loop",
    "1",
    "-framerate",
    "30",
    "-i",
    png,
    "-t",
    String(seconds),
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    resolve(outDir, `${file}.mp4`),
  ]);
}

function silent(source: string, dest: string) {
  execFileSync("ffmpeg", [
    "-y",
    "-i",
    source,
    "-an",
    "-vf",
    "fps=30,scale=1920:1080",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    dest,
  ]);
}

const cueClip: Record<LineId, string> = {
  studio: "floor",
  walk: "floor",
  crew: "floor",
  stations: "floor",
  talk: "floor",
  client: "floor",
  floor: "floor",
  close: "floor",
};

export function mux(takes: Take[]) {
  mkdirSync(outDir, { recursive: true });
  card("live-title", 3.2, "The live room.", "Walk in with the crew.");
  card("live-end", 4.2, "One floor.", "People and agents, together.");
  const parts = [
    resolve(outDir, "live-title.mp4"),
    ...takes.map((take) => {
      const dest = resolve(outDir, `live-${take.id}.mp4`);
      silent(take.file, dest);
      return dest;
    }),
    resolve(outDir, "live-end.mp4"),
  ];
  const list = resolve(outDir, "live-concat.txt");
  writeFileSync(list, parts.map((file) => `file '${file}'`).join("\n"));
  const picture = resolve(outDir, "live-picture.mp4");
  execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", picture]);
  const pictureDur = probe(picture);
  const spans: { id: string; start: number }[] = [];
  let cursor = 0;
  for (const file of parts) {
    const dur = probe(file);
    const id = file.endsWith("live-title.mp4")
      ? "title"
      : file.endsWith("live-end.mp4")
        ? "end"
        : takes.find((take) => file.endsWith(`live-${take.id}.mp4`))?.id || "";
    spans.push({ id, start: cursor });
    cursor += dur;
  }
  const args = ["-y", "-i", picture];
  const filters: string[] = [];
  const labels: string[] = [];
  lines.forEach((line, index) => {
    args.push("-i", resolve(outDir, "live-voice", `${line.id}.mp3`));
    const clip = cueClip[line.id];
    const span = spans.find((item) => item.id === clip);
    if (!span) throw new Error(`No picture for ${line.id}`);
    const beat = takes.find((take) => take.id === clip)?.beats[line.id] ?? 0;
    const at = Math.round((span.start + beat / 1000) * 1000);
    filters.push(`[${index + 1}:a]adelay=${at}|${at}[a${index}]`);
    labels.push(`[a${index}]`);
  });
  filters.push(
    `${labels.join("")}amix=inputs=${lines.length}:normalize=0:duration=longest:dropout_transition=0[mix]`,
  );
  const final = resolve(outDir, "colag-live-room.mp4");
  execFileSync("ffmpeg", [
    ...args,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "0:v",
    "-map",
    "[mix]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    pictureDur.toFixed(3),
    "-movflags",
    "+faststart",
    final,
  ]);
  console.log(final);
  console.log(`${pictureDur.toFixed(1)}s`);
}
