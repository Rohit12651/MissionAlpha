// ADR-037 — SANDBOX ESCAPE SUITE. MUST be green before the tool-loop broker ships.
// Pure arg-builder assertions (every security flag present) + LIVE container escape
// attempts that must ALL fail (host fs, network, root, socket) — proving the boundary.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { buildDockerArgs, createSandbox, dirSizeBytes, DEFAULT_DISK_CAP_BYTES } from "../sandbox.mjs";

const IMG = "alpine:3"; // fast, already pulled; exec image (node:20-alpine) tested via live broker
const sb = createSandbox({ image: IMG });
// Top-level await: resolve docker availability BEFORE the test() calls so `skip` is
// evaluated correctly at definition time (a `before` hook would run too late).
const DOCKER_UP = await sb.dockerAvailable();
let wt;

before(() => {
  wt = mkdtempSync(join(tmpdir(), "ma-sbx-wt-"));
  writeFileSync(join(wt, "seed.txt"), "scaffold here\n");
});
after(() => { try { rmSync(wt, { recursive: true, force: true }); } catch { /* */ } });

// ── PURE arg-builder — every security flag must be present (no docker needed) ──
test("buildDockerArgs carries the full lockdown by default", () => {
  const { args } = buildDockerArgs({ worktreeDir: "/tmp/wt", command: "ls", callId: "c1" });
  const s = args.join(" ");
  assert.ok(s.includes("--cap-drop ALL"));
  assert.ok(s.includes("--security-opt no-new-privileges"));
  assert.ok(s.includes("--user 65534:65534"));
  assert.ok(s.includes("--read-only"));
  assert.ok(s.includes("--network none"), "network off by default");
  assert.ok(s.includes("--pids-limit 128"));
  assert.ok(s.includes("--memory 512m --memory-swap 512m"), "no swap escape");
  assert.ok(s.includes("-v /tmp/wt:/work:rw"));
  assert.ok(s.includes("-w /work"));
  assert.ok(args[args.length - 3] === "sh" && args[args.length - 2] === "-c" && args[args.length - 1] === "ls", "command is the final argv token to sh -c");
});

test("buildDockerArgs NEVER includes privilege/escape flags or the docker socket", () => {
  const { args } = buildDockerArgs({ worktreeDir: "/tmp/wt", command: "x", callId: "c" });
  const s = args.join(" ");
  for (const bad of ["--privileged", "--cap-add", "--device", "--pid=host", "docker.sock", "/var/run/docker"]) {
    assert.ok(!s.includes(bad), `must not include ${bad}`);
  }
});

test("network grant flips ONLY the network flag (still capdrop/non-root/read-only)", () => {
  const { args } = buildDockerArgs({ worktreeDir: "/tmp/wt", command: "x", callId: "c", network: true });
  const s = args.join(" ");
  assert.ok(!s.includes("--network none"), "network granted → no --network none");
  assert.ok(s.includes("--cap-drop ALL") && s.includes("--user 65534:65534") && s.includes("--read-only"), "other locks intact");
});

test("container name is sanitized from callId (kill-switch target, injection-proof)", () => {
  const { name } = buildDockerArgs({ worktreeDir: "/tmp/wt", command: "x", callId: "a b;rm -rf/" });
  assert.match(name, /^ma-sbx-[a-z0-9_-]+$/i);
  assert.ok(!name.includes(" ") && !name.includes(";"));
});

// ── LIVE escape attempts (skip if docker daemon is down) ──────────────────────
test("LIVE: host filesystem is NOT reachable (/Users, host home)", { skip: !DOCKER_UP }, async () => {
  const r = await sb.runInSandbox(wt, "ls /Users 2>&1; echo ---; ls " + homedir() + " 2>&1", { image: IMG, timeoutMs: 30000 });
  assert.ok(!r.stdout.includes("Downloads"), "host home contents must not appear");
  assert.match(r.stdout, /No such file|not found|---/, "host paths absent");
});

test("LIVE: worktree write flows back to the host (positive control)", { skip: !DOCKER_UP }, async () => {
  const r = await sb.runInSandbox(wt, "echo agentdata > /work/agent-out.txt && echo WROTE", { image: IMG, timeoutMs: 30000 });
  assert.match(r.stdout, /WROTE/);
  assert.ok(existsSync(join(wt, "agent-out.txt")), "file landed in host worktree");
});

