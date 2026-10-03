// Landing + Setup (spec §5.2, ADR-LS1) — the first-run landing: the approved mockup's
// `#v-landing` (docs/mockups/missionalpha-sketchbook.html, lines 780–875), transcribed 1:1
// onto the sketchbook classes. Every "Start a job" control calls `onStart` (the mockup's
// `data-go="app"`). The sections sit in a <main> landmark the mockup lacks: no visual change.
// No globe (spec §3).

import type { ActivityRow } from "../../lib/activityStream";
import { HeroFeed } from "./HeroFeed";

/** The mockup's six recipe steps (lines 1255–1262): number, title, text, who, time. */
const RECIPE: readonly (readonly [string, string, string, string, string])[] = [
  ["01", "Brief", "You write what you want in plain words.", "You", "1 min"],
  ["02", "The CEO weighs it", "Proceed, defer or kill, with the reason and a cheaper option.", "CEO agent", "seconds"],
  ["03", "Your answers", "The Manager's open questions, on one card. You answer each.", "You · gate", "your pace"],
  ["04", "The plan", "Tasks, each with a seat that owns it and the files it may touch.", "Manager agent", "seconds"],
  ["05", "The build", "Workers build in a sandbox and ask each other when they are stuck.", "Worker agents", "minutes"],
  ["06", "Your yes", "Every changed file, then one decision: ship it or send it back.", "You · gate", "your pace"],
];
const FILLS = ["#ffc400", "#a2d3a6", "#ed7328", "#d2b68c", "#6aa8dc", "#a2d3a6"];

export interface LandingProps {
  onStart: () => void;
  /** Runtime events received since launch; the live card shows them when there are any. */
  events: readonly ActivityRow[];
}

