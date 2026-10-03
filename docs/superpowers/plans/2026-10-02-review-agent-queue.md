# Review agent queue — MissionAlpha parity

Frames the parity gate allowlists (`test/visual/parity-gate.mjs`). Each item is for the separate
review agent, not for this session. When a frame reaches MATCH, the gate goes RED until its key is
removed from `PARITY_ALLOWLIST`; remove it in the same change and tick the item here.

Run the gate: `npm run test:parity > out.log 2>&1; echo EXIT=$? >> out.log` (never through a pipe).

## Queue

- [ ] **Inbox** — 4 end frames (desktop, laptop, tablet, mobile). Handoff prompt was issued in the Phase G round; context in `2026-09-17-missionalpha-repair-plan.md` (Inbox row and "Correction (Inbox "oldest")").
- [ ] **Missions** — 6 frames (desktop top/end, laptop top, tablet top/end, mobile end). Handoff prompt was issued in the Phase G round; context in the repair-plan log (Missions row).
- [ ] **Setup step 3 + step 4 at 375px** — added 2026-10-02. Prompt below.

### Setup step 3 + step 4 at 375px

**Escalation handoff: Setup step 3 (Account) and step 4 (Project) at 375px.** Three fix cycles are spent. These are the only two Landing+Setup frames that do not MATCH. Paste the prompt below into a fresh session:

> In /Users/RohitAnandeshi/Downloads/WaahyuFOLDER/MissonAlpha, two parity frames still fail at 375px only. Desktop, laptop and tablet MATCH for the same steps.
>
> **The two frames:**
> - setup-3-mobile-top (Account step): 3458 red px, 1532 differing.
> - setup-4-mobile-top (Project step): 205 red px, 74 differing.
>
> Run `TAB_AUDIT=1 ./node_modules/.bin/playwright test test/visual/tab-audit.spec.mjs -g "setup-3-mobile|setup-4-mobile" --config=playwright.config.mjs > out.log 2>&1; echo EXIT=$? >> out.log`. Then compare `test/visual/__screenshots__/{app,mockup,diff}/setup-{3,4}-mobile-top.png`.
>
> **Already ruled out:**
> - Element boxes are identical to sub-pixel precision.
> - Computed styles are identical except `text-rendering`. Setting it to `auto` inside `.ob` changed nothing (3458 → 3458), so that edit was reverted.
> - No data masks are involved: 0 data, 0 app-only.
>
> **Where the red is:** the glyphs of the radio-option labels (step 3) and the "BACK" button text (both steps).
>
> **Suspects, in order:**
> 1. The mockup's radios are inside a `<label>` with different whitespace or text nodes, so the inline text flow differs.
> 2. Letter-spacing on the `.btn` label resolves differently at the mobile font size.
> 3. Antialiasing from a fractional x-offset of the dialog at 375px (`.ob` width uses a calc).
>
> **Rules:**
> - Edit only `src/components/onboarding/Setup.tsx` and scoped `.sk .ob` rules in `src/index.css`.
> - Re-run all 24 setup frames afterwards: no regression allowed at other breakpoints.
> - Do not loosen the comparator (`maxDiffPixels` 40, `threshold` .012).
> - Do not commit.
