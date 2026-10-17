"use client";
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  ContactShadows,
  Environment,
  Html,
  OrbitControls,
  useGLTF,
} from "@react-three/drei";
import * as THREE from "three";

export type LiveAgent = {
  id: string;
  name: string;
  role: string;
  status: string;
};
export type LiveEvent = {
  seq: number;
  type: string;
  actorId: string;
  resourceId?: string;
  timestamp: string;
  payload: Record<string, unknown>;
};
export type LiveConnection = {
  id: string;
  label: string;
  displayName: string;
  userId: string;
  live: boolean;
};
export type LiveMember = { id: string; displayName: string };

type Tool = "clipboard" | "blueprint" | "wrench" | "stylus" | "glass";
type Spot = { at: [number, number, number]; face: number };

const SPEECH_MS = 14000;
const TALK_REACH = 1.4;
const TALK_MS = 3 * 60 * 1000;
function keepInRoom(point: THREE.Vector3) {
  point.x = THREE.MathUtils.clamp(point.x, -3.7, 3.7);
  point.y = 0;
  point.z = THREE.MathUtils.clamp(point.z, -2.85, 2.85);
  return point;
}
const ROLES: {
  role: string;
  name: string;
  accent: string;
  tool: Tool;
  idle: Spot;
  work: Spot;
}[] = [
  {
    role: "Coordinator",
    name: "Atlas",
    accent: "#c4a574",
    tool: "clipboard",
    idle: { at: [-1.15, 0, 1.05], face: 0.5 },
    work: { at: [-1.25, 0, -2.15], face: Math.PI },
  },
  {
    role: "Architect",
    name: "Ada",
    accent: "#6d8ea8",
    tool: "blueprint",
    idle: { at: [-0.45, 0, 1.4], face: 0.2 },
    work: { at: [1.95, 0, -1.05], face: Math.atan2(0.75, -0.55) },
  },
  {
    role: "Backend",
    name: "Forge",
    accent: "#b87333",
    tool: "wrench",
    idle: { at: [0.35, 0, 1.15], face: -0.1 },
    work: { at: [-2.2, 0, 0.15], face: Math.atan2(-0.95, -0.05) },
  },
  {
    role: "Frontend",
    name: "Pixel",
    accent: "#6a9a72",
    tool: "stylus",
    idle: { at: [1.15, 0, 1.35], face: -0.35 },
    work: { at: [1.1, 0, -1.7], face: Math.atan2(0.7, -0.6) },
  },
  {
    role: "QA",
    name: "Sentinel",
    accent: "#3d4c5c",
    tool: "glass",
    idle: { at: [1.7, 0, 0.75], face: -0.7 },
    work: { at: [1.7, 0, 0.7], face: Math.atan2(0.85, 0.45) },
  },
];

const ROUTES: Record<string, Spot[]> = {
  Coordinator: [
    { at: [-1.2, 0, -2.25], face: Math.PI },
    { at: [-0.95, 0, 0.42], face: Math.PI },
    { at: [-2.55, 0, 1.25], face: -Math.PI / 2 },
  ],
  Architect: [
    { at: [1.9, 0, -0.95], face: Math.atan2(-0.65, 0.8) },
    { at: [-0.15, 0, -2.15], face: Math.PI },
    { at: [0.95, 0, 0.42], face: Math.PI },
  ],
  Backend: [
    { at: [-2.45, 0, 0.12], face: -Math.PI / 2 },
    { at: [-0.35, 0, 0.5], face: Math.PI },
    { at: [-2.45, 0, -1.65], face: -Math.PI / 2 },
  ],
  Frontend: [
    { at: [1.15, 0, -1.55], face: Math.atan2(-0.75, 0.65) },
    { at: [0.55, 0, 0.55], face: Math.PI },
    { at: [1.85, 0, 0.2], face: Math.atan2(0.95, 0.7) },
  ],
  QA: [
    { at: [1.95, 0, 0.72], face: Math.atan2(0.43, 0.6) },
    { at: [0.2, 0, 1.05], face: Math.PI },
    { at: [0.45, 0, -1.85], face: Math.PI },
  ],
};

const SPOKEN: Record<string, string> = {
  "agent.status.changed": "Changing what I am doing.",
  "task.claimed": "I claimed a task.",
  "task.completed": "The task is done.",
  "task.blocked": "This task is blocked.",
  "run.started": "The run started.",
  "run.plan.approved": "The plan is approved.",
  "run.stopped": "The run stopped.",
  "decision.created": "I recorded a decision.",
  "workspace.file.updated": "I updated a file.",
  "document.updated": "The plan changed.",
  "demo.progress": "",
};

