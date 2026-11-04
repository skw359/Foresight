/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Foresight backend. Default: http://localhost:3199 */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