export function Landing({ onStart, events }: LandingProps) {
  return (
    <div className="view on" id="v-landing">
      <header className="site-nav">
        <div className="wrap">
          <a className="wordmark" href="#v-landing" aria-label="MissionAlpha home"><b>MISSIONALPHA</b><span>your team</span></a>
          <ul className="site-links">
            <li><a href="#how">How a job runs</a></li>
            <li><a href="#promises">What you decide</a></li>
            <li><a href="#" onClick={(e) => { e.preventDefault(); onStart(); }}>The cockpit</a></li>
          </ul>
          <button className="btn btn-primary" type="button" onClick={onStart}>Start a job</button>
        </div>
      </header>

      <main aria-label="Welcome">
        <section className="hero" aria-labelledby="hero-h">
          {/* organic blob divider: gold over sage */}
          <svg className="blob" viewBox="0 0 600 700" style={{ right: -120, top: -60, width: "min(640px,70vw)" }} aria-hidden="true">
            <path fill="#ffc400" d="M318 18c94-18 214 36 250 132 36 98-30 168-28 254 2 92 62 178-6 236-70 60-210 30-296-28C150 552 74 452 60 352 46 250 98 186 150 122 200 60 228 34 318 18Z" />
            <path fill="#a2d3a6" d="M420 420c70-20 150 30 160 104 10 76-40 150-122 166-84 16-176-30-190-104-12-70 70-140 152-166Z" />
          </svg>
          <svg className="sprig" style={{ left: -40, bottom: -30, width: 200, transform: "rotate(-8deg)" }} aria-hidden="true"><use href="#sprig" /></svg>
          <svg className="sprig sky" style={{ right: "34%", top: 18, width: 84, transform: "rotate(9deg)" }} aria-hidden="true"><use href="#seed" /></svg>

          <div className="wrap hero-grid">
            <div>
              <p className="label wide">An AI team you direct</p>
              <h1 className="display" id="hero-h">You decide.<br />The team does the rest.</h1>
              <p className="script">brief it in the morning, ship it by lunch</p>
              <p className="lede">Paste a brief. A CEO agent weighs it, a Manager plans it, and workers build it while talking to each other. You are asked exactly three things: should we, the open questions, and may it ship.</p>
              <div className="hero-actions">
                <button className="btn btn-primary" type="button" onClick={onStart}>Start a job <svg className="arrow" aria-hidden="true"><use href="#arrow" /></svg></button>
                <a className="btn btn-outline" href="#how">See how a job runs <svg className="arrow" aria-hidden="true"><use href="#arrow" /></svg></a>
              </div>
            </div>

            <HeroFeed events={events} />
          </div>
          <a className="scroll-cue" href="#how" aria-label="Scroll to how a job runs"><svg width="22" height="22" aria-hidden="true"><use href="#chev" /></svg></a>
        </section>

        <svg className="wave" viewBox="0 0 1440 180" preserveAspectRatio="none" aria-hidden="true"><path fill="#ed7328" d="M0 120C180 60 330 40 520 78c190 40 300 98 500 70 170-24 270-96 420-110V180H0Z" /></svg>
        <section className="band-orange" id="how" aria-labelledby="how-h">
          <svg className="sprig" style={{ right: -30, top: -60, width: 180, transform: "rotate(14deg)", color: "var(--ink)", opacity: 0.35 }} aria-hidden="true"><use href="#sprig" /></svg>
          <div className="wrap">
            <div className="band-head">
              <div>
                <p className="label wide" style={{ color: "var(--ink)" }}>Every job, the same recipe</p>
                <h2 className="display" id="how-h">How a job runs</h2>
              </div>
              <p>Six steps, in order, every time. The marked ones stop and wait for you; nothing moves past them on its own.</p>
            </div>
            <div className="recipes" id="recipes" tabIndex={0} role="region" aria-label="The six steps of a job, scroll sideways">
              {RECIPE.map(([n, h, p, who, t], i) => (
                <article className="recipe" key={n}>
                  <div className="recipe-art">
                    <svg viewBox="0 0 300 188" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
                      <path fill={FILLS[i]} d={`M${150 + (i % 3) * 18} 20c60 0 120 30 118 86-2 54-60 86-120 80-62-6-110-40-106-92 4-48 48-74 108-74Z`} opacity=".9" />
                      <use href={`#${i % 2 ? "seed" : "sprig"}`} x={i % 2 ? 176 : 196} y={i % 2 ? 40 : 6} width={i % 2 ? 96 : 92} height={i % 2 ? 96 : 150} style={{ color: "#234386" }} />
                    </svg>
                    <span className="step">{n}</span><span className="chip time">{t}</span>
                  </div>
                  <div className="recipe-body">
                    <h3>{h}</h3><p>{p}</p>
                    <p className="who-does"><span className="chip"><span className={`dot ${who.includes("gate") ? "orange" : "indigo"}`} />{who}</span></p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
        <svg className="wave" viewBox="0 0 1440 180" preserveAspectRatio="none" aria-hidden="true" style={{ transform: "scaleY(-1)", marginTop: -1 }}><path fill="#ed7328" d="M0 100C220 150 380 160 560 120c180-40 320-110 520-96 170 12 260 70 360 96V180H0Z" /></svg>

        <section className="promises" id="promises" aria-labelledby="pr-h">
          <svg className="sprig sky" style={{ left: -50, top: 40, width: 170, transform: "rotate(-12deg)" }} aria-hidden="true"><use href="#sprig" /></svg>
          <div className="wrap promise-grid">
            <div>
              <p className="label wide">What you decide, and what you never have to</p>
              <h2 className="display" id="pr-h">Three gates.<br />No surprises.</h2>
              <p className="script" style={{ fontSize: "1.9rem", marginTop: 16 }}>the team asks; it never assumes</p>
            </div>
            <ol className="promise-list">
              <li><span className="n">01</span><div><h3>The CEO says proceed, defer or kill</h3><p>Before any planning, a CEO agent judges the brief and names a cheaper option. If it says defer, you are asked a plain yes or no.</p></div></li>
              <li><span className="n">02</span><div><h3>You answer the Manager&apos;s questions</h3><p>Every open question arrives on one card, one answer each. Nothing is planned on a guess.</p></div></li>
              <li><span className="n">03</span><div><h3>You approve the ship</h3><p>You see every file each worker changed. Approve, and it lands on its own branch; send it back with a note, and the team tries again.</p></div></li>
              <li><span className="n">✓</span><div><h3>What workers can never touch</h3><p>Workers run inside a sandbox, and the runtime&apos;s own code is off-limits to them entirely. They change your project, not the thing that runs them.</p></div></li>
            </ol>
          </div>
        </section>
      </main>

      <footer className="foot" aria-labelledby="ft-h">
        <svg className="blob" viewBox="0 0 400 400" style={{ right: -90, bottom: -110, width: 360, opacity: 0.95 }} aria-hidden="true"><path fill="#ffc400" d="M210 20c86 10 170 70 172 160 2 92-66 190-160 200-96 10-200-50-202-150C18 130 120 10 210 20Z" /></svg>
        <svg className="sprig" style={{ left: "6%", bottom: 40, width: 120, color: "#6aa8dc", transform: "rotate(6deg)" }} aria-hidden="true"><use href="#sprig" /></svg>
        <div className="wrap" style={{ position: "relative" }}>
          <h2 className="display" id="ft-h">Give the team<br />its first brief.</h2>
          <p className="script">it will ask before it guesses</p>
          <button className="btn btn-primary" type="button" onClick={onStart}>Open the cockpit <svg className="arrow" aria-hidden="true"><use href="#arrow" /></svg></button>
          <div className="foot-meta">
            <span className="label">MissionAlpha · your team</span>
            {/* Honesty: the mockup says "Mockup · example data only", which is false in the app. */}
            <span className="label">Runs on this machine</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
