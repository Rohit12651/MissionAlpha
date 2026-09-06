// Phase 0-FIX — the visual harness DATA PLANE.
//
// THE PROBLEM THIS FIXES (Fable review, Phase 0):
// Phase 0's harness froze the CLOCK, the RNG and every animation, but not the DATA. Every
// capture reflected whatever the live :3006 runtime, its SQLite file and its auth token
// happened to be at that moment. Two consequences, both real:
//   1. Baselines were not portable — another machine, another day, different pixels.
//   2. When the environment broke (dev server down, RUNTIME_TOKEN_DIR mismatch → 401),
//      the harness did not fail. It captured the ERROR STATE and, on --update-snapshots,
//      baked it into the baselines. Fable measured 26/9/2/2 against exactly that.
//
// THE FIX: every data-plane request is served from a recorded fixture file, and a request
// with NO fixture is answered 503 AND recorded as missing so the spec can fail loudly.
// Silence is the bug; a missing fixture must be an error, never an empty page.
//
// RECORDING is a deliberate, separate step (`npm run test:visual:record`) run once against
// a healthy runtime. Playback never touches the network.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, "__fixtures__");
export const FIXTURE_FILE = join(FIXTURE_DIR, "api.json");

/** The token the app sees under fixtures. A real token must never reach disk. */
export const FIXTURE_TOKEN = "visual-fixture-token-not-a-real-credential";

/**
 * Prefixes vite proxies to the runtime (see vite.config.ts `server.proxy`) plus the two
 * vite-owned /api routes. Anything under these is application DATA and must be fixtured.
 */
const DATA_PLANE_PREFIXES = ["/api/", "/runtime/", "/runtime", "/inbox", "/factory/", "/factory"];

/**
 * The SSE stream is deliberately NOT data-plane. `route.fetch()` on a `text/event-stream`
 * never resolves — the body stays open by design — so recording it would hang the run.
 * The harness stubs `EventSource` in page context instead (see harness.mjs), which is
 * both hermetic and deterministic: the app reports "connected", zero events arrive.
 */
const EXCLUDED_EXACT = new Set(["/runtime/events"]);

