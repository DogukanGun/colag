import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** xAI text to speech. Female, cheerful voices: Eve (English) and Ara (German). */
export const VOICES = { en: "eve", de: "ara" } as const;
export type VoiceLanguage = keyof typeof VOICES;

export function xaiKey() {
  const raw = process.env.XAI_API_KEY || (existsSync("/tmp/colag-xai.key") ? readFileSync("/tmp/colag-xai.key", "utf8") : "");
  return raw.replace(/^["']|["']$/g, "").trim();
}

/** Removes the voice key from any text that leaves the service (errors are shown to the room and its coder). */
export function redact(text: string) {
  const key = xaiKey();
  let out = key ? text.split(key).join("[key]") : text;
  return out.replace(/xai-[A-Za-z0-9]{12,}/g, "xai-[key]").replace(/Bearer\s+[^\s"']+/g, "Bearer [key]");
}

/** Clips are cached by text + voice + language + format, so re-rendering a demo only speaks the changed lines. */
export function clipKey(text: string, voice: string, language: string, format: "wav" | "mp3") {
  return createHash("sha1").update(`${voice}|${language}|${format}|${text}`).digest("hex").slice(0, 20);
}

export interface SpeakOptions {
  voice?: string;
  language: string;
  format?: "wav" | "mp3";
  cacheDir: string;
  fetchImpl?: typeof fetch;
}

/** Speaks one line and returns the cached file. Retries rate limits and server errors twice. */
export async function speak(text: string, options: SpeakOptions) {
  const format = options.format ?? "wav";
  const voice = options.voice ?? VOICES[(options.language as VoiceLanguage) in VOICES ? (options.language as VoiceLanguage) : "en"];
  const file = path.join(options.cacheDir, `${clipKey(text, voice, options.language, format)}.${format}`);
  if (existsSync(file)) return file;
  const token = xaiKey();
  if (!token) throw new Error("XAI_API_KEY is not set: the voice-over needs xAI text to speech");
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error("XAI_API_KEY is malformed (it contains spaces or line breaks)");
  await mkdir(options.cacheDir, { recursive: true });
  const doFetch = options.fetchImpl ?? fetch;
  const call: typeof fetch = async (...args) => {
    try {
      return await doFetch(...args);
    } catch (e: any) {
      throw new Error(`The voice service could not be reached: ${redact(String(e?.message || e))}`);
    }
  };
  for (let attempt = 1; ; attempt++) {
    const response = await call("https://api.x.ai/v1/tts", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voice_id: voice,
        language: options.language,
        text_normalization: true,
        ...(format === "wav" ? { output_format: { codec: "wav", sample_rate: 24000 } } : {}),
      }),
    });
    if (response.ok) {
      const type = response.headers.get("content-type") || "";
      let bytes: Buffer;
      if (type.includes("json")) {
        const body = (await response.json()) as { audio?: string };
        if (!body.audio) throw new Error("The voice service returned no audio");
        bytes = Buffer.from(body.audio, "base64");
      } else bytes = Buffer.from(await response.arrayBuffer());
      await writeFile(file, bytes);
      return file;
    }
    const detail = redact((await response.text()).slice(0, 300));
    if (attempt >= 3 || (response.status < 500 && response.status !== 429))
      throw new Error(`Voice failed (${response.status}): ${detail}`);
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}
