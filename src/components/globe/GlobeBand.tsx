// Pure-CSS pieces of the hero band — NO three.js. Shared by the PulseGlobe
// wrapper (Suspense/no-WebGL fallback) and the lazy GlobeCanvas. Kept three-free
// so importing them never pulls the 3D bundle into the main chunk.

export const BAND_CLASS =
  "relative -mx-4 -mt-7 mb-1 h-[260px] overflow-hidden sm:-mx-6 lg:-mx-8";

/** Static glowing band — fallback for no-WebGL, Suspense, and reduced-motion. */
export function StaticBand({ label }: { label?: string }) {
  return (
    <div
      className="absolute inset-0"
      style={{
        background:
          "radial-gradient(60% 120% at 50% 30%, color-mix(in oklch, var(--c-accent-cyan) 18%, transparent), transparent 60%)," +
          "radial-gradient(40% 90% at 70% 80%, color-mix(in oklch, var(--c-ceo-gold) 12%, transparent), transparent 55%)",
      }}
      aria-hidden
    >
      <div className="pointer-events-none absolute inset-0 opacity-40 [background:radial-gradient(circle_at_20%_40%,var(--c-accent-cyan)_0,transparent_1.5px),radial-gradient(circle_at_60%_30%,var(--c-done-green)_0,transparent_1.5px),radial-gradient(circle_at_80%_60%,var(--c-ceo-gold)_0,transparent_1.5px)] [background-size:auto]" />
      {label && (
        <span className="absolute bottom-2 left-1/2 -translate-x-1/2 font-mono text-[10px] uppercase tracking-widest text-muted">
          {label}
        </span>
      )}
    </div>
  );
}

/** Bottom fade so the band blends into the page + content sits above cleanly. */
export function BandOverlay() {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 h-16"
      style={{
        background: "linear-gradient(to bottom, transparent, var(--c-bg) 96%)",
      }}
      aria-hidden
    />
  );
}
