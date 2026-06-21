// Multimodal chat attachments (Feature #8 / ADR-049) — file intake for /chat.
//
// SECURITY model (files are NEVER executed and NEVER served over HTTP):
//   • Stored under tmpdir, mode 0o700, OUTSIDE the repo + every agent sandbox.
//   • Client filename is NEVER used to build a path — we generate `f<n><ext>`.
//   • Extension allowlist is hard; binary types also get a best-effort magic-byte
//     sniff (defense-in-depth). Text types pass by extension.
//   • Size + count caps are enforced at the busboy layer (DoS brake) — the values
//     here are the source of truth the server reads.
// The CLI reads these by absolute path via a Read tool scoped to the upload dir.

import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { mkdirSync, rmSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";

export const UPLOADS_ROOT =
  process.env.RUNTIME_UPLOADS_ROOT || join(tmpdir(), "missionalpha-uploads");

export const MAX_FILE_BYTES = Number(process.env.RUNTIME_MAX_FILE_BYTES || 25 * 1024 * 1024); // 25 MB
export const MAX_FILES = Number(process.env.RUNTIME_MAX_FILES || 8);
export const UPLOAD_TTL_MS = Number(process.env.RUNTIME_UPLOAD_TTL_MS || 24 * 60 * 60 * 1000); // 24 h

// ext → { kind, magic? }. `magic` is an array of leading byte values (or null slots
// = "any byte here", used for the RIFF/WEBP split). Absent magic = text (pass by ext).
const ALLOWED = Object.freeze({
  ".png":  { kind: "image", magic: [0x89, 0x50, 0x4e, 0x47] },
  ".jpg":  { kind: "image", magic: [0xff, 0xd8, 0xff] },
  ".jpeg": { kind: "image", magic: [0xff, 0xd8, 0xff] },
  ".gif":  { kind: "image", magic: [0x47, 0x49, 0x46, 0x38] },
  ".webp": { kind: "image", magic: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50] },
  ".pdf":  { kind: "pdf",   magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  ".csv":  { kind: "text" },
  ".txt":  { kind: "text" },
  ".md":   { kind: "text" },
  // xlsx is a zip container → PK header (0x50 0x4b 0x03 0x04). Server converts to CSV
  // before forwarding to the agent; the agent never sees the binary blob (ADR-049 §2).
  ".xlsx": { kind: "spreadsheet", magic: [0x50, 0x4b, 0x03, 0x04] },
});

export const ALLOWED_EXTS = Object.freeze(Object.keys(ALLOWED));

// Lowercased extension of a client filename, or "" if none/unknown.
export function extOf(name) {
  return extname(String(name || "")).toLowerCase();
}

// Is this filename an allowed type? (extension allowlist — the hard gate.)
export function extAllowed(name) {
  return Object.prototype.hasOwnProperty.call(ALLOWED, extOf(name));
}

export function kindFor(name) {
  const e = ALLOWED[extOf(name)];
  return e ? e.kind : null;
}

// Best-effort magic-byte check against the declared extension. Text types always
// pass (no reliable signature). Binary types must match their leading bytes.
// `head` is a Buffer of the file's first chunk.
export function sniffOk(head, name) {
  const e = ALLOWED[extOf(name)];
  if (!e) return false;
  if (!e.magic) return true; // text
  if (!head || head.length < e.magic.length) return false;
  for (let i = 0; i < e.magic.length; i++) {
    if (e.magic[i] == null) continue; // wildcard slot
    if (head[i] !== e.magic[i]) return false;
  }
  return true;
}

// Server-generated, traversal-proof on-disk name. Client filename is metadata only.
export function safeName(index, clientName) {
  const e = extOf(clientName);
  const ext = Object.prototype.hasOwnProperty.call(ALLOWED, e) ? e : ".bin";
  return `f${index}${ext}`;
}

// Sanitize a client filename for DISPLAY only (manifest/UI) — never for a path.
export function displayName(clientName) {
  return String(clientName || "file")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[^\w.\- ]/g, "")
    .slice(0, 80) || "file";
}

export function uploadMsgDir(threadId, msgId) {
  const safe = (s) => String(s).replace(/[^a-z0-9_-]/gi, "_").slice(0, 64);
  return join(UPLOADS_ROOT, safe(threadId), safe(msgId));
}

export function ensureUploadDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Prompt block appended to the CLI prompt so the agent reads files by absolute path.
export function buildManifest(attachments) {
  if (!attachments || !attachments.length) return "";
  const lines = attachments.map((a) => {
    const note = a.kind === "text" ? "text" : a.kind;
    const from = a.note ? `, ${a.note}` : "";
    return `- ${a.absPath}  (${note}, "${displayName(a.origName)}"${from})`;
  });
  return (
    `\n\n--- attached files (read them with the Read tool by absolute path) ---\n` +
    lines.join("\n") +
    `\n--- end attached files ---`
  );
}

