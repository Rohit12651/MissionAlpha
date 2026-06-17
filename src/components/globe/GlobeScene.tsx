import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Line, Stars } from "@react-three/drei";
import * as THREE from "three";

/**
 * Soft radial-gradient sprite used as an additive halo behind each node. This
 * gives the bloom/glow look WITHOUT a postprocessing EffectComposer pass — which
 * is GPU-cheaper and avoids the r3f-v9 / postprocessing-v3 context-attribute
 * incompatibility. Built once on the client.
 */
function makeHaloTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
import type { AgentState, FeedEvent, SchedulerHealth } from "../../data/types";
import {
  agentIntent,
  constellationEdges,
  fibonacciSphere,
  nodeBrightness,
  nodeScale,
  NODE_HEX,
  recentTalks,
  type Edge,
  type SpherePoint,
} from "../../lib/globe";

const RADIUS = 2.4;
const BASE_NODE = 0.11;
const WHITE = new THREE.Color("#ffffff");

interface GlobeSceneProps {
  agents: AgentState[];
  feed: FeedEvent[];
  scheduler: SchedulerHealth;
  nowMs: number;
  isLight: boolean;
  animate: boolean;
}

interface NodeLayout {
  agent: AgentState;
  pos: SpherePoint;
  color: THREE.Color;
  scale: number;
  brightness: number;
  stale: boolean;
}

// Pin the CEO near center-top; everything else keeps its fibonacci slot.
function layoutNodes(agents: AgentState[]): NodeLayout[] {
  const pts = fibonacciSphere(agents.length, RADIUS);
  return agents.map((agent, i) => {
    const intent = agentIntent(agent);
    const brightness = nodeBrightness(intent);
    const pos =
      agent.id === "ceo"
        ? { x: 0, y: RADIUS * 0.62, z: RADIUS * 0.45 }
        : pts[i];
    // Scale the core color past 1.0 (toneMapped is off) so active/CEO cores read
    // as vivid emissive points, not flat dark dots, against their glow halos.
    const color = new THREE.Color(NODE_HEX[intent]).multiplyScalar(
      0.7 + 0.35 * brightness,
    );
    return {
      agent,
      pos,
      color,
      scale: nodeScale(intent),
      brightness,
      stale: agent.stale && !agent.dead,
    };
  });
}

/**
 * Node field — 16 small spheres. Per-mesh material colors are bulletproof vs the
 * InstancedMesh `instanceColor` shader-compile timing quirk in r3f v9, and 16
 * meshes is trivially cheap (one shared geometry, no perf concern). Cores are
 * brightened toward white by activity so each reads as a luminous point inside
 * its colored halo. Active/stale nodes pulse/flicker via per-mesh scale.
 */