function textOf(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
function humanize(type: string) {
  const words = type.replaceAll(".", " ").replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}
export function lineFor(event: LiveEvent) {
  const text =
    textOf(event.payload?.text) ||
    textOf(event.payload?.command) ||
    textOf(event.payload?.error);
  if (text) return text;
  if (event.type in SPOKEN) return SPOKEN[event.type];
  return humanize(event.type);
}
function latestLine(events: LiveEvent[], actorId: string) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.actorId !== actorId || event.type === "agent.activity") continue;
    const text = lineFor(event);
    if (!text) continue;
    return { text, at: new Date(event.timestamp).getTime() };
  }
  return null;
}
function freshLine(line: { text: string; at: number } | null) {
  if (!line || Date.now() - line.at > SPEECH_MS) return null;
  return line;
}
function latestUtterance(events: LiveEvent[], actorId: string) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const spokenByAgent =
      event.type === "agent.activity" && event.resourceId === actorId;
    if (event.actorId !== actorId && !spokenByAgent) continue;
    const text =
      textOf(event.payload?.text) ||
      textOf(event.payload?.command) ||
      textOf(event.payload?.error);
    if (!text) continue;
    const at = new Date(event.timestamp).getTime();
    if (Date.now() - at > TALK_MS) return null;
    return { text, at };
  }
  return null;
}
function mentions(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}
function questionTarget(
  text: string,
  selfId: string,
  others: { id: string; name: string }[],
  places: Map<string, THREE.Vector3>,
) {
  if (!text.includes("?")) return null;
  const named = others.find((person) => person.id !== selfId && mentions(text, person.name));
  if (named) return named.id;
  const self = places.get(selfId);
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const person of others) {
    if (person.id === selfId) continue;
    const at = places.get(person.id);
    if (!self || !at) {
      if (!best) best = person.id;
      continue;
    }
    const distance = at.distanceToSquared(self);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = person.id;
    }
  }
  return best;
}

function grain(base: string, stroke: string, bands: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < bands; i += 1) {
    g.strokeStyle = stroke;
    g.globalAlpha = 0.08 + Math.random() * 0.14;
    g.lineWidth = 1 + Math.random() * 2.4;
    const y = (i / bands) * 512;
    g.beginPath();
    g.moveTo(0, y);
    g.bezierCurveTo(160, y + 18, 340, y - 16, 512, y + 6);
    g.stroke();
  }
  g.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function paintScreen(canvas: HTMLCanvasElement, lines: string[], shown: number, blink: boolean) {
  const g = canvas.getContext("2d");
  if (!g) return;
  g.fillStyle = shown > 0 ? "#102033" : "#14181c";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.font = "15px ui-monospace, SFMono-Regular, monospace";
  const count = Math.max(shown > 0 ? 1 : 0, Math.min(lines.length, shown));
  if (count === 0) {
    g.fillStyle = "#8ea0b0";
    g.fillText("waiting", 18, 46);
    return;
  }
  for (let i = 0; i < count; i += 1) {
    g.fillStyle = i === count - 1 ? "#9ddeb8" : "#d7e6f4";
    const caret = i === count - 1 && blink ? " _" : "";
    g.fillText((lines[i] || "") + caret, 18, 34 + i * 22);
  }
}

function WorkScreen({
  lines,
  active,
}: {
  lines: string[];
  active: boolean;
}) {
  const canvas = useMemo(() => {
    const el = document.createElement("canvas");
    el.width = 256;
    el.height = 160;
    paintScreen(el, lines, 0, false);
    return el;
  }, [lines]);
  const map = useMemo(() => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, [canvas]);
  const shown = useRef(0);
  const tick = useRef(0);
  useFrame(() => {
    tick.current += 1;
    if (tick.current % 12 !== 0) return;
    const next =
      active && tick.current % 48 === 0
        ? Math.min(lines.length, shown.current + 1)
        : shown.current;
    const blink = active && shown.current > 0 && tick.current % 24 < 12;
    if (next === shown.current && !(active && shown.current > 0)) return;
    shown.current = next;
    paintScreen(canvas, lines, shown.current, blink);
    map.needsUpdate = true;
  });
  return (
    <meshStandardMaterial
      map={map}
      emissive={active ? "#8eb7db" : "#6d7c8a"}
      emissiveMap={map}
      emissiveIntensity={active ? 0.85 : 0.22}
      roughness={0.4}
    />
  );
}

function FitModel({
  url,
  position,
  rotation,
  scale = 1,
}: {
  url: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
}) {
  const { scene } = useGLTF(url);
  const clone = useMemo(() => scene.clone(true), [scene]);
  useEffect(() => {
    clone.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
  }, [clone]);
  return (
    <primitive
      object={clone}
      position={position}
      rotation={rotation}
      scale={scale}
    />
  );
}

const SCREEN_LINES = {
  plan: ["plan", "atlas   tasks", "ada     layout", "forge   api", "pixel   screen", "qa      pass"],
  code: ["export function room()", "  return crew", "    .map(work)", "}", "", "saved"],
  server: ["listen  :4310", "POST /commands", "200  prompt", "build   ok", "queue   1"],
  design: ["header", "nav | stage", "live room", "type   16", "space  24"],
};

function Monitor({
  position,
  rotation,
  active,
  lines,
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  active: boolean;
  lines: string[];
}) {
  return (
    <group position={position} rotation={rotation}>
      <mesh position={[0, 0.2, 0]} castShadow>
        <boxGeometry args={[0.72, 0.46, 0.04]} />
        <meshStandardMaterial color="#1c2126" metalness={0.72} roughness={0.28} />
      </mesh>
      <mesh position={[0, 0.2, 0.023]}>
        <planeGeometry args={[0.62, 0.36]} />
        <WorkScreen lines={lines} active={active} />
      </mesh>
      <mesh position={[0, -0.05, 0]} castShadow>
        <boxGeometry args={[0.05, 0.14, 0.04]} />
        <meshStandardMaterial color="#2a3036" metalness={0.6} roughness={0.35} />
      </mesh>
      <mesh position={[0, -0.12, 0.02]} receiveShadow>
        <boxGeometry args={[0.28, 0.016, 0.18]} />
        <meshStandardMaterial color="#2a3036" metalness={0.55} roughness={0.35} />
      </mesh>
    </group>
  );
}