// Delete a thread's whole upload tree (best-effort).
export function pruneThreadUploads(threadId) {
  const safe = String(threadId).replace(/[^a-z0-9_-]/gi, "_").slice(0, 64);
  try { rmSync(join(UPLOADS_ROOT, safe), { recursive: true, force: true }); } catch { /* */ }
}

// XLSX → CSV conversion (ADR-049 §2). Converts the FIRST sheet of an xlsx file to a
// CSV sidecar alongside the original. Caps output to maxRows rows and 2_000_000 chars
// (prevent wide-sheet prompt bombs). Wraps all parsing in try/catch so a corrupt or
// zip-bomb xlsx never throws — callers receive {error} and can drop the attachment.
//
// Returns { csvPath, rows, truncated } on success, or { error: string } on failure.
export async function xlsxToCsv(absPath, { maxRows = 5000 } = {}) {
  try {
    // Pre-flight: verify PK magic bytes (xlsx is a zip) before invoking SheetJS.
    // SheetJS silently "parses" arbitrary text as a spreadsheet when the magic is
    // wrong — checking here ensures garbage/corrupt files always yield {error}.
    const { openSync, readSync, closeSync } = await import("node:fs");
    const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04
    let fd;
    try {
      fd = openSync(absPath, "r");
      const head = Buffer.alloc(4);
      readSync(fd, head, 0, 4, 0);
      closeSync(fd);
      fd = undefined;
      for (let i = 0; i < XLSX_MAGIC.length; i++) {
        if (head[i] !== XLSX_MAGIC[i]) return { error: "unreadable xlsx" };
      }
    } catch {
      if (fd != null) { try { closeSync(fd); } catch { /* */ } }
      return { error: "unreadable xlsx" };
    }

    // SheetJS ships as CJS; dynamic import gives us the namespace. The actual API
    // lives on `.default` when imported via ESM dynamic import.
    const ns = await import("xlsx");
    const XLSX = ns.default ?? ns;
    // SECURITY: bound the parse at the decompression stage with `sheetRows` so a zip
    // bomb (small compressed file → millions of sparse cells) can't exhaust heap BEFORE
    // the post-parse row cap applies. maxRows+1 reads one extra row so truncation is
    // still detectable below. (xlsx@0.18.5 also carries CVE-2023-30533 prototype
    // pollution — accepted for this single-operator/loopback tool; input is operator-
    // supplied, and the post-parse path does no for-in over tainted objects. Real fix:
    // migrate to a patched SheetJS source or exceljs — tracked follow-up.)
    const wb = XLSX.readFile(absPath, { sheetRows: maxRows + 1 });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return { error: "unreadable xlsx" };
    const ws = wb.Sheets[sheetName];
    let csv = XLSX.utils.sheet_to_csv(ws);

    // An xlsx that parsed but has no cell data → unreadable.
    if (!csv || !csv.trim()) return { error: "unreadable xlsx" };

    // Cap output length to guard against wide/deep sheets blowing the prompt.
    const MAX_CSV_CHARS = 2_000_000;
    if (csv.length > MAX_CSV_CHARS) csv = csv.slice(0, MAX_CSV_CHARS);

    const lines = csv.split("\n");
    let truncated = false;
    let rows = lines.length;

    // Cap to maxRows data rows (first line is typically the header).
    if (rows > maxRows) {
      truncated = true;
      rows = maxRows;
      csv = lines.slice(0, maxRows).join("\n");
    }

    // Sidecar path: strip .xlsx extension, append .csv (or just append .csv).
    const csvPath = absPath.endsWith(".xlsx")
      ? absPath.slice(0, -5) + ".csv"
      : absPath + ".csv";

    writeFileSync(csvPath, csv, { mode: 0o600 });
    return { csvPath, rows, truncated };
  } catch {
    return { error: "unreadable xlsx" };
  }
}

// Boot sweep — remove upload dirs older than the TTL (bounds disk). Best-effort.
export function sweepStaleUploads(ttlMs = UPLOAD_TTL_MS, now = Date.now()) {
  let removed = 0;
  if (!existsSync(UPLOADS_ROOT)) return removed;
  let threads;
  try { threads = readdirSync(UPLOADS_ROOT); } catch { return removed; }
  for (const t of threads) {
    const p = join(UPLOADS_ROOT, t);
    try {
      if (now - statSync(p).mtimeMs > ttlMs) { rmSync(p, { recursive: true, force: true }); removed++; }
    } catch { /* */ }
  }
  return removed;
}
