// Lazy access to the generated skill catalog.
//
// WHY: the roster is ~3,100 entries (src/data/skills.gen.json → src/lib/missionSkills.ts).
// Statically importing it from App.tsx put ~50 KB gzipped of data in the FIRST paint chunk
// for a surface nobody sees until they open the palette, the factory picker, or type "/".
// Every consumer is user-triggered, so the catalog loads on demand into its own chunk and
// is cached process-wide after the first await.

import type { MissionSkill, SkillKind } from "./missionSkills";

export type { MissionSkill, SkillKind };

export interface SkillCatalog {
  MISSION_SKILLS: readonly MissionSkill[];
  filterSkills: (query: string) => MissionSkill[];
  KIND_LABEL: Record<SkillKind, string>;
}

let cache: SkillCatalog | null = null;
let inflight: Promise<SkillCatalog> | null = null;

/** The catalog if it is already resident, else null. Never triggers a load. */
export function loadedCatalog(): SkillCatalog | null {
  return cache;
}

/** Load (once) and cache the catalog chunk. Concurrent callers share one request. */
export function loadCatalog(): Promise<SkillCatalog> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = import("./missionSkills").then((m) => {
      cache = { MISSION_SKILLS: m.MISSION_SKILLS, filterSkills: m.filterSkills, KIND_LABEL: m.KIND_LABEL };
      inflight = null;
      return cache;
    });
  }
  return inflight;
}
