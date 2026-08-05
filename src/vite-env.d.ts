/// <reference types="vite/client" />

// Typed build-time flags. Vite inlines these at build, so an unset flag is
// `undefined` and every consumer must treat that as the default.
interface ImportMetaEnv {
  /**
   * P3 Inbox feature flag (program plan §5.1). Unset ⇒ ON. "0" or "false" ⇒ the
   * pre-P3 cockpit renders unchanged and the Inbox chunk is never fetched.
   */
  readonly VITE_INBOX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
