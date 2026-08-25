/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** backend API base URL. secret 이 아닌 값만 VITE_ 로 노출한다. */
  readonly VITE_API_BASE_URL: string;
  /** 콘솔 스마트발송 템플릿 코드. 미등록 상태면 비어 있고 알림 동의를 띄우지 않는다. */
  readonly VITE_NOTIFICATION_TEMPLATE_CODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
