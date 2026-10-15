/// <reference types="vite/client" />

interface ViteTypeOptions {
  // `import.meta.env` knows only the variables declared below: a typo is a type error, not `any`.
  strictImportMetaEnv: unknown;
}

/** Build-time variables read through `import.meta.env` (see `.env.example`). */
interface ImportMetaEnv {
  /** WebSocket endpoint of the mock server; defaults to `ws://localhost:8787/ws`. */
  readonly VITE_STREAM_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
