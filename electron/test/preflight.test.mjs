// electron/test/preflight.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../preflight.js";

const okExec = async () => ({ code: 0 });
const failExec = (failCmd) => async (cmd) => { if (cmd.includes(failCmd)) throw new Error("not found"); return { code: 0 }; };

test("all present → ok, not blocking", async () => {
  const r = await preflight({ exec: okExec, env: {} });
  assert.equal(r.ok, true); assert.equal(r.blocking, false);
  assert.equal(r.claude, true); assert.equal(r.docker, true); assert.equal(r.auth, true);
});

test("docker down → non-blocking warn, chat still ok", async () => {
  const r = await preflight({ exec: failExec("docker"), env: {} });
  assert.equal(r.docker, false); assert.equal(r.ok, true); assert.equal(r.blocking, false);
  assert.ok(r.messages.some((m) => /docker/i.test(m)));
});

test("claude missing → blocking", async () => {
  const r = await preflight({ exec: failExec("claude"), env: {} });
  assert.equal(r.claude, false); assert.equal(r.ok, false); assert.equal(r.blocking, true);
});

test("no claude but ANTHROPIC_API_KEY → auth true via env, still blocked on claude binary", async () => {
  const r = await preflight({ exec: failExec("claude"), env: { ANTHROPIC_API_KEY: "sk-ant-x" } });
  assert.equal(r.auth, true); assert.equal(r.claude, false); assert.equal(r.blocking, true);
});