function ToolMesh({ tool }: { tool: Tool }) {
  const metal = { color: "#8d9398", metalness: 0.85, roughness: 0.28 };
  if (tool === "clipboard") {
    return (
      <group position={[0.22, 0.46, 0.12]} rotation={[0.4, 0.2, -0.4]}>
        <mesh castShadow>
          <boxGeometry args={[0.16, 0.22, 0.012]} />
          <meshStandardMaterial color="#d7c4a4" roughness={0.7} />
        </mesh>
        <mesh position={[0, 0.02, 0.008]}>
          <boxGeometry args={[0.12, 0.14, 0.004]} />
          <meshStandardMaterial color="#f4f1ea" roughness={0.9} />
        </mesh>
      </group>
    );
  }
  if (tool === "blueprint") {
    return (
      <mesh position={[0.24, 0.42, 0.1]} rotation={[0.9, 0.2, -0.5]} castShadow>
        <boxGeometry args={[0.2, 0.14, 0.004]} />
        <meshStandardMaterial color="#6d8ea8" roughness={0.55} />
      </mesh>
    );
  }
  if (tool === "wrench") {
    return (
      <group position={[0.24, 0.42, 0.1]} rotation={[0.2, 0, 0.8]}>
        <mesh castShadow>
          <cylinderGeometry args={[0.012, 0.012, 0.22, 8]} />
          <meshStandardMaterial {...metal} />
        </mesh>
        <mesh position={[0, 0.1, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <torusGeometry args={[0.03, 0.01, 6, 10, Math.PI]} />
          <meshStandardMaterial {...metal} />
        </mesh>
      </group>
    );
  }
  if (tool === "stylus") {
    return (
      <mesh position={[0.24, 0.44, 0.12]} rotation={[0.6, 0, -0.7]} castShadow>
        <cylinderGeometry args={[0.01, 0.012, 0.2, 8]} />
        <meshStandardMaterial color="#6a9a72" metalness={0.2} roughness={0.4} />
      </mesh>
    );
  }
  return (
    <group position={[0.24, 0.46, 0.12]} rotation={[0.3, 0, -0.6]}>
      <mesh castShadow>
        <torusGeometry args={[0.045, 0.008, 8, 16]} />
        <meshStandardMaterial {...metal} />
      </mesh>
      <mesh position={[0, -0.07, 0]} castShadow>
        <cylinderGeometry args={[0.008, 0.008, 0.08, 8]} />
        <meshStandardMaterial {...metal} />
      </mesh>
    </group>
  );
}

function Figure({
  accent,
  tool,
  seated,
  busy = false,
  shirt = "#e7d7c3",
}: {
  accent: string;
  tool?: Tool;
  seated?: boolean;
  busy?: boolean;
  shirt?: string;
}) {
  const skin = "#f0e2d2";
  const arm = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!arm.current) return;
    const swing = busy ? Math.sin(performance.now() / 170) : 0;
    arm.current.rotation.z = swing * 0.45;
    arm.current.rotation.x = swing * 0.18;
  });
  return (
    <group position={[0, seated ? 0.46 : 0, 0]} scale={seated ? 1.12 : 1}>
      <mesh position={[0, 0.38, 0]} castShadow>
        <capsuleGeometry args={[0.15, 0.2, 6, 14]} />
        <meshStandardMaterial color={shirt} roughness={0.62} />
      </mesh>
      <mesh position={[0, 0.36, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.155, 0.016, 8, 18]} />
        <meshStandardMaterial color={accent} roughness={0.42} />
      </mesh>
      <mesh position={[0, 0.68, 0]} castShadow>
        <sphereGeometry args={[0.125, 22, 16]} />
        <meshStandardMaterial color={skin} roughness={0.52} />
      </mesh>
      <mesh position={[-0.046, 0.7, 0.1]}>
        <sphereGeometry args={[0.016, 10, 10]} />
        <meshStandardMaterial color="#243038" roughness={0.25} />
      </mesh>
      <mesh position={[0.046, 0.7, 0.1]}>
        <sphereGeometry args={[0.016, 10, 10]} />
        <meshStandardMaterial color="#243038" roughness={0.25} />
      </mesh>
      <mesh position={[-0.2, 0.4, 0]} rotation={[0, 0, 0.55]} castShadow>
        <capsuleGeometry args={[0.038, 0.14, 4, 8]} />
        <meshStandardMaterial color={skin} roughness={0.55} />
      </mesh>
      <mesh position={[0.2, 0.42, 0.05]} rotation={[0.35, 0, -0.65]} castShadow>
        <capsuleGeometry args={[0.038, 0.14, 4, 8]} />
        <meshStandardMaterial color={skin} roughness={0.55} />
      </mesh>
      {!seated && (
        <>
          <mesh position={[-0.07, 0.12, 0]} castShadow>
            <capsuleGeometry args={[0.05, 0.1, 4, 8]} />
            <meshStandardMaterial color={accent} roughness={0.7} />
          </mesh>
          <mesh position={[0.07, 0.12, 0]} castShadow>
            <capsuleGeometry args={[0.05, 0.1, 4, 8]} />
            <meshStandardMaterial color={accent} roughness={0.7} />
          </mesh>
        </>
      )}
      <group ref={arm}>{tool && <ToolMesh tool={tool} />}</group>
    </group>
  );
}

