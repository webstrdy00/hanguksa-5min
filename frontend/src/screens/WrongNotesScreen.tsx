import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMarkReviewed, useWrongNotes } from '../api/hooks.ts';
import { ERA_LABELS, type WrongNoteItem } from '../api/types.ts';
import {
  ActionButton,
  AsyncBoundary,
  EmptyState,
  ErrorState,
  MIN_TOUCH_SIZE,
  Screen,
  Section,
  StatusTag,
} from '../components/common.tsx';

/**
 * 오답노트 (02 UX §3, 03 §3).
 *
 * 미복습 / 복습완료 탭과 시대 필터를 제공한다.
 * 사용자가 실제로 푼 revision 이 그대로 보인다. 문항이 수정돼도 그때 본 내용이다 (09 §2).
 */

type Tab = 'unreviewed' | 'reviewed' | 'all';

const TABS: { value: Tab; label: string }[] = [
  { value: 'unreviewed', label: '미복습' },
  { value: 'reviewed', label: '복습완료' },
  { value: 'all', label: '전체' },
];

export function WrongNotesScreen(): JSX.Element {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('unreviewed');
  const [era, setEra] = useState<string | null>(null);
  const notes = useWrongNotes(tab, era, true);

  return (
    <Screen>
      <Section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 20 }}>
          <button
            type="button"
            onClick={() => void navigate(-1)}
            aria-label="뒤로 가기"
            style={{
              minWidth: MIN_TOUCH_SIZE,
              minHeight: MIN_TOUCH_SIZE,
              border: 'none',
              background: 'none',
              fontSize: 20,
              cursor: 'pointer',
            }}
          >
            ←
          </button>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>오답노트</h1>
        </div>

        <div
          role="tablist"
          aria-label="복습 상태"
          style={{ display: 'flex', gap: 8, marginTop: 16 }}
        >
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              onClick={() => setTab(item.value)}
              style={{
                minHeight: MIN_TOUCH_SIZE,
                padding: '0 16px',
                borderRadius: 999,
                border: `1px solid ${tab === item.value ? '#3182f6' : '#e5e8eb'}`,
                background: tab === item.value ? '#f0f6ff' : '#fff',
                color: tab === item.value ? '#1b64da' : '#4e5968',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div
          style={{ display: 'flex', gap: 6, marginTop: 12, overflowX: 'auto', paddingBottom: 4 }}
        >
          <FilterChip label="전체 시대" active={era == null} onClick={() => setEra(null)} />
          {Object.entries(ERA_LABELS).map(([code, label]) => (
            <FilterChip
              key={code}
              label={label}
              active={era === code}
              onClick={() => setEra(code)}
            />
          ))}
        </div>
      </Section>

      <AsyncBoundary
        query={notes}
        loadingLabel="오답을 불러오고 있어요"
        empty={(data) =>
          data.items.length === 0 ? (
            <EmptyState
              title={tab === 'reviewed' ? '복습한 문항이 아직 없어요' : '틀린 문항이 없어요'}
              description={
                tab === 'reviewed'
                  ? '오답을 다시 확인하면 여기에 쌓여요.'
                  : '오늘 5문제를 풀면 틀린 문항이 여기 모여요.'
              }
              action={
                <ActionButton onClick={() => void navigate('/study')}>문제 풀러 가기</ActionButton>
              }
            />
          ) : null
        }
      >
        {(data) => (
          <Section>
            <p style={{ color: '#6b7684', fontSize: 13, margin: '16px 0 8px' }}>
              {data.total}개 문항
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {data.items.map((item) => (
                <WrongNoteCard key={item.canonicalQuestionId} item={item} />
              ))}
            </ul>
          </Section>
        )}
      </AsyncBoundary>
    </Screen>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        flexShrink: 0,
        minHeight: 36,
        padding: '0 12px',
        borderRadius: 999,
        border: `1px solid ${active ? '#3182f6' : '#e5e8eb'}`,
        background: active ? '#f0f6ff' : '#fff',
        color: active ? '#1b64da' : '#6b7684',
        fontSize: 13,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function WrongNoteCard({ item }: { item: WrongNoteItem }): JSX.Element {
  const [open, setOpen] = useState(false);
  const markReviewed = useMarkReviewed();

  return (
    <li
      style={{
        padding: 16,
        marginBottom: 10,
        borderRadius: 14,
        border: '1px solid #e5e8eb',
      }}
    >
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <StatusTag tone="neutral">{ERA_LABELS[item.era] ?? item.era}</StatusTag>
        {item.reviewed ? (
          <StatusTag tone="correct">복습완료</StatusTag>
        ) : (
          <StatusTag tone="warning">미복습</StatusTag>
        )}
        {item.retired && <StatusTag tone="neutral">출제 중단</StatusTag>}
      </div>

      <p style={{ margin: '0 0 12px', fontSize: 15, lineHeight: 1.5, wordBreak: 'keep-all' }}>
        {item.prompt}
      </p>

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{
          minHeight: MIN_TOUCH_SIZE,
          width: '100%',
          borderRadius: 10,
          border: '1px solid #e5e8eb',
          background: '#fff',
          color: '#4e5968',
          fontSize: 14,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {open ? '해설 접기' : '해설 보기'}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <ol style={{ margin: '0 0 12px', paddingLeft: 20 }}>
            {item.choices.map((choice, index) => (
              <li
                key={`${item.canonicalQuestionId}-${index}`}
                style={{
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: index === item.correctIndex ? '#1b64da' : '#4e5968',
                  fontWeight: index === item.correctIndex ? 700 : 400,
                }}
              >
                {choice}
                {index === item.correctIndex && ' (정답)'}
                {index === item.selectedIndex && index !== item.correctIndex && ' (내 선택)'}
              </li>
            ))}
          </ol>
          <p
            style={{
              margin: 0,
              padding: 12,
              borderRadius: 10,
              background: '#f9fafb',
              fontSize: 14,
              lineHeight: 1.6,
              wordBreak: 'keep-all',
            }}
          >
            {item.explanation}
          </p>

          {markReviewed.isError && <ErrorState error={markReviewed.error} />}

          {!item.reviewed && (
            <div style={{ marginTop: 12 }}>
              <ActionButton
                variant="secondary"
                onClick={() => markReviewed.mutate(item.canonicalQuestionId)}
                pending={markReviewed.isPending}
                pendingLabel="기록하고 있어요"
              >
                복습 완료로 표시
              </ActionButton>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
