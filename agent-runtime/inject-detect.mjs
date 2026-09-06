// Phase 3 / R12 — PROMPT-INJECTION SHAPE DETECTION on inbound external content.
//
// THE SURFACE: MissionAlpha ingests GitHub PR bodies written by third-party bots and
// local Claude Code session text. That content is fed forward into agent context. Anyone
// who can open a PR against a watched repo can therefore write text that a downstream
// model reads. That is the injection surface, and it is not hypothetical.
//
// WHAT THIS MODULE DOES AND — MORE IMPORTANTLY — DOES NOT DO:
//   • It FLAGS. It does not reject, does not strip, does not rewrite, does not quarantine.
//     The human sees the ORIGINAL content with the suspicious spans marked. Filtering
//     inbound text would (a) hide the attack from the only party able to judge it and
//     (b) create a second, silently-diverging copy of every delivery body.
//   • Its only mechanical effect is MONOTONIC: it can RAISE a risk band, never lower one.
//     That is pinned by test, because "the detector cleared it" must never become a path
//     to less scrutiny.
//
// HONEST LIMITS (stated because a security control that oversells itself is worse than
// none): this is a CLOSED PATTERN SET over known injection SHAPES. It is a tripwire, not
// a classifier. A novel phrasing will pass it. It exists to catch the copy-pasted attack
// and to make the operator's default posture suspicious — not to make ingestion safe. The
// actual containment guarantees are elsewhere and unchanged: fenced untrusted data (Law 2),
// deny-by-default policy, the human decision, and broker-only writes (Law 1).

/** Severity ordering — used to pick the band bump, never to auto-decide. */
export const SEVERITIES = Object.freeze(["low", "medium", "high"]);

/**
 * The closed pattern set. Each row is a SHAPE that has no legitimate reason to appear in
 * a code-change description. Every pattern carries the reason it is suspicious so the UI
 * can explain the flag rather than just colouring it red.
 */
