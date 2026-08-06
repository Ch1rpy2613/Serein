/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Web Push VAPID 公钥（构建期注入，公钥可公开） */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Navigator {
  setAppBadge?(contents?: number): Promise<void>;
  clearAppBadge?(): Promise<void>;
  standalone?: boolean;
}
