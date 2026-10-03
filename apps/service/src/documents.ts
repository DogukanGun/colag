import { randomUUID } from "node:crypto";
import type { Actor } from "../../../packages/protocol/src/index.ts";
import { assert } from "../../../packages/domain/src/index.ts";
import { hash } from "../../../packages/database/src.ts";
import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { pool } from "../../../packages/database/src.ts";
import { authorize } from "../../../packages/domain/src/index.ts";
import { authenticate } from "./store.ts";
const contributors = new Map<string, Set<string>>();
export const collaboration = new Server({
  port: Number(process.env.COLAG_COLLAB_PORT || 4311),
  address: process.env.COLAG_HOST || "127.0.0.1",
  quiet: true,
  debounce: 500,
  maxDebounce: 1500,
  async onAuthenticate({ token, documentName }) {
    const actor = await authenticate(token);
    authorize(actor, documentName, "document.write");
    return { actor };
  },
  async onLoadDocument({ document, documentName }) {
    const r = await pool.query(
      "SELECT state FROM documents WHERE project_id=$1",
      [documentName],
    );
    if (r.rows[0]) Y.applyUpdate(document, r.rows[0].state);
    return document;
  },
  async onChange({ documentName, context }) {
    const ids = contributors.get(documentName) || new Set<string>();
    ids.add(context?.actor?.id || "system");
    contributors.set(documentName, ids);
  },
  async onStoreDocument({ document, documentName }) {
    const actors = contributors.get(documentName) || new Set<string>();
    contributors.delete(documentName);
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        documentName,
      ]);
      await db.query(
        "INSERT INTO documents(project_id,state) VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET state=$2,updated_at=now()",
        [documentName, Buffer.from(Y.encodeStateAsUpdate(document))],
      );
      for (const actorId of actors)
        await db.query(
          "INSERT INTO events(id,project_id,actor_id,type,resource_id,payload) VALUES($1,$2,$3,$4,$5,$6)",
          [
            randomUUID(),
            documentName,
            actorId,
            "document.updated",
            `document-${documentName}`,
            { source: "yjs" },
          ],
        );
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      const pending = contributors.get(documentName) || new Set<string>();
      for (const id of actors) pending.add(id);
      contributors.set(documentName, pending);
      throw e;
    } finally {
      db.release();
    }
  },
});
/** Agent writes append. They must not replace concurrent edits on the board. */
export const AGENT_DOCUMENT_APPEND = true;
function pushInline(frag: Y.XmlFragment, line: string) {
  const heading = line.match(/^(#{1,3})\s+(.+)$/);
  const p = new Y.XmlElement(heading ? "heading" : "paragraph");
  if (heading) p.setAttribute("level", String(heading[1].length));
  const t = new Y.XmlText();
  const value = heading ? heading[2] : line;
  let offset = 0;
  for (const part of value.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)) {
    if (part.startsWith("`") && part.endsWith("`")) {
      const content = part.slice(1, -1);
      t.insert(offset, content, { code: {} });
      offset += content.length;
    } else if (part.startsWith("**") && part.endsWith("**")) {
      const content = part.slice(2, -2);
      t.insert(offset, content, { bold: {} });
      offset += content.length;
    } else {
      t.insert(offset, part);
      offset += part.length;
    }
  }
  p.insert(0, [t]);
  frag.push([p]);
}
function pushSource(
  frag: Y.XmlFragment,
  name: string,
  source: string,
  attrs?: Record<string, string>,
) {
  const el = new Y.XmlElement(name);
  if (attrs)
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  const text = new Y.XmlText();
  if (source) text.insert(0, source);
  el.insert(0, [text]);
  frag.push([el]);
}
export function applyDocumentText(doc: Y.Doc, text: string, append: boolean) {
  const frag = doc.getXmlFragment("default");
  if (!append) frag.delete(0, frag.length);
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].trim().match(/^```(mermaid|algorithm|bpmn)\s*$/i);
    if (open) {
      const kind = open[1].toLowerCase();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const source = body.join("\n").replace(/\n$/, "");
      if (kind === "algorithm") pushSource(frag, "algorithm", source);
      else
        pushSource(frag, "diagram", source, {
          id: randomUUID(),
          notation: kind === "bpmn" ? "bpmn" : "mermaid",
        });
      continue;
    }
    const line = lines[i];
    i += 1;
    if (!line.trim()) continue;
    pushInline(frag, line);
  }
}
function inlineText(el: Y.XmlElement) {
  let text = "";
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i);
    if (child instanceof Y.XmlText) text += child.toString();
    else if (child instanceof Y.XmlElement) {
      text += child.nodeName === "hardBreak" ? "\n" : inlineText(child);
    }
  }
  return text;
}
function childBlocks(doc: Y.Doc, el: Y.XmlElement): string {
  const parts: string[] = [];
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i);
    if (child instanceof Y.XmlElement) {
      const text = elementText(doc, child);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}
function elementText(doc: Y.Doc, el: Y.XmlElement): string {
  const name = el.nodeName;
  if (name === "heading") {
    const level = Math.min(6, Math.max(1, Number(el.getAttribute("level") || "1")));
    return `${"#".repeat(level)} ${inlineText(el)}`.trimEnd();
  }
  if (name === "paragraph") return inlineText(el);
  if (name === "algorithm") return "```algorithm\n" + inlineText(el) + "\n```";
  if (name === "diagram" || name === "codeBlock") {
    const lang = name === "diagram" ? "mermaid" : el.getAttribute("language") || "";
    return "```" + lang + "\n" + inlineText(el) + "\n```";
  }
  if (name === "sketch") {
    const caption = el.getAttribute("caption") || "";
    const id = el.getAttribute("id") || "";
    const strokes = id
      ? doc.getMap<Y.Array<string>>("sketches").get(id)?.length || 0
      : 0;
    const label = caption ? `Drawing: ${caption}` : "Drawing";
    return strokes ? `${label} (${strokes} strokes)` : label;
  }
  if (name === "requirements") {
    const inner = childBlocks(doc, el);
    return inner ? `Requirements:\n${inner}` : "Requirements:";
  }
  if (name === "listItem") return `- ${childBlocks(doc, el) || inlineText(el)}`;
  if (name === "bulletList" || name === "orderedList" || name === "blockquote")
    return childBlocks(doc, el);
  return childBlocks(doc, el) || inlineText(el);
}
export function documentPlainText(doc: Y.Doc) {
  const frag = doc.getXmlFragment("default");
  const parts: string[] = [];
  for (let i = 0; i < frag.length; i++) {
    const child = frag.get(i);
    if (child instanceof Y.XmlElement) {
      const text = elementText(doc, child);
      if (text) parts.push(text);
    } else if (child instanceof Y.XmlText) {
      const text = child.toString();
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}
export async function writeDocument(
  projectId: string,
  text: string,
  append = false,
  operation?: { key: string; actor: Actor },
) {
  const conn = await collaboration.hocuspocus.openDirectConnection(
    projectId,
    operation ? { actor: operation.actor } : undefined,
  );
  try {
    await conn.transact((doc) => {
      if (operation) {
        const ledger = doc.getMap("operations");
        const key = `${operation.actor.id}:${operation.key}`,
          fingerprint = hash(text);
        if (ledger.has(key)) {
          assert(
            ledger.get(key) === fingerprint,
            "Idempotency key reused for different document edit",
            "conflict",
            409,
          );
          return;
        }
        ledger.set(key, fingerprint);
      }
      applyDocumentText(doc, text, append);
    });
  } finally {
    await conn.disconnect();
  }
}
export async function readDocument(projectId: string) {
  const conn = await collaboration.hocuspocus.openDirectConnection(projectId);
  try {
    return conn.document ? documentPlainText(conn.document) : "";
  } finally {
    await conn.disconnect();
  }
}
