import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsScreenNotice, UnofficialNotice } from './common.tsx';

/**
 * E2E P0-6 (08 §5, 09 §4, 하드게이트 P0):
 * "공식 서비스 오인 방지 문구가 첫 화면/앱 정보에 표시"
 *
 * 이 문구가 사라지면 출시 게이트를 통과할 수 없다.
 * 문구를 지우거나 바꾸면 이 테스트가 깨지도록 고정한다.
 */
afterEach(() => {
  cleanup();
});

describe('비공식 학습 보조 고지 (09 §4)', () => {
  it('국사편찬위원회 공식 서비스가 아님을 명시한다', () => {
    render(<UnofficialNotice />);

    const notice = screen.getByText(/국사편찬위원회 공식 서비스가 아닌 비공식 학습 보조 서비스/);
    expect(notice).toBeTruthy();
  });

  it('compact 모드에서도 같은 문구를 유지한다', () => {
    render(<UnofficialNotice compact />);

    expect(
      screen.getByText(/국사편찬위원회 공식 서비스가 아닌 비공식 학습 보조 서비스/),
    ).toBeTruthy();
  });

  it('공식 기관을 사칭하는 표현을 쓰지 않는다', () => {
    const { container } = render(<UnofficialNotice />);
    const text = container.textContent ?? '';

    // 09 §4: 공식 로고/브랜딩 모방 금지
    expect(text).not.toMatch(/공식 서비스입니다|공식 앱|주관|시행기관/);
  });
});

describe('금지 표현 (07 §7)', () => {
  it('불안 자극이나 합격 보장 문구를 쓰지 않는다', () => {
    const { container } = render(<SettingsScreenNotice />);
    const text = container.textContent ?? '';

    // 07 §7: 불안 자극("오늘 안 하면 떨어져요"), 합격 보장, 근거 없는 확률 금지
    expect(text).not.toMatch(/떨어져|합격 보장|합격률|합격 확률|보장해/);
  });

  it('서비스 정보에 비공식 표기와 문의 경로가 함께 있다', () => {
    render(<SettingsScreenNotice />);

    expect(screen.getByText(/비공식 학습 보조 서비스/)).toBeTruthy();
    expect(screen.getByText(/공식 홈페이지에서 확인/)).toBeTruthy();
  });
});