function Speech({
  name,
  text,
  at,
  position,
}: {
  name: string;
  text: string;
  at: number;
  position: [number, number, number];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hiding = useRef(false);
  const [gone, setGone] = useState(() => Date.now() - at > SPEECH_MS);
  useFrame(() => {
    const age = Date.now() - at;
    const opacity = Math.max(0, 1 - age / SPEECH_MS);
    if (ref.current) ref.current.style.opacity = String(opacity);
    if (opacity === 0 && !hiding.current) {
      hiding.current = true;
      queueMicrotask(() => setGone(true));
    }
  });
  if (gone) return null;
  const clipped = text.length > 180 ? `${text.slice(0, 177)}…` : text;
  return (
    <Html
      position={position}
      center
      distanceFactor={6.5}
      zIndexRange={[30, 0]}
      style={{ pointerEvents: "none" }}
    >
      <div className="live-bubble" ref={ref}>
        <strong>{name}</strong>
        {clipped}
      </div>
    </Html>
  );
}

function stepToward(
  body: THREE.Group,
  dest: THREE.Vector3,
  step: THREE.Vector3,
  dt: number,
  face: number | null,
) {
  const capped = Math.min(dt, 0.05);
  step.copy(dest).sub(body.position);
  step.y = 0;
  const dist = step.length();
  if (dist > 0.035) {
    step.multiplyScalar(Math.min(1, (1.35 * capped) / dist));
    body.position.add(step);
    body.rotation.y = Math.atan2(step.x, step.z);
  } else if (face != null) {
    body.position.x = dest.x;
    body.position.z = dest.z;
    body.rotation.y = THREE.MathUtils.damp(body.rotation.y, face, 5, capped);
  }
  const walking = dist > 0.06;
  body.position.y = Math.sin(performance.now() / (walking ? 85 : 480)) * (walking ? 0.035 : 0.008);
  return dist;
}

function Walker({
  id,
  spot,
  route,
  askId,
  watchId,
  places,
  line,
  speakName,
  children,
}: {
  id: string;
  spot: Spot;
  route: Spot[] | null;
  askId: string | null;
  watchId: string | null;
  places: Map<string, THREE.Vector3>;
  line: { text: string; at: number } | null;
  speakName: string;
  children: ReactNode;
}) {
  const group = useRef<THREE.Group>(null);
  const placed = useRef(false);
  const here = useMemo(() => new THREE.Vector3(spot.at[0], 0, spot.at[2]), [spot.at]);
  const dest = useMemo(() => new THREE.Vector3(), []);
  const step = useMemo(() => new THREE.Vector3(), []);
  const arming = useRef(false);
  const stop = useRef(0);
  const dwell = useRef(0);
  const [speakAt, setSpeakAt] = useState<number | null>(null);
  const lineKey = line ? `${line.at}:${line.text}` : "";
  useEffect(() => {
    places.set(id, here);
    return () => {
      places.delete(id);
    };
  }, [id, places, here]);
  useEffect(() => {
    arming.current = false;
    setSpeakAt(null);
  }, [lineKey]);
  useFrame((_, dt) => {
    const body = group.current;
    if (!body) return;
    if (!placed.current) {
      body.position.set(spot.at[0], 0, spot.at[2]);
      body.rotation.y = spot.face;
      placed.current = true;
    }
    const other = askId ? places.get(askId) : undefined;
    const station = !other && route?.length ? route[stop.current % route.length] : null;
    if (other) {
      dest.copy(body.position).sub(other);
      dest.y = 0;
      if (dest.lengthSq() < 0.01) dest.set(0.75, 0, 0);
      else dest.setLength(0.75);
      dest.add(other);
      keepInRoom(dest);
    } else if (watchId) dest.set(body.position.x, 0, body.position.z);
    else if (station) dest.set(station.at[0], 0, station.at[2]);
    else dest.set(spot.at[0], 0, spot.at[2]);
    const watched = other ? undefined : watchId ? places.get(watchId) : undefined;
    const look = other ?? watched;
    const face = look
      ? Math.atan2(look.x - body.position.x, look.z - body.position.z)
      : station
        ? station.face
        : spot.face;
    const dist = stepToward(body, dest, step, dt, face);
    if (station && !watchId && dist < 0.08) {
      dwell.current += dt;
      if (dwell.current > 4.2 && route && route.length > 1) {
        dwell.current = 0;
        stop.current = (stop.current + 1) % route.length;
      }
    } else dwell.current = 0;
    here.set(body.position.x, 0, body.position.z);
    if (line && (!askId || dist < 0.32) && speakAt == null && !arming.current) {
      arming.current = true;
      const now = Date.now();
      queueMicrotask(() => setSpeakAt(now));
    }
  });
  return (
    <group ref={group}>
      {children}
      {line && speakAt != null && (
        <Speech key={lineKey} name={speakName} text={line.text} at={speakAt} position={[0, 1.08, 0]} />
      )}
    </group>
  );
}

function typingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function Player({
  id,
  name,
  places,
  crew,
  line,
  onNearby,
}: {
  id: string;
  name: string;
  places: Map<string, THREE.Vector3>;
  crew: { id: string }[];
  line: { text: string; at: number } | null;
  onNearby: (id: string | null) => void;
}) {
  const onNearbyRef = useRef(onNearby);
  onNearbyRef.current = onNearby;
  const group = useRef<THREE.Group>(null);
  const { camera } = useThree();
  const keys = useRef({ f: false, b: false, l: false, r: false });
  const here = useMemo(() => new THREE.Vector3(0, 0, 2.15), []);
  const forward = useMemo(() => new THREE.Vector3(), []);
  const right = useMemo(() => new THREE.Vector3(), []);
  const move = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const reported = useRef<string | null>(null);
  useEffect(() => {
    places.set(id, here);
    return () => {
      places.delete(id);
    };
  }, [id, places, here]);
  useEffect(() => {
    const setKey = (key: string, down: boolean) => {
      if (key === "ArrowUp" || key === "w" || key === "W") keys.current.f = down;
      else if (key === "ArrowDown" || key === "s" || key === "S") keys.current.b = down;
      else if (key === "ArrowLeft" || key === "a" || key === "A") keys.current.l = down;
      else if (key === "ArrowRight" || key === "d" || key === "D") keys.current.r = down;
      else return false;
      return true;
    };
    const down = (event: KeyboardEvent) => {
      if (typingTarget(event.target)) return;
      if (setKey(event.key, true)) event.preventDefault();
    };
    const upHandler = (event: KeyboardEvent) => {
      setKey(event.key, false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", upHandler);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", upHandler);
    };
  }, []);
  useFrame((_, dt) => {
    const body = group.current;
    if (!body) return;
    const capped = Math.min(dt, 0.05);
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 0.0001) forward.set(0, 0, -1);
    forward.normalize();
    right.crossVectors(forward, up).normalize();
    move.set(0, 0, 0);
    const held = keys.current;
    if (held.f) move.add(forward);
    if (held.b) move.sub(forward);
    if (held.r) move.add(right);
    if (held.l) move.sub(right);
    const walking = move.lengthSq() > 0;
    if (walking) {
      move.normalize().multiplyScalar(2.4 * capped);
      body.position.add(move);
      keepInRoom(body.position);
      body.rotation.y = Math.atan2(move.x, move.z);
    }
    body.position.y = Math.sin(performance.now() / (walking ? 85 : 480)) * (walking ? 0.035 : 0.008);
    here.set(body.position.x, 0, body.position.z);
    let nearest: string | null = null;
    let nearestDistance = TALK_REACH * TALK_REACH;
    for (const person of crew) {
      const at = places.get(person.id);
      if (!at) continue;
      const distance = at.distanceToSquared(here);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = person.id;
      }
    }
    if (nearest !== reported.current) {
      reported.current = nearest;
      const next = nearest;
      queueMicrotask(() => onNearbyRef.current(next));
    }
  });
  return (
    <group ref={group} position={[0, 0, 2.15]}>
      <Figure accent="#1f4a44" shirt="#d5ddd8" />
      {line && <Speech key={line.at} name={name} text={line.text} at={line.at} position={[0, 1.15, 0]} />}
    </group>
  );
}

