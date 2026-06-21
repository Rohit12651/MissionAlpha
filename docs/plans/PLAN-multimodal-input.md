# Implementation Plan — Multimodal File Input (Feature #8)

**Status:** Draft for review
**Target ADR:** ADR-049-multimodal-input (promote on approval)
**Branch base:** `s1-engine`
**Owner:** TBD
**Estimated effort:** 1.5–2 days (1 dev)

---

## 1. Goal

Bring MissionAlpha's chat composer to input parity with the Claude Code / claude.ai UI: let the BOSS attach **images, PDFs, Excel/CSV, and plain text/docs** to a chat message, have them stored safely server-side, and surface them to the spawned Claude CLI so the agent can actually read them.

Out of scope for this plan: slash commands (already shipped — `src/lib/missionSkills.ts`) and MCP connectors/plugins (already shipped — `agent-runtime/mcp-registry.mjs`). Optional UI surfacing of those is listed under Stretch (§9).

## 2. Why this is cheap + high value

- Real briefs arrive as mockups, PDFs, and spreadsheets. Today the CEO/architect only get a single text line.
- The Claude CLI invocation is **already multimodal-ready** — it spawns `claude -p` and can read files by path via the `Read` tool (images + PDF native to the model; xlsx needs preprocessing).
- The only missing pieces are: an attach UI, a multipart upload path, server-side file storage, and prompt injection. No engine/scheduler changes.

## 3. Current state (traced, with anchors)

| Layer | File / anchor | State |
|---|---|---|
| Composer (textarea + send + slash menu) | `src/components/workspace/ChatPane.tsx` (~lines 105–494) | IMPLEMENTED. Single `<textarea>`, `send()` callback. No file handling. |
| Send request | `ChatPane.tsx:204` → `POST /runtime/{threadId}/chat`, JSON `{message, model}` | IMPLEMENTED, JSON only. |
| Chat route | `agent-runtime/server.mjs:939` (`POST /runtime/:agentId/chat`) | IMPLEMENTED. Body cap **16_000 bytes** at `server.mjs:952`. |
| Chat handler | `server.mjs:645` `handleChat()` → `cliReply()` | IMPLEMENTED. |
| CLI spawn | `server.mjs:585` `spawn(CLAUDE_BIN, args, …)`; prompt via **stdin** at `server.mjs:641` | IMPLEMENTED. `-p --output-format stream-json … --no-session-persistence`, READ_TOOLS include `Read`. |
| Engine spawn (autonomous loop) | `server.mjs:772` / `:809` | IMPLEMENTED (out of scope; chat path only for v1). |
| File upload endpoint | — | **ABSENT.** |
| Multipart parsing | — | **ABSENT.** No `busboy`/`formidable`/`multer` in `package.json`. |
| xlsx parsing | — | **ABSENT.** No `xlsx` dep. |
| File storage dir | — | **ABSENT.** (Sandbox + threads dirs exist; no uploads dir.) |

Server is raw `node:http` (uses a `readBody(maxBytes)` helper pattern, not Express).

## 4. Architecture

```
ChatPane (attach btn + drag/paste)
   │  FormData { message, model, files[] }
   ▼
POST /runtime/:agentId/chat   (multipart branch)
   │  busboy stream-parse → validate (type/size/count)
   │  write → UPLOADS_ROOT/{threadId}/{msgId}/{safeName}
   │  xlsx → convert to CSV/text sidecar
   ▼
handleChat(agentId, message, attachments[], …)
   │  build attachment manifest (abs paths + types)
   ▼
cliReply(): inject manifest block into prompt (stdin)
   │  "Attached files (read via Read tool): - /abs/p1 …"
   ▼
claude -p  (Read tool already allowed) → vision/PDF native; xlsx via CSV sidecar
   │
   ▼
TTL cleanup: prune {threadId} dir when thread pruned
```

## 5. Phased implementation

### Phase 0 — Dependencies
- Add `busboy` (streaming multipart, minimal, well-audited) to `agent-runtime` deps.
- Add `xlsx` (SheetJS) for spreadsheet → CSV conversion. (If a lighter option is preferred, `node-xlsx`.)
- Pin versions; run `npm i` and commit lockfile.

