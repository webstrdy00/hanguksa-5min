# @hanguksa/frontend

한능검 5분 미니앱의 앱인토스 WebView 클라이언트입니다.

실행 방법과 개발 규칙은 저장소 루트의 [README.md](../README.md)와 `AGENTS.md`를 따릅니다.

## 이 패키지에서만 쓰는 명령어

```bash
pnpm --filter @hanguksa/frontend dev      # 개발 서버
pnpm --filter @hanguksa/frontend build    # vite build && ait build (.ait 번들 생성)
pnpm --filter @hanguksa/frontend deploy   # 콘솔 업로드 (콘솔 API 키 필요)
```

## 플랫폼 설정

- `apps-in-toss.config.ts` 가 플랫폼 설정 파일입니다(SDK 3.x). `granite.config.ts` 는 사용하지 않습니다.
- `appName` 은 콘솔 등록 후 수정할 수 없고, CORS Origin 허용 목록의 원본입니다.
  값은 `hanguksa5min` 으로 확정했습니다. 콘솔 등록 후에는 변경할 수 없습니다.
- 배포 API 키는 [앱인토스 콘솔](https://apps-in-toss.toss.im/) > 워크스페이스 > API 키에서 발급합니다.
  키는 저장소에 커밋하지 않습니다.

## 참고

- [앱인토스 개발자센터](https://developers-apps-in-toss.toss.im/)
- [앱인토스 콘솔](https://apps-in-toss.toss.im/)