function RoomShell() {
  const wood = useMemo(() => {
    const texture = grain("#b08a62", "rgba(90,58,30,0.4)", 28);
    if (texture) texture.repeat.set(4, 3);
    return texture;
  }, []);
  const plaster = useMemo(() => {
    const texture = grain("#e7e2d9", "rgba(180,170,155,0.45)", 18);
    if (texture) texture.repeat.set(2, 1);
    return texture;
  }, []);
  const walls: { position: [number, number, number]; args: [number, number, number] }[] = [
    { position: [0, 1.48, -3.38], args: [8.56, 2.96, 0.16] },
    { position: [4.28, 1.48, 0], args: [0.16, 2.96, 6.76] },
    { position: [-4.28, 1.48, -2.19], args: [0.16, 2.96, 2.38] },
    { position: [-4.28, 1.48, 2.34], args: [0.16, 2.96, 2.08] },
    { position: [-4.28, 0.4, 0.15], args: [0.16, 0.8, 2.3] },
    { position: [-4.28, 2.62, 0.15], args: [0.16, 0.66, 2.3] },
  ];
  const frame: { position: [number, number, number]; args: [number, number, number] }[] = [
    { position: [-4.18, 2.28, 0.15], args: [0.05, 0.06, 2.36] },
    { position: [-4.18, 0.82, 0.15], args: [0.05, 0.06, 2.36] },
    { position: [-4.18, 1.55, -1.03], args: [0.05, 1.52, 0.06] },
    { position: [-4.18, 1.55, 1.33], args: [0.05, 1.52, 0.06] },
  ];
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[8.4, 6.6]} />
        <meshStandardMaterial map={wood ?? undefined} color="#c4a27a" roughness={0.78} metalness={0.02} />
      </mesh>
      {walls.map((panel) => (
        <mesh key={panel.position.join(",")} position={panel.position} receiveShadow>
          <boxGeometry args={panel.args} />
          <meshStandardMaterial map={plaster ?? undefined} color="#e6e1d8" roughness={0.92} />
        </mesh>
      ))}
      <mesh position={[-4.2, 1.55, 0.15]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[2.24, 1.42]} />
        <meshPhysicalMaterial
          color="#e7f3f6"
          transmission={1}
          thickness={0.04}
          roughness={0.04}
          metalness={0}
          ior={1.5}
        />
      </mesh>
      {frame.map((bar) => (
        <mesh key={bar.position.join(",")} position={bar.position} castShadow>
          <boxGeometry args={bar.args} />
          <meshStandardMaterial color="#8d9396" metalness={0.78} roughness={0.28} />
        </mesh>
      ))}
      <group position={[-1.25, 1.52, -3.26]}>
        <mesh castShadow>
          <boxGeometry args={[1.9, 1.16, 0.045]} />
          <meshStandardMaterial color="#b7c0c4" metalness={0.7} roughness={0.32} />
        </mesh>
        <mesh position={[0, 0, 0.026]}>
          <planeGeometry args={[1.72, 0.98]} />
          <meshStandardMaterial color="#f7f8f6" roughness={0.9} />
        </mesh>
      </group>
    </group>
  );
}