### Phase 1 — Server: upload storage + multipart (`agent-runtime/server.mjs`)
1. Add constants near existing tmp dirs:
   ```js
   const UPLOADS_ROOT = process.env.RUNTIME_UPLOADS_ROOT
     || join(tmpdir(), "missionalpha-uploads");
   const MAX_FILE_BYTES  = Number(process.env.RUNTIME_MAX_FILE_BYTES  || 25 * 1024 * 1024); // 25MB
   const MAX_FILES       = Number(process.env.RUNTIME_MAX_FILES       || 8);
   const MAX_UPLOAD_TOTAL= Number(process.env.RUNTIME_MAX_UPLOAD_TOTAL|| 60 * 1024 * 1024); // 60MB
   const ALLOWED_EXT = new Set([".png",".jpg",".jpeg",".gif",".webp",".pdf",".xlsx",".csv",".txt",".md"]);
   const ALLOWED_MIME = new Set([
     "image/png","image/jpeg","image/gif","image/webp",
     "application/pdf",
     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
     "text/csv","text/plain","text/markdown",
   ]);
   ```
2. At the `/runtime/:agentId/chat` route (`server.mjs:939`), branch on `Content-Type`:
   - `application/json` → existing path unchanged (back-compat).
   - `multipart/form-data` → new `handleChatMultipart()`.
