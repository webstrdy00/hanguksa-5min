import { defineConfig } from '@apps-in-toss/web-framework/config';

/**
 * 앱인토스 플랫폼 설정 (SDK 3.x).
 *
 * ⚠ appName 은 콘솔 등록 후 수정할 수 없다. 지금 값은 작업명 기준 임시값이다.
 *    공개 출시 전에 상표/서비스명 충돌을 확인하고 확정한다 (09 §4).
 *
 * appName 은 CORS Origin 허용 목록의 원본이기도 하다.
 *   https://<appName>.web.tossmini.com          실서비스
 *   https://<appName>.private-web.tossmini.com  콘솔 QR 테스트
 * backend 의 APP_NAME 환경변수와 반드시 같아야 하며, `pnpm check:app-name` 이 이를 검사한다.
 */
export default defineConfig({
  appName: 'hanguksa5min',
  brand: {
    primaryColor: '#3182F6',
  },
  permissions: [],
  webBundleDir: 'dist',
});