function paintBoard(canvas: HTMLCanvasElement, shown: number) {
  const g = canvas.getContext("2d");
  if (!g) return;
  g.fillStyle = "#f7f8f6";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = "#2f6f62";
  g.lineWidth = 4;
  g.font = "22px sans-serif";
  g.fillStyle = "#243038";
  const marks = [
    () => {
      g.strokeRect(28, 28, 150, 78);
      g.fillText("plan", 72, 74);
    },
    () => {
      g.beginPath();
      g.moveTo(178, 67);
      g.lineTo(220, 67);
      g.stroke();
    },
    () => {
      g.strokeRect(220, 28, 150, 78);
      g.fillText("build", 252, 74);
    },
    () => {
      g.beginPath();
      g.moveTo(103, 106);
      g.lineTo(103, 150);
      g.stroke();
    },
    () => {
      g.strokeRect(28, 150, 170, 86);
      g.fillText("review", 64, 200);
    },
    () => {
      g.beginPath();
      g.moveTo(198, 193);
      g.lineTo(250, 150);
      g.stroke();
    },
  ];
  for (let i = 0; i < Math.min(shown, marks.length); i += 1) marks[i]();
}

function paintChecks(canvas: HTMLCanvasElement, shown: number) {
  const g = canvas.getContext("2d");
  if (!g) return;
  g.fillStyle = "#f4f1ea";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.font = "22px sans-serif";
  ["layout", "api", "copy", "states"].forEach((row, index) => {
    g.fillStyle = index < shown ? "#2f6f62" : "#8d9396";
    g.fillText(`${index < shown ? "✓" : "·"}  ${row}`, 18, 36 + index * 28);
  });
}

function paintBlueprint(canvas: HTMLCanvasElement, shown: number) {
  const g = canvas.getContext("2d");
  if (!g) return;
  g.fillStyle = "#d5e3ee";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = "#2a4a62";
  g.lineWidth = 3;
  const boxes = [
    [24, 24, 90, 60],
    [130, 24, 90, 60],
    [24, 100, 196, 40],
  ] as const;
  boxes.slice(0, shown).forEach(([x, y, w, h]) => g.strokeRect(x, y, w, h));
}

