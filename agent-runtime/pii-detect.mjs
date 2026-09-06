// Phase 3 / R11 — TYPED PII DETECTION for the egress path.
//
// WHAT THE EXISTING SCRUB DOES AND DOES NOT DO: `secret-scrub.mjs` owns the ONE egress
// chain and catches SECRETS (keys, tokens, credentials). It does not catch PERSONAL data
// — an agent that reads a customer CSV and summarises it into a Delivery body puts real
// emails, phones and card numbers on the bus and into the audit export. Different data
// class, different regexes, same chain.
//
// ONE CHAIN, ALWAYS. This module exports pure detectors and a `redact` function. It does
// NOT open a second egress path and does NOT carry its own SECRET_RE — the B2 law is that
// exactly one chain scrubs, and a second one is how two behaviours drift apart until one
// of them is silently weaker. The composition point is secret-scrub.mjs; this file is a
// library it calls.
//
// PER-DESTINATION POLICY, because the right answer differs by where the bytes are going:
//   export   → REDACT. A CSV/JSON audit export leaves the machine. It gets typed masking.
//   internal → PASS + COUNT. The operator reviewing a Delivery in their own Inbox needs to
//              SEE the content to judge it; masking it there would hide the very thing
//              they must decide about. They get a count so they know it is there.
// Redacting the operator's own review surface would be security theatre that degrades the
// human decision — the one control this whole product is built around.
//
// FALSE POSITIVES ARE A REAL COST. A detector that fires on every version string ("1.2.3"
// as a phone number) trains the operator to ignore it. Every pattern here is anchored and
// validated (Luhn for cards, structural checks for SSN) and the FP budget is pinned by a
// fixture corpus in the tests.

/** Closed type set. */
export const PII_TYPES = Object.freeze(["email", "phone", "card", "ssn", "ip", "address"]);

/** Luhn check — the difference between "16 digits" and "a card number". */
export function luhn(digits) {
  const s = String(digits).replace(/\D/g, "");
  if (s.length < 13 || s.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** SSN structural validity — the ranges the SSA never issues. */
export function validSsn(s) {
  const m = /^(\d{3})-?(\d{2})-?(\d{4})$/.exec(String(s).trim());
  if (!m) return false;
  const [, area, group, serial] = m;
  if (area === "000" || area === "666" || Number(area) >= 900) return false;
  if (group === "00" || serial === "0000") return false;
  return true;
}

const DETECTORS = Object.freeze([
  Object.freeze({
    type: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    // example.com/test/localhost are documentation and fixture addresses, not people.
    valid: (v) => !/@(example\.(com|org|net)|test|localhost|invalid)$/i.test(v) && !/^(noreply|no-reply)@/i.test(v),
    mask: (v) => {
      const [u, d] = v.split("@");
      return `${u.slice(0, 2)}${"*".repeat(Math.max(1, u.length - 2))}@${d}`;
    },
  }),
  Object.freeze({
    type: "card",
    // Run BEFORE phone: a 16-digit card must not be claimed by the phone detector.
    //
    // STRICT GROUPING, and this matters. A permissive `(?:\d[ -]?){13,19}` looks correct
    // and is a genuine false-positive generator: on "123-45-6789 415-555-0132" it spans
    // the SSN and the phone into one 18-digit run, and a Luhn check over that soup can
    // PASS by coincidence — inventing a credit card out of two unrelated identifiers and
    // masking both. Real card numbers are either a bare digit run or evenly grouped in
    // fours, so the pattern says exactly that and the whole class disappears.
    re: /\b(?:\d{13,19}|\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7})\b/g,
    valid: (v) => luhn(v),
    mask: (v) => { const d = v.replace(/\D/g, ""); return `****-****-****-${d.slice(-4)}`; },
  }),
  Object.freeze({
    type: "ssn",
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
    valid: (v) => validSsn(v),
    mask: () => "***-**-****",
  }),
  Object.freeze({
    type: "phone",
    // Requires a separator or a leading +/( so bare 10-digit ids do not match.
    re: /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\b\d{3})[ .-]\d{3}[ .-]\d{4}\b/g,
    valid: (v) => {
      const d = v.replace(/\D/g, "");
      return d.length >= 10 && d.length <= 15 && !/^(\d)\1+$/.test(d);
    },
    mask: (v) => { const d = v.replace(/\D/g, ""); return `***-***-${d.slice(-4)}`; },
  }),
  Object.freeze({
    type: "ip",
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    valid: (v) => {
      const p = v.split(".").map(Number);
      if (p.some((n) => n > 255)) return false;
      // Loopback / RFC1918 are infrastructure, not personal data.
      if (p[0] === 127 || p[0] === 10 || p[0] === 0) return false;
      if (p[0] === 192 && p[1] === 168) return false;
      if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
      return true;
    },
    mask: (v) => `${v.split(".").slice(0, 2).join(".")}.*.*`,
  }),
  Object.freeze({
    type: "address",
    re: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b\.?/g,
    valid: () => true,
    mask: () => "[address redacted]",
  }),
]);

