import { Suspense, lazy } from "react";
import { Canvas } from "@react-three/fiber";
import type { AgentState, FeedEvent, SchedulerHealth } from "../../data/types";
import { useTheme } from "../../theme/useTheme";
import { GlobeBoundary } from "./GlobeBoundary";
import { StaticBand, BandOverlay, BAND_CLASS } from "./GlobeBand";

// Lazy-load the heavy three.js scene so it never blocks first paint of the board.
const GlobeScene = lazy(() =>
  import("./GlobeScene").then((m) => ({ default: m.GlobeScene })),
);

interface GlobeCanvasProps {
  agents: AgentState[];
  feed: FeedEvent[];
  scheduler: SchedulerHealth;
  nowMs: number;
  animate: boolean;
}

/**
 * The WebGL surface. Split out from PulseGlobe and lazy-loaded by it so that
 * three.js + @react-three/fiber land in a DEFERRED chunk — the board paints
 * without paying for the 3D bundle up front (Phase 5 perf). Wrapped in a render
 * error boundary so a lost context degrades to the static band, never the board.
 */
export default function GlobeCanvas({
  agents,
  feed,
  scheduler,
  nowMs,
  animate,
}: GlobeCanvasProps) {
  const { theme } = useTheme();
  const isLight = theme === "light";

  const fallbackBand = (
    <div className={BAND_CLASS} aria-hidden>
      <StaticBand />
      <BandOverlay />
    </div>
  );

  return (
    <GlobeBoundary fallback={fallbackBand}>
      <div className={BAND_CLASS} role="img" aria-label="Live swarm constellation">
        <Suspense fallback={<StaticBand label="loading swarm" />}>
          <Canvas
            dpr={[1, 2]}
            frameloop={animate ? "always" : "demand"}
            camera={{ fov: 50, position: [0, 0.4, 4.6], near: 0.1, far: 100 }}
            gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
            onCreated={({ gl }) => {
              // Transparent canvas so the body wash shows through.
              gl.setClearColor(0x000000, 0);
            }}
            style={{ background: "transparent" }}
          >
            <GlobeScene
              agents={agents}
              feed={feed}
              scheduler={scheduler}
              nowMs={nowMs}
              isLight={isLight}
              animate={animate}
            />
          </Canvas>
        </Suspense>
        <BandOverlay />
      </div>
    </GlobeBoundary>
  );
}
