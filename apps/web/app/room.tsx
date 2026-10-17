"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { isActiveRunStatus } from "../../../packages/protocol/src/index";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  FileText,
  Box,
  Film,
  GitBranch,
  Layers,
  Link2,
  RefreshCw,
  Square,
  MessageSquare,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { AccountMenu } from "./account";
import { api, ApiError, type User } from "./api";
import { DemoPanel, DemoVideo } from "./demo-panel";
const PlanEditor = dynamic(() => import("./plan-editor"), { ssr: false });
const DiffEditor = dynamic(() => import("./code-diff"), {
  ssr: false,
  loading: () => <div className="loading">Loading diff editor…</div>,
});
const SandboxTerminal = dynamic(() => import("./sandbox-terminal"), {
  ssr: false,
  loading: () => <div className="loading">Opening the sandbox…</div>,
});
const LiveView = dynamic(() => import("./live-view"), {
  ssr: false,
  loading: () => <div className="loading">Opening the room…</div>,
});
type Entity = {
  id: string;
  kind: string;
  data: Record<string, any>;
  version: number;
  createdAt: string;
};
type RoomEvent = {
  seq: number;
  type: string;
  actorId: string;
  timestamp: string;
  payload: Record<string, any>;
};
type Member = { id: string; displayName: string; email: string; role: string };
type Connection = {
  id: string;
  name: string;
  userId: string;
  displayName: string;
  label: string;
  live: boolean;
};
type RoomSnapshot = {
  project: Entity;
  resources: Entity[];
  events: RoomEvent[];
  presence: Record<string, any>;
  lastSeq: number;
  members: Member[];
  connections: Connection[];
  you: User;
};
const roster = [
  { name: "Atlas", role: "Coordinator", blurb: "Drafts the shared plan" },
  { name: "Ada", role: "Architect", blurb: "Writes the contract" },
  { name: "Forge", role: "Backend", blurb: "Implements the service" },
  { name: "Pixel", role: "Frontend", blurb: "Implements the interface" },
  { name: "Sentinel", role: "QA", blurb: "Reviews the candidate" },
];
const pretty = (s: string) => s.replaceAll("_", " ").replaceAll(".", " ");
export default function Room({ id }: { id: string }) {
  const router = useRouter();
  const [snap, setSnap] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState("plan");
  const [side, setSide] = useState("activity");
  const [sheet, setSheet] = useState<"" | "connect" | "agent">("");
  const [openedAsBoard, setOpenedAsBoard] = useState(false);
  const [drawer, setDrawer] = useState<Entity | null>(null);
  const [diff, setDiff] = useState<any[]>([]);
  const [file, setFile] = useState(0);
  const [clientName, setClientName] = useState("Cursor");
  const [issued, setIssued] = useState<any>(null);
  const [invite, setInvite] = useState("");
  const [picked, setPicked] = useState("Coordinator");
  const [command, setCommand] = useState("");
  const [title, setTitle] = useState("");
  const [docToken, setDocToken] = useState("");
  const [build, setBuild] = useState<{
    sha: string | null;
    ref: string | null;
    running: boolean;
    bought: boolean;
    streamUrl?: string;
  } | null>(null);
  const [sandboxError, setSandboxError] = useState("");
  const [deskMessage, setDeskMessage] = useState("How many days does a customer have to return a lamp?");
  const panelRef = useRef<HTMLElement>(null);
  const load = useCallback(async () => {
    const data = await api(`/projects/${id}`);
    setSnap(data);
    setTitle(data.project?.data?.name || "Room");
    return data as RoomSnapshot;
  }, [id]);
  useEffect(() => {
    const requested = new URLSearchParams(location.search).get("sheet");
    if (requested === "connect" || requested === "agent") setSheet(requested);
    if (requested === "board") setOpenedAsBoard(true);
    void api(`/projects/${id}/document-token`)
      .then((result) => setDocToken(result.token))
      .catch(() => {});
    void load().catch((e) => {
      if (e instanceof ApiError && e.status === 401) router.replace("/");
      else setError(e.message);
    });
  }, [load, router]);
  useEffect(() => {
    if (!snap) return;
    const source = new EventSource(
      `/api/v1/projects/${id}/events?after=${snap.lastSeq || 0}`,
      { withCredentials: true },
    );
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onmessage = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void load().then(setSnap).catch(() => {});
        }, 120);
    };
    const poll = setInterval(() => void load().catch(() => {}), 10000);
    return () => {
      source.close();
      clearInterval(poll);
      clearTimeout(timer);
    };
  }, [snap?.project?.id, id, load]);
  useEffect(() => {
    if (tab !== "build") return;
    let cancel = false;
    setSandboxError("");
    void (async () => {
      try {
        const info = await api(`/projects/${id}/build`);
        if (cancel) return;
        setBuild(info);
        if (!info.sha) return;
        const started = await api(`/projects/${id}/sandbox`, { body: {} });
        if (!cancel) setBuild(started);
      } catch (e: any) {
        if (!cancel) setSandboxError(e.message);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [tab, id]);
  useEffect(() => {
    if (!drawer) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(null);
    };
    document.addEventListener("keydown", close);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", close);
  }, [drawer]);
  const resources = snap?.resources || [];
  const runs = resources.filter(
    (x) => x.kind === "run" && x.data.purpose !== "board",
  );
  const boardRuns = resources.filter(
    (x) => x.kind === "run" && x.data.purpose === "board",
  );
  const liveBoard = boardRuns.find(
    (x) => x.data.status === "running" || x.data.status === "planning",
  );
  const latestBoard = boardRuns.at(-1);
  const boardState = liveBoard
    ? "working"
    : latestBoard && ["blocked", "failed"].includes(latestBoard.data.status)
      ? "blocked"
      : "idle";
  const designing = openedAsBoard || snap?.project?.data?.purpose === "app";
  const run = runs.find((x) => isActiveRunStatus(x.data.status)) || runs.at(-1);
  const agents = resources.filter((x) => x.kind === "agent");
  const tasks = resources.filter(
    (x) => x.kind === "task" && (!run || x.data.runId === run.id),
  );
  const decisions = resources.filter((x) => x.kind === "decision");
  const changes = resources.filter(
    (x) => x.kind === "change" && x.data.runId === run?.id,
  );
  const artifacts = resources.filter(
    (x) => x.kind === "artifact" && x.data.runId === run?.id,
  );
  const replies = resources.filter((x) => x.kind === "reply");
  const demos = resources.filter((x) => x.kind === "demo" && !x.data.deleted).reverse();
  const reviews = resources.filter(
    (x) => x.kind === "review" && x.data.runId === run?.id,
  );
  const engaged = agents.filter(
    (a) => a.data.prompted || a.data.status === "working",
  );
  const working = engaged.find((a) => a.data.status === "working");
  const prompt = [...(snap?.events || [])]
    .reverse()
    .find((e) => e.type === "agent.prompted" && e.actorId === snap?.you.id);
  async function send(c: any) {
    setBusy(c.type);
    setError("");
    try {
      await api(`/projects/${id}/commands`, { body: c });
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  async function openChange(change: Entity) {
    setDrawer(change);
    setDiff([]);
    setFile(0);
    try {
      setDiff(await api(`/projects/${id}/changes/${change.id}/diff`));
    } catch (e: any) {
      setError(e.message);
    }
  }
  function actorName(actorId: string) {
    if (actorId === "system") return "Colag";
    const member = snap?.members.find((m) => m.id === actorId);
    if (member) return member.displayName;
    const agent = agents.find((a) => a.id === actorId);
    if (agent) return agent.data.name;
    const client = snap?.connections.find(
      (c) => actorId === `mcp:${c.id}` || actorId.endsWith(c.id),
    );
    if (client) return client.label;
    return "Participant";
  }
  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
  }
  const setup = issued
    ? [
        `Server: ${issued.url}`,
        `Token: ${issued.token}`,
        "",
        "Cursor",
        JSON.stringify(issued.config.cursor, null, 2),
        "",
        "Claude Code",
        JSON.stringify(issued.config.claudeCode, null, 2),
      ].join("\n")
    : "";
  if (!snap?.you) {
    return (
      <main className="gate">
        <p>{error || "Opening the room…"}</p>
      </main>
    );
  }
  return (
    <div className="shell">
      <nav className="topbar">
        <a href="/" className="brand" aria-label="Colag home">
          <span className="logo">
            <Layers size={19} />
          </span>
          colag
        </a>
        <span className="top-divider" />
        <form
          className="room-title-form"
          onSubmit={async (e) => {
            e.preventDefault();
            await api(`/projects/${id}`, { method: "PATCH", body: { name: title } });
            await load();
          }}
        >
          <label className="sr-only" htmlFor="room-name">
            Room name
          </label>
          <input
            id="room-name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() =>
              void api(`/projects/${id}`, {
                method: "PATCH",
                body: { name: title },
              }).then(load)
            }
          />
        </form>
        <div className="top-right">
          <span className="connection">
            <span className={`dot ${connected ? "online" : ""}`} />
            {connected ? "Live" : "Reconnecting"}
          </span>
          <AccountMenu user={{ ...snap.you, displayName: snap.you.displayName }} />
        </div>
      </nav>
      {error && (
        <div className="notice error" role="alert">
          <AlertCircle size={17} />
          <span>{error}</span>
          <button className="icon-button" aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      <div className="workspace-grid">
        <aside className="team-panel">
          <div className="section-heading">
            <h2>
              <Users size={16} /> People
            </h2>
          </div>
          {snap.members.map((member) => (
            <div className="person" key={member.id}>
              <strong>{member.displayName}</strong>
              <span>{member.role === "owner" ? "Owner" : "Member"}</span>
            </div>
          ))}
          {snap.connections.map((client) => (
            <div className="person" key={client.id}>
              <strong>{client.label}</strong>
              <span>{client.live ? "Live" : "Idle"}</span>
              {client.userId === snap.you.id && (
                <button
                  className="text-button"
                  onClick={() =>
                    void api(`/projects/${id}/connections/${client.id}`, {
                      method: "DELETE",
                    }).then(load)
                  }
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
          {engaged.map((agent) => (
            <div className="person" key={agent.id}>
              <strong>{agent.data.name}</strong>
              <span>{agent.data.status === "working" ? "Working" : "Idle"}</span>
              <span className="micro">{agent.data.role}</span>
            </div>
          ))}
          {!snap.connections.length && !engaged.length && (
            <p className="panel-description">
              Nobody else is in the room until a client connects or a person accepts an invite.
            </p>
          )}
          <div className="people-actions">
            <button className="secondary small" onClick={() => setSheet("connect")}>
              Connect a client
            </button>
            <button className="secondary small" onClick={() => setSheet("agent")}>
              Command an agent
            </button>
            <button
              className="text-button"
              onClick={async () => {
                const link = await api(`/projects/${id}/invites`, { body: {} });
                setInvite(link.url);
              }}
            >
              <Link2 size={14} /> Invite someone
            </button>
            {invite && (
              <button className="text-button" onClick={() => void copy(invite)}>
                <Copy size={14} /> Copy invite link
              </button>
            )}
          </div>
          {working && (
            <div className="running-command">
              <strong>{working.data.name} is working</strong>
              <p>{prompt?.payload?.command || working.data.role}</p>
              {run && (
                <button
                  className="secondary small"
                  disabled={!!busy}
                  onClick={() => void send({ type: "run.stop", runId: run.id })}
                >
                  <Square size={13} /> Stop
                </button>
              )}
            </div>
          )}
        </aside>
        <main className="main-panel">
          <div className="tabs">
            <button className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>
              <FileText size={16} /> {designing ? "Design board" : "Shared plan"}
            </button>
            <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
              <GitBranch size={16} /> Changes <span className="count">{changes.length}</span>
            </button>
            <button className={tab === "artifacts" ? "active" : ""} onClick={() => setTab("artifacts")}>
              <Layers size={16} /> Artifacts <span className="count">{artifacts.length}</span>
            </button>
            <button className={tab === "build" ? "active" : ""} onClick={() => setTab("build")}>
              <Terminal size={16} /> Build
            </button>
            <button className={tab === "desk" ? "active" : ""} onClick={() => setTab("desk")}>
              <MessageSquare size={16} /> Desk
            </button>
            <button className={tab === "demo" ? "active" : ""} onClick={() => setTab("demo")}>
              <Film size={16} /> Demo <span className="count">{demos.length}</span>
            </button>
            <button className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}>
              <Box size={16} /> Live
            </button>
          </div>
          {run && (
            <div
              className={`run-strip ${run.data.status === "awaiting_approval" || run.data.status === "awaiting_merge" ? "approval" : ""}`}
            >
              <span className="dot online" />
              <strong>{pretty(run.data.status)}</strong>
              {run.data.status === "awaiting_approval" && (
                <button
                  className="primary small"
                  disabled={!!busy}
                  onClick={() => void send({ type: "run.approve", runId: run.id })}
                >
                  <Check size={14} /> Approve plan
                </button>
              )}
              {run.data.status === "awaiting_merge" && (
                <button
                  className="primary small"
                  onClick={() => {
                    const change = changes.find((c) => c.id === run.data.candidateChangeId);
                    if (change) void openChange(change);
                  }}
                >
                  Review and merge <ArrowRight size={14} />
                </button>
              )}
              {["failed", "blocked"].includes(run.data.status) && (
                <button
                  className="secondary small"
                  disabled={!!busy}
                  onClick={() => void send({ type: "run.retry", runId: run.id })}
                >
                  <RefreshCw size={13} /> Retry
                </button>
              )}
              {isActiveRunStatus(run.data.status) && run.data.status !== "awaiting_merge" && (
                <button
                  className="secondary small"
                  disabled={!!busy}
                  onClick={() => void send({ type: "run.stop", runId: run.id })}
                >
                  <Square size={13} /> Stop
                </button>
              )}
            </div>
          )}
          {run?.data.error && <p className="inline-error">{run.data.error}</p>}
          {tab === "live" && (
            <LiveView
              agents={agents.map((agent) => ({
                id: agent.id,
                name: agent.data.name,
                role: agent.data.role,
                status: agent.data.status,
              }))}
              events={snap.events}
              connections={snap.connections}
              members={snap.members}
              actorName={actorName}
              you={{ id: snap.you.id, displayName: snap.you.displayName }}
              onTalk={async (agentId, text) => {
                await send({ type: "agent.prompt", agentId, command: text });
              }}
            />
          )}
          {tab === "plan" && (
            <>
              <div className="document">
                <div className="document-meta">
                  <span className="eyebrow">{designing ? "DESIGN BOARD" : "SHARED PLAN"}</span>
                </div>
                <h2>{run?.data.plan?.title || title}</h2>
                {designing && (
                  <div className="board-bar" role="status">
                    <span className={`status ${boardState}`}>{boardState}</span>
                    <span>
                      {boardState === "working"
                        ? "Atlas is writing on the board."
                        : boardState === "blocked"
                          ? "Atlas stopped before a finished analysis."
                          : "Everyone edits this board. Submit it when Atlas should explain the app."}
                    </span>
                    {boardState === "working" && liveBoard ? (
                      <button
                        className="secondary small"
                        disabled={!!busy}
                        onClick={() => void send({ type: "run.stop", runId: liveBoard.id })}
                      >
                        <Square size={13} /> Stop
                      </button>
                    ) : (
                      <button
                        className="primary small"
                        disabled={!!busy}
                        onClick={() => void send({ type: "board.submit" })}
                      >
                        Submit board
                      </button>
                    )}
                  </div>
                )}
                {designing && boardState === "blocked" && latestBoard?.data.error && (
                  <p className="inline-error">{latestBoard.data.error}</p>
                )}
                {docToken ? (
                  <PlanEditor
                    token={docToken}
                    projectId={id}
                    mode={designing ? "board" : "plan"}
                  />
                ) : (
                  <p className="panel-description">Connecting the shared plan…</p>
                )}
              </div>
              {(!designing || tasks.length > 0) && <div className="tasks-section">
                <div className="section-heading">
                  <h2>
                    Tasks <span className="count">{tasks.length}</span>
                  </h2>
                </div>
                {tasks.length ? (
                  tasks.map((task) => (
                    <button className="task-row" key={task.id} onClick={() => setDrawer(task)}>
                      <span className="task-info">
                        <strong>{task.data.title}</strong>
                        <span>{task.data.role}</span>
                      </span>
                      <span className={`status ${task.data.status}`}>{pretty(task.data.status)}</span>
                      <ChevronRight size={14} />
                    </button>
                  ))
                ) : (
                  <div className="empty-tasks">
                    <strong>The plan is still open.</strong>
                    <p>Command Atlas to draft it, or connect your own client and write it together.</p>
                  </div>
                )}
              </div>}
            </>
          )}
          {tab === "changes" && (
            <div className="resource-list">
              {changes.length ? (
                changes.map((change) => (
                  <button key={change.id} className="resource-row" onClick={() => void openChange(change)}>
                    <GitBranch size={20} />
                    <span>
                      <strong>
                        {change.data.integration ? "Integration candidate" : "Code change"}
                      </strong>
                      <small>
                        {change.data.branch} · {change.data.sha?.slice(0, 8)}
                      </small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))
              ) : (
                <div className="empty-state">
                  <strong>No changes yet</strong>
                  <p>A diff appears after an agent proposes work from its own workspace.</p>
                </div>
              )}
            </div>
          )}
          {tab === "build" && (
            <div className="build-view">
              {!build?.sha ? (
                <div className="empty-state">
                  <strong>Nothing has been built</strong>
                  <p>The sandbox opens when this room has a commit to run.</p>
                </div>
              ) : (
                <>
                  <div className="build-bar">
                    <span>
                      <strong>{build.sha.slice(0, 8)}</strong>
                      <small>{build.ref === "candidate" ? "Candidate" : "Main"} · /workspace</small>
                    </span>
                    <button
                      className="secondary small"
                      disabled={!!busy || build.bought}
                      onClick={() => {
                        setBusy("buy");
                        void api(`/projects/${id}/build/buy`, { body: { sha: build.sha } })
                          .then(() => setBuild((current) => current && { ...current, bought: true }))
                          .catch((e) => setSandboxError(e.message))
                          .finally(() => setBusy(""));
                      }}
                    >
                      {build.bought ? "Bought" : "Buy this build"}
                    </button>
                    <button
                      className="primary small"
                      disabled={!build.bought || !!busy}
                      onClick={() => {
                        setBusy("download");
                        void fetch(`/api/v1/projects/${id}/build/archive`, { credentials: "include" })
                          .then(async (response) => {
                            if (!response.ok) {
                              const body = await response.json().catch(() => ({}));
                              throw new Error(body.error || "Download failed");
                            }
                            const blob = await response.blob();
                            const url = URL.createObjectURL(blob);
                            const link = document.createElement("a");
                            link.href = url;
                            link.download = `colag-${build.sha?.slice(0, 8)}.zip`;
                            link.click();
                            URL.revokeObjectURL(url);
                          })
                          .catch((e) => setSandboxError(e.message))
                          .finally(() => setBusy(""));
                      }}
                    >
                      Download project
                    </button>
                  </div>
                  {sandboxError && <p className="inline-error">{sandboxError}</p>}
                  {build.streamUrl ? (
                    <SandboxTerminal streamUrl={build.streamUrl} />
                  ) : sandboxError ? null : (
                    <div className="loading">Starting the Linux sandbox…</div>
                  )}
                </>
              )}
              {sandboxError && !build?.sha && <p className="inline-error">{sandboxError}</p>}
            </div>
          )}
          {tab === "desk" && (
            <div className="build-view">
              <form
                className="build-bar"
                onSubmit={(event) => {
                  event.preventDefault();
                  setBusy("desk");
                  setSandboxError("");
                  void api(`/projects/${id}/desk`, { body: { message: deskMessage } })
                    .then(() => load())
                    .catch((e) => setSandboxError(e.message))
                    .finally(() => setBusy(""));
                }}
              >
                <input
                  value={deskMessage}
                  onChange={(event) => setDeskMessage(event.target.value)}
                  aria-label="Customer message"
                />
                <button className="primary small" disabled={!!busy || !deskMessage.trim()}>
                  Draft reply
                </button>
              </form>
              {sandboxError && tab === "desk" && <p className="inline-error">{sandboxError}</p>}
              {replies.length ? (
                replies.map((reply) => (
                  <article key={reply.id} className="desk-reply">
                    <strong>{reply.data.message}</strong>
                    <p>
                      {reply.data.answer
                        ? reply.data.answer
                        : "The documents do not say. Nothing was drafted."}
                    </p>
                    <small>
                      {reply.data.citations?.length
                        ? reply.data.citations.join(", ")
                        : "No source"}
                      {" · "}
                      {reply.data.status}
                    </small>
                    {reply.data.status === "pending" && (
                      <div className="build-bar">
                        <button
                          className="primary small"
                          disabled={!!busy}
                          onClick={() => {
                            setBusy("approve");
                            void api(`/projects/${id}/desk/${reply.id}/approve`, { body: {} })
                              .then(() => load())
                              .catch((e) => setSandboxError(e.message))
                              .finally(() => setBusy(""));
                          }}
                        >
                          Approve
                        </button>
                        <button
                          className="secondary small"
                          disabled={!!busy}
                          onClick={() => {
                            setBusy("return");
                            void api(`/projects/${id}/desk/${reply.id}/return`, { body: {} })
                              .then(() => load())
                              .catch((e) => setSandboxError(e.message))
                              .finally(() => setBusy(""));
                          }}
                        >
                          Send back
                        </button>
                      </div>
                    )}
                  </article>
                ))
              ) : (
                <div className="empty-state">
                  <strong>No customer message yet</strong>
                  <p>A draft cites the company document it used, or it stays empty. A member sends it.</p>
                </div>
              )}
            </div>
          )}
          {tab === "demo" && (
            <DemoPanel
              roomId={id}
              demos={demos}
              hasBuild={resources.some((x) => x.kind === "run" && x.data.baseSha)}
              onChange={() => void load()}
            />
          )}
          {tab === "artifacts" && (
            <div className="resource-list">
              {artifacts.length ? (
                artifacts.map((artifact) => (
                  <button key={artifact.id} className="resource-row" onClick={() => setDrawer(artifact)}>
                    <FileText size={20} />
                    <span>
                      <strong>{artifact.data.name}</strong>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))
              ) : (
                <div className="empty-state">
                  <strong>Nothing published yet</strong>
                  <p>Test results and notes land here with the person or agent who made them.</p>
                </div>
              )}
            </div>
          )}
        </main>
        <aside className="activity-panel">
          <div className="tabs compact">
            <button className={side === "activity" ? "active" : ""} onClick={() => setSide("activity")}>
              <Activity size={15} /> Activity
            </button>
            <button className={side === "decisions" ? "active" : ""} onClick={() => setSide("decisions")}>
              Decisions <span className="count">{decisions.length}</span>
            </button>
          </div>
          {side === "activity" ? (
            <div className="timeline">
              {snap.events.length ? (
                snap.events
                  .filter((event) => event.type !== "demo.progress")
                  .slice(-35)
                  .reverse()
                  .map((event) => (
                    <div className="timeline-event" key={event.seq}>
                      <span className="event-dot" />
                      <div>
                        <div className="event-top">
                          <strong>{actorName(event.actorId)}</strong>
                          <time>
                            {new Date(event.timestamp).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </time>
                        </div>
                        <p>{pretty(event.type)}</p>
                        {event.payload.command && (
                          <span className="event-detail">{event.payload.command}</span>
                        )}
                        {event.payload.text && (
                          <span className="event-detail">{event.payload.text}</span>
                        )}
                        {event.payload.error && (
                          <span className="event-detail">{event.payload.error}</span>
                        )}
                      </div>
                    </div>
                  ))
              ) : (
                <div className="activity-empty">
                  <Activity size={24} />
                  <strong>The room is quiet.</strong>
                  <p>Commands, plan edits, and reviews show up here.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="decisions">
              {decisions.map((decision) => (
                <div className="decision" key={decision.id}>
                  <h3>{decision.data.title}</h3>
                  <p>{decision.data.description}</p>
                  {decision.data.status === "proposed" && (
                    <button
                      disabled={!!busy}
                      onClick={() =>
                        void send({
                          type: "decision.update",
                          decisionId: decision.id,
                          status: "approved",
                        })
                      }
                    >
                      <Check size={13} /> Approve
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
      {sheet && (
        <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSheet("")}>
          <section className="drawer" role="dialog" aria-modal="true" aria-label={sheet === "connect" ? "Connect a client" : "Command an agent"}>
            <div className="drawer-header">
              <h2>{sheet === "connect" ? "Connect a client" : "Command an agent"}</h2>
              <button className="icon-button" aria-label="Close" onClick={() => setSheet("")}>
                <X size={20} />
              </button>
            </div>
            {sheet === "connect" ? (
              <div className="sheet-body">
                {!issued ? (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setIssued(
                        await api(`/projects/${id}/connections`, { body: { name: clientName } }),
                      );
                      await load();
                    }}
                  >
                    <label>
                      Client name
                      <input value={clientName} onChange={(e) => setClientName(e.target.value)} required />
                    </label>
                    <p>Name the app you are connecting, such as Cursor or Claude Code.</p>
                    <button className="primary" type="submit">
                      Create connection
                    </button>
                  </form>
                ) : (
                  <>
                    <p>Copy this setup now. Colag stores only a hash of the token.</p>
                    <label>
                      Server
                      <input readOnly value={issued.url} />
                    </label>
                    <label>
                      Token
                      <input readOnly value={issued.token} type="password" />
                    </label>
                    <pre className="snippet">{setup}</pre>
                    <button className="primary" type="button" onClick={() => void copy(setup)}>
                      <Copy size={14} /> Copy connection
                    </button>
                  </>
                )}
              </div>
            ) : (
              <form
                className="sheet-body"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const agent = agents.find((a) => a.data.role === picked);
                  if (!agent) return;
                  await send({ type: "agent.prompt", agentId: agent.id, command });
                  setSheet("");
                  setCommand("");
                }}
              >
                <div className="roster">
                  {roster.map((agent) => (
                    <button
                      type="button"
                      key={agent.role}
                      className={picked === agent.role ? "selected" : ""}
                      onClick={() => setPicked(agent.role)}
                    >
                      <strong>{agent.name}</strong>
                      <span>{agent.blurb}</span>
                    </button>
                  ))}
                </div>
                <label>
                  Command
                  <textarea
                    required
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder={
                      picked === "Coordinator"
                        ? "Describe what the room should build."
                        : "Tell this agent what to do next."
                    }
                  />
                </label>
                <button className="primary" disabled={!!busy || !command.trim()} type="submit">
                  <Terminal size={14} /> Send command
                </button>
              </form>
            )}
          </section>
        </div>
      )}
      {drawer && (
        <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setDrawer(null)}>
          <section
            className={`drawer ${drawer.kind === "change" ? "wide" : ""}`}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
            ref={panelRef}
          >
            <div className="drawer-header">
              <h2>
                {drawer.data.title ||
                  drawer.data.name ||
                  (drawer.data.integration ? "Integration candidate" : "Details")}
              </h2>
              <button className="icon-button" aria-label="Close details" onClick={() => setDrawer(null)}>
                <X size={20} />
              </button>
            </div>
            {drawer.kind === "change" ? (
              <>
                <div className="diff-tabs">
                  {diff.map((entry, index) => (
                    <button
                      className={file === index ? "active" : ""}
                      key={entry.file}
                      onClick={() => setFile(index)}
                    >
                      {entry.file}
                    </button>
                  ))}
                </div>
                {diff[file] && (
                  <DiffEditor
                    height="48vh"
                    language={diff[file].file.endsWith(".md") ? "markdown" : "javascript"}
                    original={diff[file].original}
                    modified={diff[file].modified}
                    options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false } }}
                  />
                )}
                <div className="review-results">
                  {reviews
                    .filter((review) => review.data.sha === drawer.data.sha)
                    .map((review) => (
                      <p key={review.id}>{review.data.comments}</p>
                    ))}
                  {run?.data.status === "awaiting_merge" &&
                    run.data.candidateSha === drawer.data.sha && (
                      <button
                        className="primary"
                        disabled={!!busy}
                        onClick={() =>
                          void send({ type: "run.merge", runId: run.id }).then(() => setDrawer(null))
                        }
                      >
                        <CheckCircle2 size={16} /> Approve and merge
                      </button>
                    )}
                </div>
              </>
            ) : drawer.data.artifactType === "video" && drawer.data.demoId ? (
              (() => {
                const shown = demos.find((d) => d.id === drawer.data.demoId);
                return shown ? (
                  <DemoVideo roomId={id} demo={shown} />
                ) : (
                  <p className="inline-error">This demo video was deleted.</p>
                );
              })()
            ) : (
              <pre className="artifact-content">
                {drawer.data.content || drawer.data.description || drawer.data.result}
              </pre>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
