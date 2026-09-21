import { defineConfig } from '@apps-in-toss/web-framework/config';

/**
 * 앱인토스 플랫폼 설정 (SDK 3.x).
 *
 * appName 은 다음 세 곳에 동시에 쓰인다.
 *   딥링크 스킴   intoss://hanguksa5min
 *   서비스 URL    https://hanguksa5min.apps.tossmini.com
 *   mTLS 인증서   인증서 CN 이 appName 기준으로 발급된다
 *
 * ⚠ 콘솔에 등록하면 **영원히 바꿀 수 없다**.
 *    한글 서비스명(앱 이름)은 별도 항목이고 나중에 변경할 수 있다.
 *    그래서 상표 확인이 끝나지 않아도 appName 은 먼저 확정할 수 있다 (09 §4).
 *
 * appName 은 CORS Origin 허용 목록의 원본이기도 하다.
 *   https://<appName>.apps.tossmini.com          실서비스
 *   https://<appName>.private-apps.tossmini.com  콘솔 QR 테스트
 *   https://<appName>.web.tossmini.com          SDK 3.x
 *   https://<appName>.private-web.tossmini.com  SDK 3.x QR 실기기 확인
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
