import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coerceSettings,
  mergeSettings,
  defaultSettings,
  ACCENTS,
} from "../settings.ts";

test("coerceSettings returns defaults for empty/garbage input (never throws)", () => {
  assert.deepEqual(coerceSettings(undefined), defaultSettings);
  assert.deepEqual(coerceSettings(null), defaultSettings);
  assert.deepEqual(coerceSettings(42), defaultSettings);
  assert.deepEqual(coerceSettings("hax"), defaultSettings);
});

test("coerceSettings drops invalid enums to safe defaults (anti-tamper)", () => {
  const s = coerceSettings({
    theme: "neon", // invalid
    accent: "rainbow", // invalid
    defaultTier: "gpt-4", // invalid + not a Claude tier
    reduceMotionOverride: "maybe",
  });
  assert.equal(s.theme, "dark");
  assert.equal(s.accent, "cyan");
  assert.equal(s.defaultTier, "sonnet");
  assert.equal(s.reduceMotionOverride, "system");
});

test("coerceSettings keeps valid values", () => {
  const s = coerceSettings({
    theme: "light",
    accent: "violet",
    defaultTier: "opus",
    connectorDefaults: { autoGrantNewAgents: true },
    toolLoop: { confirmEverySensitive: false },
    sandbox: { networkDefaultGranted: true },
    reduceMotionOverride: "on",
  });
  assert.equal(s.theme, "light");
  assert.equal(s.accent, "violet");
  assert.equal(s.defaultTier, "opus");
  assert.equal(s.connectorDefaults.autoGrantNewAgents, true);
  assert.equal(s.toolLoop.confirmEverySensitive, false);
  assert.equal(s.sandbox.networkDefaultGranted, true);
});

test("policy defaults are least-privilege out of the box", () => {
  assert.equal(defaultSettings.connectorDefaults.autoGrantNewAgents, false);
  assert.equal(defaultSettings.sandbox.networkDefaultGranted, false);
  assert.equal(defaultSettings.toolLoop.confirmEverySensitive, true);
});

test("mergeSettings re-validates so a bad patch cannot smuggle a value", () => {
  const merged = mergeSettings(defaultSettings, { defaultTier: "haiku" });
  assert.equal(merged.defaultTier, "haiku");
  // bad patch value is rejected, falls back to default
  const bad = mergeSettings(defaultSettings, { theme: "plasma" as unknown as "dark" });
  assert.equal(bad.theme, "dark");
});

test("every accent has dark + light base/bright OKLCH (no hex)", () => {
  for (const k of Object.keys(ACCENTS)) {
    const a = ACCENTS[k as keyof typeof ACCENTS];
    for (const theme of ["dark", "light"] as const) {
      assert.match(a[theme].base, /^oklch\(/);
      assert.match(a[theme].bright, /^oklch\(/);
    }
  }
});
