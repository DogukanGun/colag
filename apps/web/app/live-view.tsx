"use client";
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
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
  timestamp: string;
  payload: Record<string, unknown>;
};
export type LiveConnection = {
  id: string;
  label: string;
  displayName: string;
  live: boolean;
};
export type LiveMember = { id: string; displayName: string };

type Tool = "clipboard" | "blueprint" | "wrench" | "stylus" | "glass";
type Spot = { at: [number, number, number]; face: number };

const SPEECH_MS = 16000;
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
    if (event.actorId !== actorId) continue;
    const text = lineFor(event);
    if (!text) continue;
    return { text, at: new Date(event.timestamp).getTime() };
  }
  return null;
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

function screenTexture(active: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 160;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.fillStyle = active ? "#102033" : "#14181c";
  g.fillRect(0, 0, 256, 160);
  g.font = "13px ui-monospace, monospace";
  const lines = active
    ? ["fn approve(plan) {", "  return review(plan)", "}", "", "tests  12 passed"]
    : ["—", "waiting", ""];
  lines.forEach((line, i) => {
    g.fillStyle = i === lines.length - 1 && active ? "#9ddeb8" : "#c5d4e4";
    g.fillText(line, 16, 32 + i * 22);
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
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

function Monitor({
  position,
  rotation,
  active,
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  active: boolean;
}) {
  const map = useMemo(() => screenTexture(active), [active]);
  return (
    <group position={position} rotation={rotation}>
      <mesh position={[0, 0.18, 0]} castShadow>
        <boxGeometry args={[0.64, 0.4, 0.035]} />
        <meshStandardMaterial color="#1c2126" metalness={0.72} roughness={0.28} />
      </mesh>
      <mesh position={[0, 0.18, 0.02]}>
        <planeGeometry args={[0.56, 0.32]} />
        <meshStandardMaterial
          map={map ?? undefined}
          emissive={active ? "#8eb7db" : "#6d7c8a"}
          emissiveMap={map ?? undefined}
          emissiveIntensity={active ? 0.9 : 0.25}
          roughness={0.42}
        />
      </mesh>
      <mesh position={[0, -0.04, 0.01]} castShadow>
        <cylinderGeometry args={[0.025, 0.03, 0.08, 10]} />
        <meshStandardMaterial color="#2a3036" metalness={0.6} roughness={0.35} />
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
  shirt = "#e7d7c3",
}: {
  accent: string;
  tool?: Tool;
  seated?: boolean;
  shirt?: string;
}) {
  const skin = "#f0e2d2";
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
      {tool && <ToolMesh tool={tool} />}
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
  const [gone, setGone] = useState(() => Date.now() - at > SPEECH_MS);
  useFrame(() => {
    const age = Date.now() - at;
    const opacity = Math.max(0, 1 - age / SPEECH_MS);
    if (ref.current) ref.current.style.opacity = String(opacity);
    if (opacity === 0 && !gone) setGone(true);
  });
  if (gone) return null;
  const clipped = text.length > 180 ? `${text.slice(0, 177)}…` : text;
  return (
    <Html position={position} center distanceFactor={6.5} zIndexRange={[30, 0]}>
      <div className="live-bubble" ref={ref}>
        <strong>{name}</strong>
        {clipped}
      </div>
    </Html>
  );
}

function Walker({
  spot,
  children,
}: {
  spot: Spot;
  children: ReactNode;
}) {
  const group = useRef<THREE.Group>(null);
  const placed = useRef(false);
  const dest = useMemo(() => new THREE.Vector3(), []);
  const step = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    const body = group.current;
    if (!body) return;
    if (!placed.current) {
      body.position.set(spot.at[0], 0, spot.at[2]);
      body.rotation.y = spot.face;
      placed.current = true;
    }
    const capped = Math.min(dt, 0.05);
    dest.set(spot.at[0], 0, spot.at[2]);
    step.copy(dest).sub(body.position);
    step.y = 0;
    const dist = step.length();
    if (dist > 0.035) {
      step.multiplyScalar(Math.min(1, (1.15 * capped) / dist));
      body.position.add(step);
      body.rotation.y = Math.atan2(step.x, step.z);
    } else {
      body.position.x = dest.x;
      body.position.z = dest.z;
      body.rotation.y = THREE.MathUtils.damp(body.rotation.y, spot.face, 5, capped);
    }
    const walking = dist > 0.06;
    body.position.y =
      Math.sin(performance.now() / (walking ? 85 : 480)) * (walking ? 0.03 : 0.008);
  });
  return <group ref={group}>{children}</group>;
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
    { position: [0, 1.48, 3.38], args: [8.56, 2.96, 0.16] },
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
      <mesh position={[0, 2.96, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[8.56, 6.76]} />
        <meshStandardMaterial color="#f4f1eb" roughness={0.95} />
      </mesh>
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

function Furniture({
  coding,
  designing,
  building,
}: {
  coding: boolean;
  designing: boolean;
  building: boolean;
}) {
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
      <Monitor position={[-0.32, 0.8, -0.72]} active={coding} />
      <Monitor position={[0.38, 0.8, -0.72]} active={coding} />
      <Monitor position={[-3.15, 0.72, 0.1]} rotation={[0, Math.PI / 2, 0]} active={building} />
      <Monitor position={[1.8, 0.72, -2.3]} active={designing} />
      <mesh position={[0.05, 0.8, -0.05]} castShadow receiveShadow>
        <boxGeometry args={[0.46, 0.015, 0.16]} />
        <meshStandardMaterial color="#2c3136" roughness={0.55} metalness={0.35} />
      </mesh>
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
}: {
  agents: LiveAgent[];
  events: LiveEvent[];
  connections: LiveConnection[];
  members: LiveMember[];
  actorName: (id: string) => string;
}) {
  const coder = connections.find((connection) => connection.live);
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
  const systemLine = latestLine(events, "system");
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
          designing={cast.some((person) => person.role === "Frontend" && person.working)}
          building={cast.some((person) => person.role === "Backend" && person.working)}
        />
        <Environment files="/live/studio.hdr" environmentIntensity={0.9} />
      </Suspense>
      {cast.map((person) => {
        const line = latestLine(events, person.id);
        return (
          <Walker key={person.role} spot={person.working ? person.work : person.idle}>
            <Figure accent={person.accent} tool={person.tool} />
            {line && (
              <Speech
                key={line.at}
                name={actorName(person.id) === "Participant" ? person.name : actorName(person.id)}
                text={line.text}
                at={line.at}
                position={[0, 1.08, 0]}
              />
            )}
          </Walker>
        );
      })}
      {coder && (
        <Coder
          label={coder.label || coder.displayName}
          line={coderId ? latestLine(events, coderId) : null}
        />
      )}
      {members.slice(0, 6).map((member, index) => {
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
        target={[0, 0.7, 0.2]}
        maxPolarAngle={Math.PI / 2.08}
        minDistance={2.2}
        maxDistance={7.2}
        enablePan={false}
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
}: {
  agents: LiveAgent[];
  events: LiveEvent[];
  connections: LiveConnection[];
  members: LiveMember[];
  actorName: (id: string) => string;
}) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const onHide = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);
  return (
    <div className="live-stage">
      <Canvas
        shadows
        dpr={[1, 1.6]}
        frameloop={hidden ? "never" : "always"}
        camera={{ position: [0.2, 2.45, 2.75], fov: 50, near: 0.08, far: 40 }}
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
