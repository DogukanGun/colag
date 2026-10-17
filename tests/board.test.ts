import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import pg from "pg";
import * as Y from "yjs";
process.env.NODE_ENV = "test";
import { pool } from "../packages/database/src.ts";
import { authorize } from "../packages/domain/src/index.ts";
import {
  EXTERNAL_MCP_PERMISSIONS,
  MEMBER_ACTIONS,
} from "../packages/protocol/src/index.ts";
import { commandSchema } from "../packages/protocol/src/validation.ts";
import {
  AGENT_DOCUMENT_APPEND,
  applyDocumentText,
  documentPlainText,
} from "../apps/service/src/documents.ts";
import * as engine from "../apps/service/src/engine.ts";

after(async () => {
  await pool.end();
});

const analysis = [
  "## General analysis",
  "A rider requests a car and a driver accepts. The map is the home screen.",
  "## Page map",
  "```mermaid",
  "flowchart TD",
  "  Home --> Request",
  "```",
  "## Algorithms",
  "```algorithm",
  "1. Request a ride",
  "2. Match a driver",
  "```",
  "## Request a ride",
  "```mermaid",
  "flowchart TD",
  "  Start([Start]) --> Task[Request a ride]",
  "  Task --> End([End])",
  "```",
].join("\n");

async function postgresReachable() {
  const client = new pg.Client({
    connectionString:
      process.env.DATABASE_URL || "postgres://colag:colag@127.0.0.1:54329/colag",
    connectionTimeoutMillis: 1500,
  });
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 2000),
      ),
    ]);
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

test(
  "a member can submit the board, a non-member cannot, and append does not replace the document",
  { timeout: 60000 },
  async (t) => {
    assert.equal(
      commandSchema.safeParse({ type: "board.submit" }).success,
      true,
    );
    assert.equal(MEMBER_ACTIONS.includes("board.submit"), true);
    assert.equal(EXTERNAL_MCP_PERMISSIONS.includes("board.submit"), false);
    assert.equal(AGENT_DOCUMENT_APPEND, true);
    assert.doesNotThrow(() =>
      authorize(
        {
          id: "member",
          type: "human",
          projectId: "room-a",
          permissions: [],
          rooms: ["room-a"],
        },
        "room-a",
        "board.submit",
      ),
    );
    await assert.rejects(
      () =>
        engine.command(
          {
            id: "outsider",
            type: "human",
            projectId: "room-a",
            permissions: [],
            rooms: ["room-b"],
          },
          "board-outsider",
          { type: "board.submit" },
        ),
      /membership/i,
    );
    const prompt = engine.boardPrompt("Riders draw the pickup map.");
    assert.match(prompt, /general analysis/i);
    assert.match(prompt, /page map/i);
    assert.match(prompt, /algorithm/i);
    assert.match(prompt, /BPMN/i);
    assert.match(prompt, /do not replace/i);
    assert.match(prompt, /Riders draw the pickup map/);
    const doc = new Y.Doc();
    const original = "People still see this note.";
    applyDocumentText(doc, original, AGENT_DOCUMENT_APPEND);
    applyDocumentText(
      doc,
      [
        "## General analysis",
        "A stranger can hail a car.",
        "```mermaid",
        "flowchart TD",
        "  Home --> Request",
        "```",
      ].join("\n"),
      AGENT_DOCUMENT_APPEND,
    );
    const text = documentPlainText(doc);
    assert.ok(text.startsWith(original));
    assert.match(text, /General analysis/);
    assert.match(text, /flowchart TD/);
    const frag = doc.getXmlFragment("default");
    assert.equal((frag.get(0) as Y.XmlElement).nodeName, "paragraph");
    let diagrams = 0;
    for (let i = 0; i < frag.length; i++) {
      const child = frag.get(i);
      if (child instanceof Y.XmlElement && child.nodeName === "diagram") diagrams += 1;
    }
    assert.equal(diagrams, 1);
    assert.ok(text.length > original.length);

    if (!(await postgresReachable())) {
      t.diagnostic(
        "postgres is down; member submit was not run against the database",
      );
      return;
    }
    process.env.COLAG_DATA_DIR = path.resolve(".colag/board-" + randomUUID());
    const { migrate } = await import("../packages/database/src.ts");
    const store = await import("../apps/service/src/store.ts");
    const identity = await import("../apps/service/src/identity.ts");
    const { writeDocument, readDocument } = await import(
      "../apps/service/src/documents.ts"
    );
    await migrate();
    const owner = await identity.upsertUser(
      `board-${randomUUID()}@colag.test`,
      "Ada Lovelace",
    );
    const other = await identity.upsertUser(
      `board-other-${randomUUID()}@colag.test`,
      "Grace Hopper",
    );
    const room = await store.provisionRoom(owner.id, "Design board", "app");
    const elsewhere = await store.provisionRoom(other.id, "Other room");
    const member = await identity.memberActor(owner, room.id);
    await assert.rejects(
      () =>
        engine.command(
          {
            id: other.id,
            type: "human",
            projectId: room.id,
            permissions: [],
            rooms: [elsewhere.id],
            displayName: "Grace Hopper",
          },
          randomUUID(),
          { type: "board.submit" },
        ),
      /membership/i,
    );
    engine.configureTestRuntime({
      runAgent: async (request) => {
        if (request.prompt.includes("BLOCK_THIS_BOARD"))
          throw new Error("claude: not authenticated");
        return analysis;
      },
    });
    await writeDocument(room.id, "Riders request a car from the map.", true);
    await engine.command(member, randomUUID(), { type: "board.submit" });
    let status = "";
    let error = "";
    for (let i = 0; i < 100; i++) {
      const runs = (await store.resources(room.id)).filter(
        (resource) => resource.kind === "run" && resource.data.purpose === "board",
      );
      status = runs.at(-1)?.data.status || "";
      error = runs.at(-1)?.data.error || "";
      if (status === "completed" || status === "blocked" || status === "failed")
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(status, "completed", error);
    const shared = await readDocument(room.id);
    assert.ok(shared.startsWith("Riders request a car from the map."));
    assert.match(shared, /General analysis/);
    assert.match(shared, /flowchart TD/);
    assert.match(shared, /```algorithm/);
    assert.ok(shared.length > "Riders request a car from the map.".length);

    const failed = await store.provisionRoom(owner.id, "Blocked board", "app");
    const failedMember = await identity.memberActor(owner, failed.id);
    await writeDocument(failed.id, "BLOCK_THIS_BOARD", true);
    const before = await readDocument(failed.id);
    await engine.command(failedMember, randomUUID(), { type: "board.submit" });
    status = "";
    error = "";
    for (let i = 0; i < 100; i++) {
      const runs = (await store.resources(failed.id)).filter(
        (resource) => resource.kind === "run" && resource.data.purpose === "board",
      );
      status = runs.at(-1)?.data.status || "";
      error = runs.at(-1)?.data.error || "";
      if (status === "blocked" || status === "failed" || status === "completed")
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(status, "blocked");
    assert.match(error, /not authenticated/);
    assert.equal(await readDocument(failed.id), before);
    assert.equal(before.includes("General analysis"), false);
  },
);