/** True when a pathname must be served from a fixture rather than the network. */
export function isDataPlanePath(pathname) {
  if (EXCLUDED_EXACT.has(pathname)) return false;
  return DATA_PLANE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`),
  );
}

/**
 * Query params that change every run. Left in the key they would fragment it into
 * thousands of one-shot entries and every replay would miss.
 */
export const VOLATILE_PARAMS = ["ticket", "lastEventId", "_", "t", "ts", "cb", "nonce"];
const VOLATILE = new Set(VOLATILE_PARAMS);

/**
 * `METHOD /path?sorted&stable=query` — the fixture map key.
 *
 * Pairs are RE-ENCODED before joining and sorted as whole `k=v` strings. Both details
 * were defects found in review:
 *   * joining decoded values with raw `&`/`=` made `?a=1&b=2` and `?a=1%26b%3D2`
 *     collide on one key — two semantically different requests, one fixture.
 *   * sorting by key alone left repeated params (`?id=1&id=2`) order-dependent, so the
 *     same request could fragment into keys that never replay.
 */
export function fixtureKey(method, url) {
  const u = new URL(url);
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !VOLATILE.has(k))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort();
  const qs = params.length ? `?${params.join("&")}` : "";
  return `${method.toUpperCase()} ${u.pathname}${qs}`;
}

/** The SSE ticket the app mints before opening a stream. Single-use, 30s TTL — but a
 *  credential nonetheless, and credentials do not belong in a checked-in file. */
export const FIXTURE_TICKET = "visual-fixture-ticket-not-a-real-credential";

/**
 * Strip anything that must not be committed.
 *
 * THREE CLASSES, all found in review of the first recording:
 *   1. the runtime bearer token vite serves in cleartext to the same-origin dashboard;
 *   2. the SSE ticket — a second credential class the first version of this function
 *      missed entirely, because it only ever looked at one key;
 *   3. absolute filesystem paths. SQLite task records carry the operator's home
 *      directory, and a fixture file is committed — a home path is both a portability
 *      break and gratuitous disclosure.
 */
export function redactFixture(key, body) {
  if (key === "GET /api/runtime-token") return JSON.stringify({ token: FIXTURE_TOKEN });
  if (key === "POST /runtime/events/ticket") {
    // Keep the response SHAPE (the client reads `.ticket`) and drop the credential.
    try {
      const parsed = JSON.parse(body);
      return JSON.stringify({ ...parsed, ticket: FIXTURE_TICKET });
    } catch {
      return JSON.stringify({ ticket: FIXTURE_TICKET });
    }
  }
  return redactAbsolutePaths(body);
}

/** Placeholder that stands in for the recording machine's home directory. */
export const FIXTURE_HOME = "/fixture-home";

/**
 * Replace the recording machine's home directory wherever it appears in a payload.
 * Done on the RAW TEXT so it works inside JSON strings, error messages and nested
 * structures alike, with no assumption about the response shape.
 */
export function redactAbsolutePaths(body, home = process.env.HOME || "") {
  if (typeof body !== "string" || !home || home === "/") return body;
  return body.split(home).join(FIXTURE_HOME);
}

const routePredicate = (url) => {
  try {
    return isDataPlanePath(new URL(url).pathname);
  } catch {
    return false;
  }
};

/**
 * RECORD mode. Passes each data-plane request through to the live server, stores the
 * response, and fulfils the page with it so the recording session behaves normally.
 * `store` is mutated in place; call `saveFixtures(store)` when the run finishes.
 */
export async function recordFixtures(page, store) {
  await page.route(routePredicate, async (route) => {
    const req = route.request();
    const key = fixtureKey(req.method(), req.url());
    try {
      const res = await route.fetch({ timeout: 20_000 });
      const status = res.status();
      const contentType = res.headers()["content-type"] || "application/json";
      const raw = await res.text();
      // First writer wins: a page is polled repeatedly and later responses drift (counts
      // tick, timestamps move). Pinning the first keeps one run internally consistent.
      if (!(key in store)) store[key] = { status, contentType, body: redactFixture(key, raw) };
      await route.fulfill({ status, contentType, body: raw });
    } catch (err) {
      // A failed record is worth knowing about — record the failure rather than a body.
      store[key] = {
        status: 599,
        contentType: "application/json",
        body: JSON.stringify({ error: "record failed", detail: String(err?.message ?? err) }),
      };
      await route.fulfill({ status: 599, contentType: "application/json", body: store[key].body });
    }
  });
}

export async function saveFixtures(store) {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(store).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  await writeFile(FIXTURE_FILE, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
  return Object.keys(sorted).length;
}

export async function loadFixtures() {
  try {
    return JSON.parse(await readFile(FIXTURE_FILE, "utf-8"));
  } catch (err) {
    throw new Error(
      `visual fixtures missing at ${FIXTURE_FILE} — run \`npm run test:visual:record\` ` +
        `against a healthy runtime first. (${err?.message ?? err})`,
    );
  }
}

/**
 * PLAYBACK mode. Serves every data-plane request from the fixture file with ZERO network
 * access. A request with no fixture is answered 503 and pushed onto `report.missing` —
 * the caller asserts that array is empty, which is what turns a broken environment from a
 * silently-wrong baseline into a failing test.
 */
export async function installFixtures(page, report) {
  const fixtures = await loadFixtures();
  await page.route(routePredicate, async (route) => {
    const req = route.request();
    const key = fixtureKey(req.method(), req.url());
    const hit = fixtures[key];
    if (!hit) {
      if (!report.missing.includes(key)) report.missing.push(key);
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "no visual fixture for this request", key }),
      });
      return;
    }
    report.served += 1;
    await route.fulfill({ status: hit.status, contentType: hit.contentType, body: hit.body });
  });
  return fixtures;
}

/** Fresh report object for a single page's playback session. */
export function newReport() {
  return { missing: [], served: 0 };
}
