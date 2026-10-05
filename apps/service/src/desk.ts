import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DomainError, assert } from "../../../packages/domain/src/index.ts";
import type { Actor } from "../../../packages/protocol/src/index.ts";
import * as store from "./store.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const deskCorpus = path.resolve(here, "../../../fixtures/desk");
const app = path.resolve(here, "../../../hackathon/amd-academy/mc3/app.py");

export type Draft = {
  answer: string;
  citations: string[];
  confidence: number;
};

export function askCorpus(query: string, corpus = deskCorpus): Promise<Draft> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python3",
      [app, "--corpus", corpus, "--query-id", "desk", "--query", query, "--stdout"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new DomainError("unavailable", err.trim() || "The desk could not read the documents", 503));
        return;
      }
      try {
        const parsed = JSON.parse(out) as Draft;
        resolve({
          answer: typeof parsed.answer === "string" ? parsed.answer : "",
          citations: Array.isArray(parsed.citations) ? parsed.citations : [],
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
        });
      } catch {
        reject(new DomainError("unavailable", "The desk returned an unreadable draft", 503));
      }
    });
  });
}

export async function draftReply(actor: Actor, message: string) {
  assert(actor.type === "human", "Only a member can ask the desk", "forbidden", 403);
  const trimmed = message.trim();
  assert(trimmed.length > 0, "A customer message is required");
  const draft = await askCorpus(trimmed);
  return store.create(
    "reply",
    {
      message: trimmed,
      answer: draft.answer,
      citations: draft.citations,
      confidence: draft.confidence,
      status: "pending",
    },
    "desk.drafted",
    actor,
  );
}

export async function settle(actor: Actor, id: string, status: "approved" | "returned") {
  assert(actor.type === "human", "Only a member can send a reply", "forbidden", 403);
  const existing = await store.get(id);
  assert(existing.kind === "reply" && existing.projectId === actor.projectId, "Reply not found", "not_found", 404);
  assert(existing.data.status === "pending", "This reply was already settled", "conflict", 409);
  return store.update(id, { status }, status === "approved" ? "desk.approved" : "desk.returned", actor);
}