/** scan(text) → { hits, counts, total }. Never throws. Non-overlapping, first-match-wins. */
export function scanPii(text) {
  const body = typeof text === "string" ? text : "";
  const hits = [];
  const taken = [];
  const overlaps = (a, b) => taken.some(([s, e]) => a < e && b > s);

  for (const d of DETECTORS) {
    const re = new RegExp(d.re.source, d.re.flags);
    let m;
    while ((m = re.exec(body)) !== null) {
      if (!m[0].length) { re.lastIndex++; continue; }
      const start = m.index;
      let value = m[0];
      if (!d.valid(value)) {
        // Give the detector one chance to salvage a valid, SHORTER candidate anchored at
        // the same start (see the card detector's `refine`). Without this a real card
        // followed by any other number is silently missed.
        const refined = typeof d.refine === "function" ? d.refine(value) : null;
        if (!refined) { re.lastIndex = start + 1; continue; }
        value = refined;
        re.lastIndex = start + value.length; // resume after what we actually claimed
      }
      const end = start + value.length;
      if (overlaps(start, end)) continue;   // an earlier, higher-priority type owns this span
      taken.push([start, end]);
      hits.push({ type: d.type, span: [start, end], value, masked: d.mask(value) });
    }
  }

  hits.sort((a, b) => a.span[0] - b.span[0]);
  const counts = {};
  for (const h of hits) counts[h.type] = (counts[h.type] || 0) + 1;
  return { hits, counts, total: hits.length };
}

/**
 * redact(text) → { text, counts, total }. Masks every detected value in place.
 * Applied right-to-left so earlier spans stay valid as the string changes length.
 */
export function redactPii(text) {
  const body = typeof text === "string" ? text : "";
  const { hits, counts, total } = scanPii(body);
  let out = body;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    out = out.slice(0, h.span[0]) + `[PII:${h.type}]${h.masked}` + out.slice(h.span[1]);
  }
  return { text: out, counts, total };
}

/** Closed destination policy. Unknown destination is treated as EXTERNAL and redacted. */
export const PII_POLICY = Object.freeze({
  export: "redact",
  audit: "redact",
  federation: "redact",
  sse: "count",
  ui: "count",
  internal: "count",
});

/**
 * applyPolicy(text, destination) → { text, counts, total, action }
 * The single entry point secret-scrub.mjs composes. Fails SAFE: an unrecognised
 * destination redacts rather than passes.
 */
export function applyPiiPolicy(text, destination) {
  const action = PII_POLICY[String(destination)] || "redact";
  if (action === "redact") return { ...redactPii(text), action };
  const { counts, total } = scanPii(text);
  return { text: typeof text === "string" ? text : "", counts, total, action: "count" };
}
