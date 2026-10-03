"use client";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  Node,
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  mergeAttributes,
  type ReactNodeViewProps,
} from "@tiptap/react";
import * as Y from "yjs";

const Requirements = Node.create({
  name: "requirements",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: "section[data-requirements]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "section",
    mergeAttributes(HTMLAttributes, { "data-requirements": "" }),
    0,
  ],
  addNodeView: () => ReactNodeViewRenderer(RequirementsView),
});
function RequirementsView() {
  return (
    <NodeViewWrapper className="board-block">
      <span className="block-label">Requirements</span>
      <NodeViewContent className="requirements-body" />
    </NodeViewWrapper>
  );
}

const Algorithm = Node.create({
  name: "algorithm",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: "pre[data-algorithm]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "pre",
    mergeAttributes(HTMLAttributes, { "data-algorithm": "" }),
    ["code", 0],
  ],
  addNodeView: () => ReactNodeViewRenderer(AlgorithmView),
});
function AlgorithmView({ node }: ReactNodeViewProps) {
  const steps = node.textContent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\d+[.)]\s*/, ""));
  return (
    <NodeViewWrapper className="board-block">
      <span className="block-label">Algorithm</span>
      <NodeViewContent className="block-source" />
      {steps.length ? (
        <ol className="step-list">
          {steps.map((step, index) => (
            <li key={`${index}-${step}`}>{step}</li>
          ))}
        </ol>
      ) : (
        <p className="block-hint">The steps show up here as you write them.</p>
      )}
    </NodeViewWrapper>
  );
}

const Diagram = Node.create({
  name: "diagram",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      id: { default: "" },
      notation: { default: "mermaid" },
    };
  },
  parseHTML: () => [{ tag: "pre[data-diagram]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "pre",
    mergeAttributes(HTMLAttributes, { "data-diagram": "" }),
    ["code", 0],
  ],
  addNodeView: () => ReactNodeViewRenderer(DiagramView),
});
function DiagramView({ node }: ReactNodeViewProps) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const source = node.textContent;
  useEffect(() => {
    const trimmed = source.trim();
    if (!trimmed) {
      setSvg("");
      setError("");
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void import("mermaid").then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          fontFamily: "inherit",
        });
        try {
          const { svg: drawn } = await mermaid.render(
            `m${Math.random().toString(36).slice(2)}`,
            trimmed,
          );
          if (!cancelled) {
            setSvg(drawn);
            setError("");
          }
        } catch (e) {
          if (!cancelled) {
            setSvg("");
            setError(e instanceof Error ? e.message : "Diagram could not be drawn");
          }
        }
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source]);
  const label = node.attrs.notation === "bpmn" ? "BPMN" : "Diagram";
  return (
    <NodeViewWrapper className="board-block">
      <span className="block-label">{label}</span>
      <NodeViewContent className="block-source" />
      {svg ? (
        <div className="diagram-preview" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : null}
      {error ? <p className="diagram-error">{error}</p> : null}
    </NodeViewWrapper>
  );
}

const Sketch = Node.create<{ document: Y.Doc | null }>({
  name: "sketch",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addOptions() {
    return { document: null };
  },
  addAttributes() {
    return {
      id: { default: "" },
      caption: { default: "" },
    };
  },
  parseHTML: () => [{ tag: "figure[data-sketch]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "figure",
    mergeAttributes(HTMLAttributes, { "data-sketch": "" }),
  ],
  addNodeView() {
    return ReactNodeViewRenderer(SketchView, {
      stopEvent: ({ event }) => {
        const target = event.target;
        return target instanceof Element
          ? !!target.closest(".sketch-pad, .sketch-caption")
          : false;
      },
    });
  },
});
function SketchView({ node, updateAttributes, extension }: ReactNodeViewProps) {
  const document = (extension.options as { document?: Y.Doc | null }).document ?? null;
  const id = String(node.attrs.id || "");
  const [paths, setPaths] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  useEffect(() => {
    if (!document || !id) return;
    const map = document.getMap<Y.Array<string>>("sketches");
    let list = map.get(id);
    let stopped = false;
    const sync = () => {
      if (stopped) return;
      const next = map.get(id);
      if (next && next !== list) {
        list?.unobserve(sync);
        list = next;
        list.observe(sync);
      }
      setPaths(next ? next.toArray() : []);
    };
    map.observe(sync);
    list?.observe(sync);
    sync();
    return () => {
      stopped = true;
      map.unobserve(sync);
      list?.unobserve(sync);
    };
  }, [document, id]);
  function point(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.round(((event.clientX - rect.left) / rect.width) * 320);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * 140);
    return { x, y };
  }
  return (
    <NodeViewWrapper className="board-block">
      <span className="block-label">Drawing</span>
      <input
        className="sketch-caption"
        value={node.attrs.caption || ""}
        placeholder="What is this drawing?"
        onChange={(event) => updateAttributes({ caption: event.target.value })}
      />
      <svg
        className="sketch-pad"
        viewBox="0 0 320 140"
        onPointerDown={(event) => {
          const p = point(event);
          draftRef.current = `M ${p.x} ${p.y}`;
          setDraft(draftRef.current);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!draftRef.current) return;
          const p = point(event);
          draftRef.current = `${draftRef.current} L ${p.x} ${p.y}`;
          setDraft(draftRef.current);
        }}
        onPointerUp={() => {
          const path = draftRef.current;
          draftRef.current = "";
          setDraft("");
          if (!document || !id || path.split(" ").length <= 4) return;
          const map = document.getMap<Y.Array<string>>("sketches");
          document.transact(() => {
            let list = map.get(id);
            if (!list) {
              list = new Y.Array<string>();
              map.set(id, list);
            }
            list.push([path]);
          });
        }}
      >
        {paths.map((path, index) => (
          <path key={`${index}-${path.slice(0, 12)}`} d={path} />
        ))}
        {draft ? <path d={draft} /> : null}
      </svg>
    </NodeViewWrapper>
  );
}

export function boardExtensions(document: Y.Doc) {
  return [Requirements, Algorithm, Diagram, Sketch.configure({ document })];
}
