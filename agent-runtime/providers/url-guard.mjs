// Multi-Provider Credentials — SSRF guard for any user-supplied http(s) baseUrl.
//
// A probe-capable openai account (and a stored custom baseUrl) can carry a URL that the
// SERVER fetches. Without this guard, `http://169.254.169.254/…` (cloud metadata),
// loopback, or RFC1918 targets would be reachable via the server. assertSafeHttpUrl
// parses the URL, forces http(s), rejects a literal blocked IP, and rejects if DNS
// resolves the hostname to ANY private/loopback/link-local/unique-local address.
//
// isBlockedIp(addr) is a PURE, DNS-free predicate (exported for hermetic unit tests):
// true for a literal IPv4/IPv6 in a blocked range, false for a public literal or a
// non-IP string. A hostname that does not resolve is treated as unreachable, not
// blocked — the subsequent fetch simply fails, so there is no SSRF target to reject.
import { lookup } from "node:dns/promises";

// ── literal-IP parsing (no network) ──────────────────────────────────────────
function ipv4ToBytes(str) {
  const parts = str.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (bytes.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return Uint8Array.from(bytes);
}

function ipv6ToBytes(input) {
  let str = input.split("%")[0]; // drop any zone id
  let v4 = null;
  const dot = str.indexOf(".");
  if (dot !== -1) {
    const colon = str.lastIndexOf(":", dot);
    if (colon === -1) return null;
    v4 = ipv4ToBytes(str.slice(colon + 1));
    if (!v4) return null;
    str = str.slice(0, colon); // hextets preceding the embedded IPv4
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (g) =>
    g === "" ? [] : g.split(":").map((h) => (/^[0-9a-fA-F]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  const left = parseGroups(halves[0]);
  const right = halves.length === 2 ? parseGroups(halves[1]) : null;
  if (left.some(Number.isNaN) || (right && right.some(Number.isNaN))) return null;
  const v4Groups = v4 ? [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]] : [];
  let groups;
  if (right === null) {
    groups = [...left, ...v4Groups];
  } else {
    const fill = 8 - (left.length + right.length + v4Groups.length);
    if (fill < 0) return null;
    groups = [...left, ...Array(fill).fill(0), ...right, ...v4Groups];
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[i * 2] = (g >> 8) & 0xff;
    bytes[i * 2 + 1] = g & 0xff;
  });
  return bytes;
}

function isBlockedV4(b) {
  const [a, second] = b;
  if (a === 0) return true; // 0.0.0.0/8 (incl. 0.0.0.0)
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && second === 254) return true; // 169.254/16 link-local (incl. 169.254.169.254)
  if (a === 172 && second >= 16 && second <= 31) return true; // 172.16/12
  if (a === 192 && second === 168) return true; // 192.168/16
  return false;
}

function isBlockedV6(b) {
  // ::ffff:x.x.x.x — IPv4-mapped: judge on the embedded IPv4.
  const v4Mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  if (v4Mapped) return isBlockedV4(b.slice(12, 16));
  if (b.every((x) => x === 0)) return true; // :: unspecified
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  return false;
}

// Pure predicate: is `addr` a literal IP in a blocked range? Non-IP → false.
export function isBlockedIp(addr) {
  if (typeof addr !== "string") return false;
  const s = addr.trim();
  const v4 = ipv4ToBytes(s);
  if (v4) return isBlockedV4(v4);
  const v6 = ipv6ToBytes(s);
  if (v6) return isBlockedV6(v6);
  return false;
}

// Parse + vet a user-supplied URL for server-side fetch. Returns a URL or throws.
export async function assertSafeHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL protocol: ${url.protocol}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isBlockedIp(hostname)) throw new Error(`blocked host: ${hostname}`);
  // Resolve the hostname; reject if ANY address is private/loopback/link-local/ULA.
  // A resolution failure means the host is unreachable (no SSRF target) → allow.
  let addrs;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    return url;
  }
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new Error(`host resolves to a blocked address: ${address}`);
  }
  return url;
}