function Nodes({
  nodes,
  animate,
  breathe,
}: {
  nodes: NodeLayout[];
  animate: boolean;
  breathe: () => number;
}) {
  const refs = useRef<Array<THREE.Mesh | null>>([]);
  const geometry = useMemo(() => new THREE.SphereGeometry(BASE_NODE, 16, 16), []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Precompute each node's core color (its accent lerped toward white).
  const coreColors = useMemo(
    () =>
      nodes.map((n) =>
        n.color.clone().lerp(WHITE, Math.min(0.85, 0.25 + 0.3 * n.brightness)),
      ),
    [nodes],
  );

  useFrame((state) => {
    if (!animate) return;
    const t = state.clock.elapsedTime;
    const field = breathe();
    nodes.forEach((n, i) => {
      const mesh = refs.current[i];
      if (!mesh) return;
      const flicker = n.stale
        ? 0.7 + 0.3 * Math.abs(Math.sin(t * 6 + i))
        : 1 + 0.04 * Math.sin(t * 1.5 + i);
      mesh.scale.setScalar(n.scale * field * flicker);
    });
  });

  return (
    <group>
      {nodes.map((n, i) => (
        <mesh
          key={n.agent.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          geometry={geometry}
          position={[n.pos.x, n.pos.y, n.pos.z]}
          scale={n.scale}
          frustumCulled={false}
        >
          <meshBasicMaterial color={coreColors[i]} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Additive glow halos behind nodes — the bloom substitute. Sprites always face
 * the camera; size scales with node activity + the breath; stale halos flicker.
 */
function Halos({
  nodes,
  texture,
  animate,
  breathe,
  isLight,
}: {
  nodes: NodeLayout[];
  texture: THREE.Texture;
  animate: boolean;
  breathe: () => number;
  isLight: boolean;
}) {
  const refs = useRef<Array<THREE.Sprite | null>>([]);

  useFrame((state) => {
    if (!animate) return;
    const t = state.clock.elapsedTime;
    const field = breathe();
    nodes.forEach((n, i) => {
      const sprite = refs.current[i];
      if (!sprite) return;
      const flicker = n.stale ? 0.6 + 0.5 * Math.abs(Math.sin(t * 6 + i)) : 1;
      const s = n.scale * 0.55 * n.brightness * field * flicker;
      sprite.scale.setScalar(s);
    });
  });

  return (
    <group>
      {nodes.map((n, i) => (
        <sprite
          key={n.agent.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          position={[n.pos.x, n.pos.y, n.pos.z]}
          scale={n.scale * 0.55 * n.brightness}
        >
          <spriteMaterial
            map={texture}
            color={n.color}
            transparent
            opacity={isLight ? 0.5 : 0.85}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </sprite>
      ))}
    </group>
  );
}

/** Faint constellation edges, brighter when their two agents recently talked. */
function Edges({
  nodes,
  edges,
  feed,
  nowMs,
  isLight,
}: {
  nodes: NodeLayout[];
  edges: Edge[];
  feed: FeedEvent[];
  nowMs: number;
  isLight: boolean;
}) {
  const talks = useMemo(() => recentTalks(feed, nowMs), [feed, nowMs]);
  const idIndex = useMemo(() => {
    const m = new Map<string, number>();
    nodes.forEach((n, i) => m.set(n.agent.id, i));
    return m;
  }, [nodes]);

  const litPairs = useMemo(() => {
    const s = new Set<string>();
    for (const t of talks) {
      const a = idIndex.get(t.from);
      const b = idIndex.get(t.to);
      if (a === undefined || b === undefined) continue;
      s.add(a < b ? `${a}-${b}` : `${b}-${a}`);
    }
    return s;
  }, [talks, idIndex]);

  const baseColor = isLight ? "#94a3b8" : "#3a4458";
  const litColor = "#38e6f5";

  return (
    <group>
      {edges.map((e) => {
        const key = `${e.a}-${e.b}`;
        const lit = litPairs.has(key);
        const a = nodes[e.a].pos;
        const b = nodes[e.b].pos;
        return (
          <Line
            key={key}
            points={[
              [a.x, a.y, a.z],
              [b.x, b.y, b.z],
            ]}
            color={lit ? litColor : baseColor}
            lineWidth={lit ? 1.4 : 0.6}
            transparent
            opacity={lit ? 0.85 : isLight ? 0.25 : 0.18}
            toneMapped={false}
          />
        );
      })}
      <TravelPulses nodes={nodes} talks={talks} idIndex={idIndex} />
    </group>
  );
}

/** A small bright dot traveling from→to along each active talk edge. */
function TravelPulses({
  nodes,
  talks,
  idIndex,
}: {
  nodes: NodeLayout[];
  talks: Array<{ from: string; to: string; ageSec: number }>;
  idIndex: Map<string, number>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const tmp = useMemo(() => new THREE.Vector3(), []);

  const segments = useMemo(
    () =>
      talks
        .map((t) => ({ a: idIndex.get(t.from), b: idIndex.get(t.to) }))
        .filter(
          (s): s is { a: number; b: number } =>
            s.a !== undefined && s.b !== undefined,
        ),
    [talks, idIndex],
  );

  useFrame((state) => {
    const g = groupRef.current;
    if (!g) return;
    const t = (state.clock.elapsedTime % 1.5) / 1.5; // 0→1 loop
    g.children.forEach((child, i) => {
      const seg = segments[i];
      if (!seg) return;
      const a = nodes[seg.a].pos;
      const b = nodes[seg.b].pos;
      tmp.set(a.x, a.y, a.z).lerp(
        new THREE.Vector3(b.x, b.y, b.z),
        t,
      );
      child.position.copy(tmp);
    });
  });

  return (
    <group ref={groupRef}>
      {segments.map((s, i) => (
        <mesh key={`${s.a}-${s.b}-${i}`}>
          <sphereGeometry args={[0.05, 10, 10]} />
          <meshBasicMaterial color="#7af5ff" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/** Slowly auto-rotating root; breathes with the scheduler tick cadence. */
export function GlobeScene({
  agents,
  feed,
  scheduler,
  nowMs,
  isLight,
  animate,
}: GlobeSceneProps) {
  const groupRef = useRef<THREE.Group>(null);
  const nodes = useMemo(() => layoutNodes(agents), [agents]);
  const edges = useMemo(
    () => constellationEdges(nodes.map((n) => n.pos), 2),
    [nodes],
  );

  // Breath synced to tick cadence: a slow sine whose period = cadenceSec.
  const cadence = Math.max(8, scheduler.cadenceSec || 50);
  const breathe = () => {
    if (!animate) return 1;
    const phase = (Date.now() / 1000) % cadence;
    return 1 + 0.05 * Math.sin((phase / cadence) * Math.PI * 2);
  };

  useFrame((_, delta) => {
    if (!animate) return;
    const g = groupRef.current;
    if (g) g.rotation.y += delta * 0.08;
  });

  // Halo opacity is dialed down in light mode so the glow doesn't blow out on
  // white (the bloom-substitute equivalent of lowering bloom intensity).
  const haloTexture = useMemo(() => makeHaloTexture(), []);
  useEffect(() => () => haloTexture.dispose(), [haloTexture]);

  return (
    <>
      <ambientLight intensity={0.4} />
      <Stars
        radius={50}
        depth={30}
        count={isLight ? 600 : 1400}
        factor={3}
        saturation={0}
        fade
        speed={animate ? 0.4 : 0}
      />
      <group ref={groupRef}>
        <Halos
          nodes={nodes}
          texture={haloTexture}
          animate={animate}
          breathe={breathe}
          isLight={isLight}
        />
        <Nodes nodes={nodes} animate={animate} breathe={breathe} />
        <Edges
          nodes={nodes}
          edges={edges}
          feed={feed}
          nowMs={nowMs}
          isLight={isLight}
        />
      </group>
    </>
  );
}
