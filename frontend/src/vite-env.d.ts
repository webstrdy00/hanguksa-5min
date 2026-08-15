/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** backend API base URL. secret 이 아닌 값만 VITE_ 로 노출한다. */
  readonly VITE_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
