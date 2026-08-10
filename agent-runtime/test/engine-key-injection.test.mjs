// Multi-Provider Credentials (multi-account) — deterministic env-injection proof.
// The child-env builder strips every secret-shaped var, then re-injects
// ANTHROPIC_API_KEY ONLY when the active account is Claude in api_key mode
// (activeSecret present + activeProviderType === "claude"). Subscription mode and
// every non-claude type leave the key absent. No live model, no user auth needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChildEnv } from "../providers/child-env.mjs";

test("active claude api_key → ANTHROPIC_API_KEY present in child env", () => {
  const env = buildChildEnv(
    { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-host-should-be-stripped" },
    { activeSecret: "sk-ant-ACTIVE", activeProviderType: "claude" },
  );
  assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-ACTIVE");
  assert.equal(env.PATH, "/usr/bin", "non-secret vars pass through");
});

test("active claude subscription → key stripped, absent from child env", () => {
  const env = buildChildEnv(
    { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-host" },
    { activeSecret: null, activeProviderType: "claude" },
  );
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("active non-claude type with an api_key secret → NEVER injected as ANTHROPIC_API_KEY", () => {
  for (const type of ["openai", "minimax", "zai", "custom"]) {
    const env = buildChildEnv(
      { PATH: "/usr/bin", MY_API_KEY: "k", DB_SECRET: "s", GH_TOKEN: "t", PASSWORD: "p" },
      { activeSecret: "sk-should-not-leak", activeProviderType: type },
    );
    assert.equal(env.MY_API_KEY, undefined);
    assert.equal(env.DB_SECRET, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.PASSWORD, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined, `${type}: non-claude api_key is never injected as ANTHROPIC_API_KEY`);
  }
});

test("no active account (both null) → key absent", () => {
  const env = buildChildEnv(
    { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-host" },
    { activeSecret: null, activeProviderType: null },
  );
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("substring denylist strips non-suffix secret vars (DATABASE_URL, SECRET_KEY_BASE, AWS_ACCESS_KEY_ID, MY_TOKEN)", () => {
  const env = buildChildEnv(
    {
      PATH: "/usr/bin", HOME: "/home/me", LANG: "en_US.UTF-8", NODE_ENV: "production",
      DATABASE_URL: "postgres://u:p@h/db",
      SECRET_KEY_BASE: "sk-base",
      AWS_ACCESS_KEY_ID: "AKIA000",
      MY_TOKEN: "t",
    },
    { activeSecret: null, activeProviderType: "claude" },
  );
  assert.equal(env.DATABASE_URL, undefined, "credentials-in-URL var stripped");
  assert.equal(env.SECRET_KEY_BASE, undefined);
  assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(env.MY_TOKEN, undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/me");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.NODE_ENV, "production");
});

test("plain _URL without embedded credentials passes through", () => {
  const env = buildChildEnv(
    { PATH: "/usr/bin", API_BASE_URL: "https://api.example.com/v1" },
    { activeSecret: null, activeProviderType: "claude" },
  );
  assert.equal(env.API_BASE_URL, "https://api.example.com/v1", "no userinfo → not a credential leak");
});