function GrowingSheet({
  position,
  rotation,
  active,
  paint,
  args,
  limit,
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  active: boolean;
  paint: (canvas: HTMLCanvasElement, shown: number) => void;
  args: [number, number];
  limit: number;
}) {
  const canvas = useMemo(() => {
    const el = document.createElement("canvas");
    el.width = 256;
    el.height = 160;
    paint(el, 0);
    return el;
  }, [paint]);
  const map = useMemo(() => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, [canvas]);
  const shown = useRef(0);
  const tick = useRef(0);
  useFrame(() => {
    if (!active || shown.current >= limit) return;
    tick.current += 1;
    if (tick.current % 50 !== 0) return;
    shown.current += 1;
    paint(canvas, shown.current);
    map.needsUpdate = true;
  });
  return (
    <mesh position={position} rotation={rotation ?? [-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={args} />
      <meshStandardMaterial map={map} roughness={0.85} />
    </mesh>
  );
}

function PaperStack({ active }: { active: boolean }) {
  const [sheets, setSheets] = useState(2);
  const raised = useRef(false);
  useFrame(() => {
    if (!active || raised.current) return;
    raised.current = true;
    queueMicrotask(() => setSheets(4));
  });
  return (
    <group position={[-0.62, 0.805, -0.12]}>
      {Array.from({ length: sheets }, (_, index) => (
        <mesh
          key={index}
          position={[index * 0.012, index * 0.004, index * 0.01]}
          rotation={[0, index * 0.05, 0]}
          castShadow
        >
          <boxGeometry args={[0.26, 0.004, 0.34]} />
          <meshStandardMaterial color={index === sheets - 1 ? "#f7f4ee" : "#efe4d2"} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

function Furniture({
  coding,
  designing,
  building,
  planning,
  reviewing,
}: {
  coding: boolean;
  designing: boolean;
  building: boolean;
  planning: boolean;
  reviewing: boolean;
}) {
  const busy = coding || designing || building || planning || reviewing;
  return (
    <group>
      <FitModel url="/live/desk/metal_office_desk.gltf" position={[0, 0, -0.35]} />
      <FitModel
        url="/live/chair/painted_wooden_chair_01.gltf"
        position={[0.15, 0, 0.7]}
        rotation={[0, Math.PI, 0]}
      />
      <FitModel url="/live/lamp/desk_lamp_arm_01.gltf" position={[0.72, 0.78, -0.2]} />
      <FitModel url="/live/plant/potted_plant_02.gltf" position={[-3.2, 0, -2.45]} />
      <FitModel url="/live/table/side_table_01.gltf" position={[2.7, 0, -1.6]} scale={1.65} />
      <FitModel url="/live/table/side_table_01.gltf" position={[2.55, 0, 1.15]} scale={1.35} />
      <Monitor position={[-0.32, 0.8, -0.72]} active={planning || coding} lines={SCREEN_LINES.plan} />
      <Monitor position={[0.38, 0.8, -0.72]} active={coding || building || designing} lines={SCREEN_LINES.code} />
      <Monitor position={[-3.15, 0.72, 0.1]} rotation={[0, Math.PI / 2, 0]} active={building} lines={SCREEN_LINES.server} />
      <Monitor position={[1.8, 0.72, -2.3]} active={designing} lines={SCREEN_LINES.design} />
      <mesh position={[0.05, 0.8, -0.05]} castShadow receiveShadow>
        <boxGeometry args={[0.46, 0.015, 0.16]} />
        <meshStandardMaterial color="#2c3136" roughness={0.55} metalness={0.35} />
      </mesh>
      <mesh position={[0.32, 0.812, 0.02]} castShadow>
        <boxGeometry args={[0.07, 0.012, 0.11]} />
        <meshStandardMaterial color="#d7dde0" roughness={0.45} />
      </mesh>
      <group position={[0.58, 0.84, -0.02]}>
        <mesh castShadow>
          <cylinderGeometry args={[0.038, 0.032, 0.07, 12]} />
          <meshStandardMaterial color="#f4f1ea" roughness={0.35} />
        </mesh>
        <mesh position={[0.04, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.018, 0.005, 6, 10]} />
          <meshStandardMaterial color="#f4f1ea" roughness={0.35} />
        </mesh>
      </group>
      <PaperStack active={busy} />
      <GrowingSheet
        position={[-1.25, 1.52, -3.228]}
        rotation={[0, 0, 0]}
        active={planning}
        paint={paintBoard}
        args={[1.72, 0.98]}
        limit={6}
      />
      <GrowingSheet
        position={[2.55, 0.7, -1.45]}
        active={planning}
        paint={paintBlueprint}
        args={[0.42, 0.28]}
        limit={3}
      />
      <GrowingSheet
        position={[2.42, 0.58, 1.2]}
        active={reviewing}
        paint={paintChecks}
        args={[0.28, 0.2]}
        limit={4}
      />
      {busy && (
        <>
          <pointLight position={[0.9, 1.2, -0.15]} intensity={0.7} distance={3.4} color="#ffe1b0" />
          <mesh position={[0.95, 1.12, -0.08]}>
            <sphereGeometry args={[0.035, 10, 10]} />
            <meshStandardMaterial color="#ffe7c2" emissive="#ffd29a" emissiveIntensity={1.4} />
          </mesh>
        </>
      )}
    </group>
  );
}

function Coder({
  label,
  line,
}: {
  label: string;
  line: { text: string; at: number } | null;
}) {
  return (
    <group position={[0.15, 0, 0.7]} rotation={[0, Math.PI, 0]}>
      <Figure accent="#1f4a44" shirt="#d5ddd8" seated />
      {line && (
        <Speech key={line.at} name={label} text={line.text} at={line.at} position={[0, 1.15, 0]} />
      )}
    </group>
  );
}

function Studio({
  agents,
  events,
  connections,
  members,
  actorName,
  you,
  focusId,
  said,
  onNearby,
}: {
  agents: LiveAgent[];
  events: LiveEvent[];
  connections: LiveConnection[];
  members: LiveMember[];
  actorName: (id: string) => string;
  you: { id: string; displayName: string };
  focusId: string | null;
  said: { text: string; at: number } | null;
  onNearby: (id: string | null) => void;
}) {
  const places = useMemo(() => new Map<string, THREE.Vector3>(), []);
  const coder = connections.find((connection) => connection.live && connection.userId !== you.id);
  const coderId = coder ? `mcp:${coder.id}` : "";
  const cast = ROLES.map((role) => {
    const agent = agents.find((item) => item.role === role.role);
    return {
      ...role,
      id: agent?.id || role.role,
      name: agent?.name || role.name,
      working: agent?.status === "working",
    };
  });
  const voices = [
    ...cast.map((person) => ({ id: person.id, name: person.name })),
    { id: you.id, name: you.displayName },
    ...(coder ? [{ id: coderId, name: coder.displayName }] : []),
  ];
  const systemLine = latestLine(events, "system");
  const planning = cast.some(
    (person) => (person.role === "Coordinator" || person.role === "Architect") && person.working,
  );
  const building = cast.some((person) => person.role === "Backend" && person.working);
  const designing = cast.some((person) => person.role === "Frontend" && person.working);
  const reviewing = cast.some((person) => person.role === "QA" && person.working);
  return (
    <>
      <color attach="background" args={["#d5dbd6"]} />
      <hemisphereLight args={["#f7f3ea", "#b09a84", 0.55]} />
      <directionalLight
        position={[-6.5, 5.2, 2.2]}
        intensity={1.15}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={0.4}
        shadow-camera-far={16}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={6}
        shadow-camera-bottom={-6}
        shadow-bias={-0.00035}
      />
      <RoomShell />
      <ContactShadows position={[0, 0.001, 0]} opacity={0.28} scale={14} blur={2.6} far={3.2} />
      <Suspense fallback={null}>
        <Furniture
          coding={Boolean(coder)}
          designing={designing}
          building={building}
          planning={planning}
          reviewing={reviewing}
        />
        <Environment files="/live/studio.hdr" environmentIntensity={0.9} />
      </Suspense>
      {cast.map((person) => {
        const line = latestUtterance(events, person.id);
        const askId = line ? questionTarget(line.text, person.id, voices, places) : null;
        const spokenName =
          actorName(person.id) === "Participant" ? person.name : actorName(person.id);
        return (
          <Walker
            key={person.role}
            id={person.id}
            spot={person.idle}
            route={person.working ? ROUTES[person.role] : null}
            askId={askId}
            watchId={focusId === person.id ? you.id : null}
            places={places}
            line={line}
            speakName={spokenName}
          >
            <Figure accent={person.accent} tool={person.tool} busy={person.working && !askId} />
          </Walker>
        );
      })}
      <Player
        id={you.id}
        name={you.displayName}
        places={places}
        crew={cast.map((person) => ({ id: person.id }))}
        line={freshLine(said) ?? freshLine(latestUtterance(events, you.id))}
        onNearby={onNearby}
      />
      {coder && (
        <Coder
          label={coder.label || coder.displayName}
          line={coderId ? latestLine(events, coderId) : null}
        />
      )}
      {members
        .filter((member) => member.id !== you.id)
        .slice(0, 6)
        .map((member, index) => {
        const line = latestLine(events, member.id);
        return (
          <group key={member.id} position={[3.45, 0, -0.8 + index * 0.48]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
              <circleGeometry args={[0.09, 20]} />
              <meshStandardMaterial color="#2f6f62" roughness={0.6} />
            </mesh>
            {line && (
              <Speech
                key={line.at}
                name={member.displayName}
                text={line.text}
                at={line.at}
                position={[0, 0.45, 0]}
              />
            )}
          </group>
        );
      })}
      {systemLine && (
        <Speech
          key={systemLine.at}
          name="Colag"
          text={systemLine.text}
          at={systemLine.at}
          position={[-1.25, 1.62, -3.05]}
        />
      )}
      <OrbitControls
        makeDefault
        target={[0, 0.8, -0.2]}
        maxPolarAngle={Math.PI / 2.15}
        minDistance={1.4}
        maxDistance={18}
        enablePan
      />
    </>
  );
}

export default function LiveView({
  agents,
  events,
  connections,
  members,
  actorName,
  you,
  onTalk,
}: {
  agents: LiveAgent[];
  events: LiveEvent[];
  connections: LiveConnection[];
  members: LiveMember[];
  actorName: (id: string) => string;
  you: { id: string; displayName: string };
  onTalk: (agentId: string, text: string) => Promise<void>;
}) {
  const [hidden, setHidden] = useState(false);
  const [nearbyId, setNearbyId] = useState<string | null>(null);
  const [talkTo, setTalkTo] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [said, setSaid] = useState<{ text: string; at: number } | null>(null);
  const nearbyRef = useRef<string | null>(null);
  const talkingRef = useRef(false);
  talkingRef.current = talkTo != null;
  const nearby = agents.find((agent) => agent.id === nearbyId);
  const talking = agents.find((agent) => agent.id === talkTo);
  useEffect(() => {
    const onHide = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key !== " " || event.repeat) return;
      if (typingTarget(event.target) || talkingRef.current) return;
      if (!nearbyRef.current) return;
      event.preventDefault();
      setTalkTo(nearbyRef.current);
      setDraft("");
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);
  return (
    <div className="live-stage">
      {!talking && (
        <p className="live-hint">
          {nearby
            ? `Space to talk to ${nearby.name}.`
            : "Arrow keys walk you through the room."}
        </p>
      )}
      {talking && (
        <form
          className="live-talk"
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            const agentId = talking.id;
            if (!text) return;
            setDraft("");
            setTalkTo(null);
            setSaid({ text, at: Date.now() });
            void onTalk(agentId, text);
          }}
        >
          <label htmlFor="live-say">Talk to {talking.name}</label>
          <input
            id="live-say"
            autoFocus
            value={draft}
            placeholder={`Say something to ${talking.name}`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setTalkTo(null);
              }
            }}
          />
          <button className="primary small" type="submit" disabled={!draft.trim()}>
            Say it
          </button>
        </form>
      )}
      <Canvas
        shadows
        dpr={[1, 1.6]}
        frameloop={hidden ? "never" : "always"}
        camera={{ position: [0.4, 3.1, 6.4], fov: 46, near: 0.08, far: 60 }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 0.98;
        }}
      >
        <Studio
          agents={agents}
          events={events}
          connections={connections}
          members={members}
          actorName={actorName}
          you={you}
          focusId={talkTo || nearbyId}
          said={said}
          onNearby={(id) => {
            nearbyRef.current = id;
            setNearbyId(id);
          }}
        />
      </Canvas>
    </div>
  );
}

useGLTF.preload("/live/desk/metal_office_desk.gltf");
useGLTF.preload("/live/chair/painted_wooden_chair_01.gltf");
useGLTF.preload("/live/plant/potted_plant_02.gltf");
useGLTF.preload("/live/lamp/desk_lamp_arm_01.gltf");
useGLTF.preload("/live/table/side_table_01.gltf");
