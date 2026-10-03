"use client";
import { useEffect, useMemo, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { boardExtensions } from "./board-blocks";
export default function PlanEditor({
  token,
  projectId,
  mode = "plan",
}: {
  token: string;
  projectId: string;
  mode?: "plan" | "board";
}) {
  const doc = useMemo(() => new Y.Doc(), [projectId]);
  const [connected, setConnected] = useState(false);
  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        ...boardExtensions(doc),
        Collaboration.configure({ document: doc }),
      ],
      editorProps: {
        attributes: {
          "aria-label":
            mode === "board" ? "Shared design board" : "Shared planning document",
          class: mode === "board" ? "plan-content board" : "plan-content",
        },
      },
    },
    [doc, mode],
  );
  useEffect(() => {
    const provider = new HocuspocusProvider({
      url:
        process.env.NEXT_PUBLIC_COLLAB_URL ||
        `ws://${window.location.hostname}:4311`,
      name: projectId,
      document: doc,
      token,
      onStatus: ({ status }) => setConnected(status === "connected"),
    });
    return () => {
      provider.destroy();
      doc.destroy();
    };
  }, [doc, projectId, token]);
  return (
    <>
      <div className="editor-toolbar">
        <div>
          <button
            type="button"
            aria-label="Bold text"
            className={editor?.isActive("bold") ? "selected" : ""}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <b>B</b>
          </button>
          <button
            type="button"
            aria-label="Italic text"
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <i>I</i>
          </button>
          <button
            type="button"
            aria-label="Heading"
            onClick={() =>
              editor?.chain().focus().toggleHeading({ level: 2 }).run()
            }
          >
            H₂
          </button>
          <button
            type="button"
            aria-label="Bullet list"
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            ≡
          </button>
          <button
            type="button"
            className="tool-label"
            onClick={() =>
              editor
                ?.chain()
                .focus()
                .insertContent({
                  type: "requirements",
                  content: [{ type: "paragraph" }],
                })
                .run()
            }
          >
            Requirements
          </button>
          <button
            type="button"
            className="tool-label"
            onClick={() =>
              editor
                ?.chain()
                .focus()
                .insertContent({
                  type: "algorithm",
                  content: [{ type: "text", text: "1. " }],
                })
                .run()
            }
          >
            Algorithm
          </button>
          <button
            type="button"
            className="tool-label"
            onClick={() =>
              editor
                ?.chain()
                .focus()
                .insertContent({
                  type: "diagram",
                  attrs: { id: crypto.randomUUID(), notation: "mermaid" },
                  content: [
                    {
                      type: "text",
                      text: "flowchart TD\n  Start([Start]) --> Next[Next step]",
                    },
                  ],
                })
                .run()
            }
          >
            Diagram
          </button>
          <button
            type="button"
            className="tool-label"
            onClick={() =>
              editor
                ?.chain()
                .focus()
                .insertContent({
                  type: "sketch",
                  attrs: { id: crypto.randomUUID(), caption: "" },
                })
                .run()
            }
          >
            Drawing
          </button>
        </div>
        <span className="micro">
          <span className={`dot ${connected ? "online" : ""}`} />
          {connected ? "Synced" : "Connecting document"}
        </span>
      </div>
      <EditorContent editor={editor} />
    </>
  );
}
