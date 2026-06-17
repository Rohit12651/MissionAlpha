import { Suspense, lazy, useMemo } from "react";
import { useReducedMotion } from "framer-motion";
import type { AgentState, FeedEvent, SchedulerHealth } from "../data/types";
import { StaticBand, BandOverlay, BAND_CLASS } from "./globe/GlobeBand";

// Lazy-load the WebGL surface (Canvas + three.js + the scene). This keeps three,
// @react-three/fiber and @react-three/drei OUT of the main bundle so the board
// paints fast; the 3D chunk streams in afterward behind the static band.
const GlobeCanvas = lazy(() => import("./globe/GlobeCanvas"));

/** One-shot WebGL capability probe. Cached per session. */
let webglOK: boolean | null = null;
function hasWebGL(): boolean {
  if (webglOK !== null) return webglOK;
  try {
    const canvas = document.createElement("canvas");
    webglOK = !!(
      window.WebGLRenderingContext &&
      (canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    );
  } catch {
    webglOK = false;
  }
  return webglOK;
}

interface PulseGlobeProps {
  agents: AgentState[];
  feed: FeedEvent[];
  scheduler: SchedulerHealth;
  nowMs: number;
}

/**
 * Hero band: a 3D node constellation of the swarm behind the title. Degrades to
 * a static glowing gradient if WebGL is unavailable; renders a non-animated
 * snapshot under prefers-reduced-motion; never crashes the board (the inner
 * GlobeCanvas carries its own error boundary).
 */
export function PulseGlobe({ agents, feed, scheduler, nowMs }: PulseGlobeProps) {
  const reduce = useReducedMotion();
  const animate = !reduce;
  // Probe once; memo keeps it stable across re-renders.
  const supported = useMemo(() => hasWebGL(), []);

  // Hard fallback path — no WebGL at all.
  if (!supported) {
    return (
      <div className={BAND_CLASS} aria-hidden>
        <StaticBand />
        <BandOverlay />
      </div>
    );
  }

  // Static band is the Suspense fallback so first paint shows the band, then the
  // 3D chunk hydrates over it.
  const bandFallback = (
    <div className={BAND_CLASS} aria-hidden>
      <StaticBand />
      <BandOverlay />
    </div>
  );

  return (
    <Suspense fallback={bandFallback}>
      <GlobeCanvas
        agents={agents}
        feed={feed}
        scheduler={scheduler}
        nowMs={nowMs}
        animate={animate}
      />
    </Suspense>
  );
}