test("LIVE: rootfs is read-only; only /work and /tmp are writable", { skip: !DOCKER_UP }, async () => {
  const r = await sb.runInSandbox(wt, "echo x > /escape 2>&1 || echo ROOTFS_RO; echo y > /tmp/ok && echo TMP_OK; echo z > /work/ok && echo WORK_OK", { image: IMG, timeoutMs: 30000 });
  assert.match(r.stdout, /ROOTFS_RO/);
  assert.match(r.stdout, /TMP_OK/);
  assert.match(r.stdout, /WORK_OK/);
});

test("LIVE: network egress is BLOCKED by default", { skip: !DOCKER_UP }, async () => {
  const r = await sb.runInSandbox(wt, "wget -T3 -qO- http://1.1.1.1 2>&1 || echo NET_BLOCKED", { image: IMG, timeoutMs: 30000 });
  assert.match(r.stdout + r.stderr, /NET_BLOCKED|unreachable|bad address|download timed out/i);
});

test("LIVE: runs as non-root (uid 65534), no privilege escalation", { skip: !DOCKER_UP }, async () => {
  const r = await sb.runInSandbox(wt, "id -u", { image: IMG, timeoutMs: 30000 });
  assert.equal(r.stdout.trim(), "65534");
});

test("LIVE: docker socket is NOT present inside the container", { skip: !DOCKER_UP }, async () => {
  const r = await sb.runInSandbox(wt, "ls /var/run/docker.sock 2>&1 || echo NO_SOCKET", { image: IMG, timeoutMs: 30000 });
  assert.match(r.stdout, /NO_SOCKET|No such file/);
});

test("LIVE: kill-switch — a runaway is terminated at the timeout", { skip: !DOCKER_UP }, async () => {
  const t0 = Date.now();
  const r = await sb.runInSandbox(wt, "sleep 60", { image: IMG, timeoutMs: 3000 }); // random name → no back-to-back collision
  assert.ok(r.timedOut, "marked timed out");
  assert.ok(Date.now() - t0 < 20000, "returned promptly after kill, not after 60s");
});

// ── /work disk DoS — host-side watchdog bounds the one writable host path ──────
test("dirSizeBytes sums a tree and early-outs once over the cap", () => {
  const d = mkdtempSync(join(tmpdir(), "ma-sbx-du-"));
  try {
    writeFileSync(join(d, "a.bin"), Buffer.alloc(4096));
    writeFileSync(join(d, "b.bin"), Buffer.alloc(4096));
    assert.equal(dirSizeBytes(d), 8192, "sums all files");
    assert.ok(dirSizeBytes(d, 5000) > 5000, "stops as soon as the cap is crossed");
    assert.ok(DEFAULT_DISK_CAP_BYTES >= 64 * 1024 * 1024, "ships with a sane default cap");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("LIVE: a runaway /work fill is bounded and the container is killed", { skip: !DOCKER_UP }, async () => {
  const cap = 8 * 1024 * 1024; // 8MB test cap
  // Append 1MB at a time toward 2GB, throttled so the watchdog can react well before
  // the host disk fills. Without the watchdog this would write the full 2GB to /work.
  const fill = "i=0; while [ $i -lt 2048 ]; do dd if=/dev/zero bs=1M count=1 >> /work/fill 2>/dev/null; i=$((i+1)); sleep 0.1; done; echo FILLED";
  const r = await sb.runInSandbox(wt, fill, { image: IMG, timeoutMs: 60000, limits: { diskBytes: cap } });
  assert.ok(r.diskExceeded, "watchdog tripped on the cap");
  assert.ok(r.killed, "container was killed");
  assert.ok(!r.stdout.includes("FILLED"), "the fill loop never ran to completion");
  // The host worktree must stay bounded — proven well under the 2GB the loop targeted.
  assert.ok(dirSizeBytes(wt) < 64 * 1024 * 1024, "worktree size stayed bounded after the kill");
});

test("mount-injection: a non-existent worktreeDir is refused before docker run", async () => {
  const r = await sb.runInSandbox("/no/such/dir/xyz", "ls", { image: IMG });
  assert.equal(r.exitCode, -1);
  assert.match(r.error || "", /does not exist|required/);
});

test("preflight reports docker availability (fail-closed when down)", async () => {
  const p = await sb.preflight();
  assert.equal(typeof p.ok, "boolean");
  if (!DOCKER_UP) assert.equal(p.ok, false);
});