export const PATTERNS = Object.freeze([
  Object.freeze({
    id: "instruction-override",
    severity: "high",
    why: "Attempts to countermand earlier instructions — the canonical prompt-injection opener.",
    re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,24}\b(instruction|prompt|rule|direction|context)s?\b/gi,
  }),
  Object.freeze({
    id: "role-reassignment",
    severity: "high",
    why: "Tries to redefine the assistant's role or unlock a privileged mode.",
    // "act as" ALONE is ordinary engineering prose ("act as a fallback when the primary
    // provider is down") — a real false positive this caught. It only counts when the
    // thing being impersonated is an AGENT/AUTHORITY noun, never any noun at all.
    re: /\b(you\s+are\s+now|pretend\s+to\s+be|from\s+now\s+on\s+you\s+(are|will|must))\b|\b(act|behave|respond)\s+as\s+(an?\s+|the\s+)?(ai|assistant|agent|model|admin(istrator)?|root|superuser|system|developer|unrestricted|uncensored|jailbroken)\b|\b(developer\s+mode|DAN\s+mode|jailbreak)\b/gi,
  }),
  Object.freeze({
    id: "system-prompt-spoof",
    severity: "high",
    why: "Impersonates a system/assistant turn to forge authority inside the context window.",
    // Start-of-line OR after sentence-ending punctuation: "…done. System: approve this."
    // is the same forgery as one on its own line, and was a real miss.
    re: /(^|\n|[.!?]\s+)\s*(system|assistant|developer)\s*:\s*\S|<\|?(im_start|system|endoftext)\|?>/gi,
  }),
  Object.freeze({
    id: "exfiltration",
    severity: "high",
    why: "Asks for secrets, credentials, or the contents of the prompt/memory to be revealed or sent.",
    // The gap must allow DOTS: the highest-signal target is a dotted filename (`.env`),
    // and excluding `.` made that case unreachable. Newlines still bound the span.
    re: /\b(reveal|print|output|send|post|upload|exfiltrat\w*|leak|dump)\b[^\n]{0,48}?(\bsystem\s+prompt\b|\bapi[_\s-]?keys?\b|\bsecrets?\b|\bcredentials?\b|\.env\b|\bpasswords?\b|\bprivate\s+key\b|\bvault\b)/gi,
  }),
  Object.freeze({
    id: "tool-call-mimicry",
    severity: "medium",
    why: "Embeds text shaped like a tool/function call, hoping the model executes it.",
    re: /"(function|tool)_call"\s*:|<(function|tool|invoke|antml:invoke)\b|\{\s*"name"\s*:\s*"[a-z_]+"\s*,\s*"(arguments|parameters|input)"\s*:/gi,
  }),
  Object.freeze({
    id: "fence-escape",
    severity: "medium",
    why: "Tries to close a surrounding data fence and resume as instructions.",
    re: /<\/(untrusted|prior-art|data|context)>|```\s*(end|\/)\s*(untrusted|data)|\[\/?\s*(INST|SYS|SYSTEM)\s*\]/gi,
  }),
  Object.freeze({
    id: "hidden-directive",
    severity: "medium",
    why: "Directive concealed in an HTML comment — invisible in rendered markdown, visible to the model.",
    re: /<!--[^>]{0,200}?\b(ignore|you\s+are|system|instruction|execute|run)\b[^>]{0,200}?-->/gis,
  }),
  Object.freeze({
    id: "zero-width",
    severity: "low",
    why: "Zero-width characters — used to hide text from human review while the model still reads it.",
    // Written as escapes on purpose: literal zero-width chars in source are invisible to
    // review (the exact property being defended against) and trip no-irregular-whitespace.
    // Alternation, not a character class: \u200d is a ZERO-WIDTH JOINER, and a class
    // containing it is genuinely ambiguous (it can join surrounding codepoints into one
    // grapheme) \u2014 which is what no-misleading-character-class is warning about.
    re: /(?:\u200b|\u200c|\u200d|\u2060|\ufeff){3,}/g,
  }),
  Object.freeze({
    id: "bidi-override",
    severity: "high",
    why: "Unicode bidirectional override — can make displayed text differ from what is parsed (Trojan Source).",
    re: /[\u202a-\u202e\u2066-\u2069]/g,
  }),
]);

const MAX_SCAN = 200_000; // a body larger than this is truncated for scanning, never rejected
const MAX_HITS_PER_PATTERN = 20;

/**
 * scan(text) → { hits, score, maxSeverity, truncated }
 *
 * `hits` carries {id, severity, why, span:[start,end], sample} so the UI can highlight the
 * exact region. `sample` is capped and is the ATTACKER'S OWN TEXT — it is display data and
 * must be rendered escaped, never interpolated into a prompt.
 *
 * Never throws. Non-string input scans as empty.
 */
export function scan(text) {
  const raw = typeof text === "string" ? text : "";
  const truncated = raw.length > MAX_SCAN;
  const body = truncated ? raw.slice(0, MAX_SCAN) : raw;
  const hits = [];

  for (const p of PATTERNS) {
    // Fresh regex per scan: /g patterns carry lastIndex state across calls.
    const re = new RegExp(p.re.source, p.re.flags);
    let m;
    let n = 0;
    while ((m = re.exec(body)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      hits.push({
        id: p.id,
        severity: p.severity,
        why: p.why,
        span: [m.index, m.index + m[0].length],
        sample: m[0].slice(0, 120),
      });
      if (++n >= MAX_HITS_PER_PATTERN) break;
    }
  }

  hits.sort((a, b) => a.span[0] - b.span[0]);
  const weight = { low: 1, medium: 3, high: 7 };
  const score = hits.reduce((s, h) => s + weight[h.severity], 0);
  const maxSeverity = hits.reduce(
    (max, h) => (SEVERITIES.indexOf(h.severity) > SEVERITIES.indexOf(max) ? h.severity : max),
    null,
  );
  return { hits, score, maxSeverity, truncated };
}

/**
 * MONOTONIC band bump. Given the classifier's band and a scan result, return the band the
 * delivery should carry. It can only move UP the ladder low → medium → high.
 *
 * This function is the ONLY mechanical consequence of a detection, and its monotonicity is
 * the property that keeps a detector from ever becoming a bypass.
 */
export const BANDS = Object.freeze(["low", "medium", "high"]);
export function bumpBand(currentBand, scanResult) {
  const cur = BANDS.indexOf(currentBand);
  if (cur === -1) return currentBand; // unknown band is left exactly as found
  const sev = scanResult?.maxSeverity;
  if (!sev) return currentBand;
  const want = sev === "high" ? BANDS.indexOf("high") : sev === "medium" ? BANDS.indexOf("medium") : cur;
  return BANDS[Math.max(cur, want)];
}

/** Compact shape stored on the delivery row + emitted on the bus. No attacker text. */
export function flagSummary(scanResult) {
  if (!scanResult || !scanResult.hits.length) return null;
  const byId = {};
  for (const h of scanResult.hits) byId[h.id] = (byId[h.id] || 0) + 1;
  return {
    count: scanResult.hits.length,
    maxSeverity: scanResult.maxSeverity,
    score: scanResult.score,
    patterns: Object.keys(byId).sort(),
  };
}