3. `handleChatMultipart()`:
   - Parse with `busboy`, enforcing busboy `limits` (`fileSize`, `files`).
   - For each file: validate ext **and** sniff magic-bytes (don't trust client MIME); reject on mismatch or disallowed type.
   - Generate `msgId = randomBytes(8).hex`; dir `UPLOADS_ROOT/{threadId}/{msgId}/`, mode `0o700`.
   - Write each file under a **generated safe name** `f{n}{ext}` — never use the client filename in the path. Keep original name only as metadata.
   - On any limit/validation breach: destroy stream, delete partial dir, return `413`/`415` with clear error.
   - Collect `message`, `model` text fields.
   - Build `attachments = [{ absPath, origName, mime, kind }]`; call `handleChat(agentId, message, res, tier, modelId, attachments)`.

### Phase 2 — Server: xlsx preprocessing
- Before prompt injection, for each `kind === "spreadsheet"`:
  - Read with `xlsx`, emit a `.csv` (or compact text) sidecar next to original.
  - Swap the path passed to the CLI to the CSV sidecar (model can't parse binary xlsx).
  - Cap converted rows (e.g. 5k) to avoid prompt blowup; note truncation in manifest.

### Phase 3 — Server: prompt injection (`cliReply` `server.mjs:519–643`)
- Extend `handleChat` + `cliReply` signatures with `attachments`.
- After the transcript, append a manifest block to the prompt (which is written to stdin at `server.mjs:641`):
  ```
  --- attached files (read with the Read tool by absolute path) ---
  - /abs/.../f1.png  (image, "mockup.png")
  - /abs/.../f2.csv  (from Excel "orders.xlsx", 1200 rows, truncated)
  ```
- No `--allowed-tools` change needed: `Read` already in READ_TOOLS. Confirm chat path runs with a tools mode that includes `Read`; if a thread runs `TOOLS=none`, add `Read` for attachment turns or document the constraint.

### Phase 4 — Client: composer attach UI (`src/components/workspace/ChatPane.tsx`)
1. State: `const [attachments, setAttachments] = useState<File[]>([])`.
2. Hidden input + attach button placed before Send (~before line 484):
   ```tsx
   <input ref={fileRef} type="file" multiple style={{display:"none"}}
     accept="image/*,.pdf,.xlsx,.csv,.txt,.md"
     onChange={e => addFiles(e.target.files)} />
   <button onClick={() => fileRef.current?.click()} title="Attach"><Paperclip size={14}/></button>
   ```
3. `addFiles()`: client-side guard (ext + size + count) mirroring server caps; append to state; show removable chips below textarea.
4. Drag-drop on composer + `onPaste` (clipboard images) → `addFiles()`. Reuse the slash-menu visual pattern for the chip row.
5. Disable Send only when `streaming` (allow send with attachments + empty text? — decide: require either text or ≥1 file).

### Phase 5 — Client: switch send to FormData (`send()` `ChatPane.tsx:196–250`)
```ts
const fd = new FormData();
fd.append("message", text);
fd.append("model", tier);
attachments.forEach(f => fd.append("files", f, f.name));
const res = await fetch(`/runtime/${encodeURIComponent(threadId)}/chat`, {
  method: "POST",
  headers: { "x-runtime-token": token }, // keep auth header; DO NOT set Content-Type
  body: fd,
});
```
- Keep JSON path when `attachments.length === 0` (smaller payload, full back-compat).
- Clear `attachments` after successful send. Render attachment chips in the user message bubble.

### Phase 6 — Cleanup / lifecycle
- Delete `UPLOADS_ROOT/{threadId}` when a thread is pruned/aged (hook into existing threads prune around `server.mjs:160–162`).
- On server boot, sweep `UPLOADS_ROOT` for dirs older than TTL (e.g. 24h).
- Never store uploads inside `REPO_ROOT` or a sandbox dir.

## 6. Payload contract

**Request (multipart/form-data):**
- `message`: string (still capped — raise text cap to e.g. 8k for richer briefs)
- `model`: `opus|sonnet|haiku` (unchanged, server re-resolves via ADR-022 allowlist)
- `files`: 0..MAX_FILES file parts

**Response:** unchanged — SSE stream-json (token/usage/result events).

## 7. Security (mandatory — file upload is attack surface)

- **Type allowlist** by extension **and** magic-byte sniff; reject executables, archives, SVG (XSS), HTML.
- **Size + count caps** enforced at busboy layer (not after buffering) to stop memory-DoS.
- **No client filename in any path** — generate `f{n}{ext}`; sanitize/escape original name when shown in UI/manifest.
- **Path-traversal guard**: resolve final path and assert it stays under `UPLOADS_ROOT/{threadId}/{msgId}/`.
- **Storage isolation**: `tmpdir()`, mode `0o700`, outside repo + outside sandbox; never committed (add to `.gitignore` if under repo path — it should not be).
- **No filename → shell**: prompt manifest passes paths as data on stdin, never as argv (consistent with existing stdin delivery at `server.mjs:641`).
- **Auth unchanged**: keep `x-runtime-token` header; verify on the multipart branch too.
- **Quota**: attachment turns still pass through the existing inflight/quota guard — no second path.
- Gate review with `senior-security-engineer` before merge (upload + new dep surface).

## 8. Testing

- **Unit:** type/size/count validation; magic-byte mismatch rejection; path-traversal attempt; xlsx→CSV conversion + row truncation.
- **Integration:** multipart POST writes files to `{threadId}/{msgId}`, manifest built, JSON path still works (back-compat).
- **E2E:** attach PNG mockup → agent references it; attach PDF → agent summarizes; attach xlsx → agent reads converted CSV; oversize file → `413`; bad type → `415`.
- **Cleanup:** thread prune removes upload dir; boot sweep removes stale dirs.
- Keep existing suite green (memory shows 169/169 — must stay green).

## 9. Stretch (optional, same PR or follow-up)

- Side panel surfacing **connectors/plugins** (read from `mcp-registry.mjs` grants) + the "/" palette catalog — gives full "same as here" parity.
- Image thumbnails in message history.
- Per-agent attachment policy (e.g. CEO accepts files; posting agents do not).

## 10. Risks / open questions

- **xlsx fidelity:** complex workbooks (formulas, multi-sheet) flatten imperfectly to CSV. Decision: convert per-sheet, label sheets, cap rows; document the limitation.
- **Prompt bloat:** large CSV/text can blow the prompt. Mitigate with row/char caps + truncation notice.
- **Tools mode on chat threads:** confirm chat path always allows `Read`; if a `TOOLS=none` thread exists, decide whether attachment turns temporarily enable `Read`.
- **Backend split:** plan targets the **CLI backend** (`BACKEND=cli`, `cliReply`). The SDK/API backend (`handleChat` else-branch) would pass files as proper content blocks instead — out of scope for v1; note for follow-up.
- **Engine/autonomous path** (`server.mjs:772`) intentionally excluded from v1.

## 11. Definition of done

- BOSS can attach image/PDF/xlsx/csv/txt in `ChatPane`, send, and the agent demonstrably reads them.
- All security checks enforced; oversize/bad-type rejected with clear errors.
- JSON (no-attachment) path unchanged; full suite green.
- Upload dirs auto-cleaned; nothing written to repo/sandbox.
- Promote this plan to **ADR-049-multimodal-input** and link from `docs/BUILD-PLAN.md`.
