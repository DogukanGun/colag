"use client";
import { useState } from "react";
import { Copy, Download, Film, Play, RefreshCw, Trash2 } from "lucide-react";
import { api } from "./api";

type Entity = { id: string; kind: string; data: Record<string, any> };

const STARTER = {
  app: { start: "dev:web", port: 4401, api: { start: "dev:api", port: 4400 } },
  steps: [
    { do: "hover", target: "h1", say: "Here is what we built today. Let's take a quick look!" },
    { do: "type", target: "#email", value: "ada@example.com", say: "Type an e-mail address," },
    { do: "click", target: 'role=button[name="Sign up"]', say: "and you're in. That's it!" },
  ],
};

const PHASES: Record<string, string> = {
  queued: "Waiting for the recorder",
  preparing: "Preparing",
  voice: "Recording the voice",
  exporting: "Exporting the build",
  installing: "Installing the app",
  "starting app": "Starting the app",
  recording: "Filming",
  encoding: "Encoding",
  editing: "Cutting to the voice",
  mixing: "Mixing voice and music",
  "email kit": "Making the e-mail kit",
};

export function progressText(demo: Entity) {
  const p = demo.data.progress;
  if (!p) return demo.data.status === "queued" ? PHASES.queued : "Working…";
  const label = PHASES[p.phase] || p.phase;
  return p.step ? `${label} · step ${p.step} of ${p.of}` : label;
}

function fileUrl(roomId: string, demoId: string, name: string, download = false) {
  return `/api/v1/projects/${roomId}/demos/${demoId}/files/${name}${download ? "?download" : ""}`;
}

export function DemoVideo({ roomId, demo }: { roomId: string; demo: Entity }) {
  const files: string[] = demo.data.files || [];
  if (!files.includes("video.mp4")) return null;
  return (
    <video
      className="demo-video"
      controls
      preload="metadata"
      poster={files.includes("thumbnail.png") ? fileUrl(roomId, demo.id, "thumbnail.png") : undefined}
      src={fileUrl(roomId, demo.id, "video.mp4")}
    />
  );
}

