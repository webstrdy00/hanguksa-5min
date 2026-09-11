import { describe, expect, it } from 'vitest';
import config from '../apps-in-toss.config.ts';

/**
 * 하드게이트 P0: 콘솔 appName 과 apps-in-toss.config.ts appName 이 일치해야 한다.
 * 콘솔 등록값은 사람이 확인하고, 여기서는 코드 쪽 값이 플랫폼 제약을 지키는지 확인한다.
 * backend 의 APP_NAME 과의 일치는 `pnpm check:app-name` 이 검사한다.
 */
describe('apps-in-toss.config', () => {
  it('appName 이 서브도메인으로 쓸 수 있는 형식이다', () => {
    expect(config.appName).toMatch(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);
  });

  it('webBundleDir 이 SDK 3.x 규격(dist)으로 설정돼 있다', () => {
    expect(config.webBundleDir).toBe('dist');
  });

  it('brand 에 primaryColor 가 있다', () => {
    expect(config.brand?.primaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('V1 에서 요청하는 네이티브 권한이 없다', () => {
    // 카메라/위치 등 추가 권한은 MVP 범위 밖이다. 필요해지면 문서 근거와 함께 추가한다.
    expect(config.permissions).toEqual([]);
  });
});
