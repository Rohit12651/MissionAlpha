// Phase G (ADR G-2) — the mockup's board column (kcol()): a header with the stage label and
// "you · N" on a human-gate column, then the cards or a quiet "empty". Shared by the
// Stories and Jobs boards.

import type { ReactNode } from "react";

export function Kcol({ label, gate = false, count, children }: { label: string; gate?: boolean; count: number; children?: ReactNode }) {
  return (
    <section className={gate ? "kcol gate" : "kcol"} aria-label={gate ? `${label}, your gate` : label}>
      <div className="kcol-h"><span className="label">{label}</span><span className="sub">{`${gate ? "you · " : ""}${count}`}</span></div>
      {count === 0 ? <p className="sub" style={{ textAlign: "center", margin: "12px 0" }}>empty</p> : children}
    </section>
  );
}