function Editor({
  roomId,
  demo,
  onDone,
}: {
  roomId: string;
  demo?: Entity;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(demo?.data.title || "");
  const [language, setLanguage] = useState<"en" | "de">(demo?.data.language || "en");
  const [music, setMusic] = useState<boolean>(demo?.data.music ?? true);
  const [emailKit, setEmailKit] = useState<boolean>(demo?.data.emailKit ?? true);
  const [script, setScript] = useState(JSON.stringify(demo?.data.spec || STARTER, null, 2));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="demo-editor"
      onSubmit={(event) => {
        event.preventDefault();
        let spec: unknown;
        try {
          spec = JSON.parse(script);
        } catch {
          setError("The script is not valid JSON");
          return;
        }
        setSaving(true);
        setError("");
        const body = { title, language, music, emailKit, spec };
        void (demo
          ? api(`/projects/${roomId}/demos/${demo.id}`, { method: "PATCH", body })
          : api(`/projects/${roomId}/demos`, { body }))
          .then(onDone)
          .catch((e) => setError(e.message))
          .finally(() => setSaving(false));
      }}
    >
      <div className="demo-editor-row">
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sign-up in 30 seconds" />
        </label>
        <label>
          Voice
          <select value={language} onChange={(e) => setLanguage(e.target.value as "en" | "de")}>
            <option value="en">English (Eve)</option>
            <option value="de">German (Ara)</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={music} onChange={(e) => setMusic(e.target.checked)} /> Music
        </label>
        <label className="check">
          <input type="checkbox" checked={emailKit} onChange={(e) => setEmailKit(e.target.checked)} /> E-mail kit
        </label>
      </div>
      <label>
        Script
        <textarea
          className="demo-script"
          spellCheck={false}
          value={script}
          onChange={(e) => setScript(e.target.value)}
          rows={14}
        />
      </label>
      <small className="muted">
        app: the npm script that starts the build and its port (plus an optional API). steps: goto, click, type, press,
        hover, scroll or wait, each with an optional voice line in say.
      </small>
      {error && <p className="inline-error">{error}</p>}
      <div className="build-bar">
        <button className="primary small" disabled={saving || !title.trim()}>
          {demo ? "Save script" : "Create demo"}
        </button>
        <button type="button" className="secondary small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function DemoPanel({
  roomId,
  demos,
  hasBuild,
  onChange,
}: {
  roomId: string;
  demos: Entity[];
  hasBuild: boolean;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState("");
  const act = (key: string, call: Promise<unknown>) => {
    setBusy(key);
    setError("");
    void call
      .then(onChange)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(""));
  };
  return (
    <div className="build-view demo-view">
      <div className="build-bar">
        <span>
          <strong>Demo videos</strong>
          <small>
            Your coder writes the script with the create_demo_video tool. Colag films the current build in a sandbox,
            adds a cheerful voice and music, and keeps the video here.
          </small>
        </span>
        <button className="secondary small" disabled={!hasBuild || editing === "new"} onClick={() => setEditing("new")}>
          <Film size={15} /> New demo
        </button>
      </div>
      {error && <p className="inline-error">{error}</p>}
      {editing === "new" && <Editor roomId={roomId} onDone={() => (setEditing(null), onChange())} />}
      {!demos.length && editing !== "new" && (
        <div className="empty-state">
          <strong>{hasBuild ? "No demo yet" : "Nothing has been built"}</strong>
          <p>
            {hasBuild
              ? "Ask your coder: “Make a 40-second demo video of the sign-up, in English, with music.”"
              : "A demo films the room's build, so it starts once this room has a commit."}
          </p>
        </div>
      )}
      {demos.map((demo) => {
        const d = demo.data;
        const files: string[] = d.files || [];
        const working = ["queued", "rendering"].includes(d.status);
        return (
          <article key={demo.id} className="demo-card">
            <header className="build-bar">
              <span>
                <strong>{d.title}</strong>
                <small>
                  {d.language === "de" ? "German" : "English"} · {d.spec?.steps?.length || 0} steps
                  {d.music ? " · music" : ""}
                  {d.sha ? ` · build ${String(d.sha).slice(0, 8)}` : ""}
                  {d.duration ? ` · ${Math.round(d.duration)} s` : ""}
                  {d.createdByName ? ` · by ${d.createdByName}` : ""}
                </small>
              </span>
              <div className={`demo-status ${d.status}`}>{working ? progressText(demo) : d.status}</div>
            </header>
            {d.status === "ready" && <DemoVideo roomId={roomId} demo={demo} />}
            {d.status === "failed" && (
              <div className="demo-failed">
                <p className="inline-error">{d.error}</p>
                {files.includes("fail.png") && (
                  <img src={fileUrl(roomId, demo.id, "fail.png")} alt="The app when the step failed" />
                )}
              </div>
            )}
            {editing === demo.id && <Editor roomId={roomId} demo={demo} onDone={() => (setEditing(null), onChange())} />}
            <div className="build-bar demo-actions">
              <button
                className="primary small"
                disabled={working || !!busy || !hasBuild}
                onClick={() => act(`render-${demo.id}`, api(`/projects/${roomId}/demos/${demo.id}/render`, { body: {} }))}
              >
                {d.status === "draft" ? <Play size={15} /> : <RefreshCw size={15} />}
                {d.status === "draft" ? "Render" : "Render again"}
              </button>
              {editing !== demo.id && (
                <button className="secondary small" disabled={working} onClick={() => setEditing(demo.id)}>
                  Edit script
                </button>
              )}
              {d.status === "ready" &&
                [
                  ["video.mp4", "MP4"],
                  ["preview.gif", "GIF"],
                  ["thumbnail.png", "Thumbnail"],
                  ["subtitles.srt", "Subtitles"],
                ]
                  .filter(([name]) => files.includes(name))
                  .map(([name, label]) => (
                    <a key={name} className="secondary small" href={fileUrl(roomId, demo.id, name, true)}>
                      <Download size={14} /> {label}
                    </a>
                  ))}
              {d.status === "ready" && files.includes("thumbnail.png") && (
                <button
                  className="secondary small"
                  title="An e-mail snippet: the thumbnail, linked to the video. Upload both files where you host images, then replace the two links."
                  onClick={() => {
                    const html = `<a href="VIDEO_URL"><img src="THUMBNAIL_URL" width="600" alt="${String(d.title).replace(/"/g, "&quot;")} – play the video" style="display:block;border:0;border-radius:12px;max-width:100%"></a>`;
                    void navigator.clipboard.writeText(html).then(() => {
                      setCopied(demo.id);
                      setTimeout(() => setCopied(""), 2000);
                    });
                  }}
                >
                  <Copy size={14} /> {copied === demo.id ? "Copied" : "E-mail HTML"}
                </button>
              )}
              <button
                className="secondary small demo-delete"
                disabled={working || !!busy}
                aria-label={`Delete ${d.title}`}
                onClick={() => {
                  if (confirm(`Delete the demo “${d.title}” and its files?`))
                    act(`delete-${demo.id}`, api(`/projects/${roomId}/demos/${demo.id}`, { method: "DELETE" }));
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
