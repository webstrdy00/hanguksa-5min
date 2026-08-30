# 한능검 5분

시험일까지 하루 5분, 5문제로 취약 시대를 반복 학습하는 **비공식** 학습 보조 미니앱 (Apps in Toss).

> 국사편찬위원회 공식 서비스가 아닙니다. 비공식 학습 보조 서비스입니다.

- 제품 요구사항의 기준은 `/docs` v1.3 FINAL 문서입니다.
- 개발 규칙과 문서 우선순위는 [`AGENTS.md`](./AGENTS.md)에 정리돼 있습니다.
- 현재 단계: **0단계(기반 구축) 완료**. 비즈니스 기능은 아직 구현하지 않았습니다.

## 구성

| 경로              | 내용                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| `frontend/`       | 앱인토스 WebView 클라이언트 (React 18 + TypeScript + Vite + TDS, SDK 3.x) |
| `backend/`        | 학습 API 서버 (Node 24 + Fastify + PostgreSQL + Drizzle)                 |
| `docs/`           | 제품/기술 기획 문서 (v1.3 FINAL, 로컬 보관)                              |
| `scripts/`        | 저장소 검사 스크립트                                                     |
| `.github/workflows/` | CI 파이프라인                                                         |

## 요구 사항

- Node.js **24 이상**
- pnpm **10.10.0** (`packageManager` 필드에 고정)
- Docker (로컬 PostgreSQL)

## 처음 실행하기

```bash
# 1. 의존성 설치
pnpm install

# 2. 환경변수 준비
cp .env.example .env                      # docker compose 용 (POSTGRES_PASSWORD 를 채운다)
cp backend/.env.example backend/.env      # 서버 용 (DATABASE_URL 을 채운다)
cp frontend/.env.example frontend/.env.local

# 3. 로컬 DB 기동 + 마이그레이션
pnpm db:up
pnpm db:migrate

# 4. 개발 서버
pnpm dev:backend     # http://localhost:8080
pnpm dev:frontend    # http://localhost:5173
```

`backend/.env` 의 `DATABASE_URL` 은 `.env` 에 넣은 값과 맞춰야 합니다.

```
postgres://{POSTGRES_USER}:{POSTGRES_PASSWORD}@127.0.0.1:{POSTGRES_PORT}/{POSTGRES_DB}
```

로컬 PostgreSQL 이 이미 5432 를 쓰고 있는 경우가 많아 기본 포트를 **5433** 으로 둡니다.

## 명령어

### 실행

| 명령어              | 설명                                        |
| ------------------- | ------------------------------------------- |
| `pnpm dev:backend`  | API 서버 (파일 변경 시 자동 재시작)          |
| `pnpm dev:frontend` | 미니앱 개발 서버                             |
| `pnpm build`        | 전체 빌드 (frontend 는 `.ait` 번들까지 생성) |
| `pnpm db:up`        | 로컬 PostgreSQL 컨테이너 기동                |
| `pnpm db:down`      | 로컬 PostgreSQL 컨테이너 정리                |

### 검사

| 명령어               | 설명                                                     |
| -------------------- | -------------------------------------------------------- |
| `pnpm test`          | 단위 테스트 (DB 불필요)                                    |
| `pnpm test:db`       | DB 제약 통합 테스트 (실제 PostgreSQL 필요)                  |
| `pnpm typecheck`     | TypeScript 타입 검사                                      |
| `pnpm lint`          | ESLint                                                    |
| `pnpm format`        | Prettier 적용                                             |
| `pnpm format:check`  | Prettier 검사                                             |
| `pnpm check:app-name`| appName 이 config/env/CORS 에서 일치하는지 검사            |
| `pnpm check:secrets` | secretlint 로 하드코딩된 secret 검사                       |
| `pnpm verify`        | 위 검사를 CI 와 같은 순서로 한 번에 실행                    |

패키지 하나만 대상으로 하려면 `pnpm --filter @hanguksa/backend test` 처럼 실행합니다.

### DB

| 명령어             | 설명                                                    |
| ------------------ | ------------------------------------------------------- |
| `pnpm db:generate` | 스키마 변경으로부터 migration SQL 생성                   |
| `pnpm db:migrate`  | migration 적용 (앞으로 이동만)                           |
| `pnpm db:seed`     | 개발용 seed 투입 (`APP_ENV=dev` 에서만 실행)              |

- 스키마 변경은 **반드시 migration 파일**로 남기고 커밋합니다. `drizzle-kit push` 는 쓰지 않습니다.
- 파괴적 변경은 **expand → migrate → contract** 2단계로 나눠 배포합니다.
- CI 가 "스키마와 migration 파일이 어긋나는지"를 검사합니다.
- `0001_invariants.sql` 은 Drizzle 스키마로 표현할 수 없는 트리거/식 인덱스를 담은 수기 migration 입니다.
  문항 revision immutable, 답안 수정 금지, 세션 5문항 고정이 여기서 강제됩니다.
- seed 문항은 `draft` 상태로만 들어가고 본문에 `[DEV SEED]` 가 붙습니다. 출제되지 않습니다.

## 환경 분리

`APP_ENV` 로 `dev` / `staging` / `production` 을 구분합니다.

- secret 은 저장소에 두지 않습니다. 로컬은 `.env`, staging/production 은 Secret Manager 를 씁니다.
- `.env*` 는 `.env.example` 을 빼고 모두 git 에서 제외됩니다.
- `VITE_` 접두사 값은 **번들에 그대로 포함**됩니다. 여기에 secret 을 넣지 않습니다.

## 인증

앱인토스 anonKey 를 일반 API 의 영구 인증수단으로 쓰지 않습니다.

```
SDK User.getAnonymousKey()
  -> POST /v1/auth/bootstrap   (anonKey 는 여기서만 받는다)
  -> 내부 access token (JWT HS256, 30분)
  -> 이후 모든 API 는 Authorization: Bearer <token>
```

- 토큰은 **메모리에만** 보관합니다. refresh token 은 없고, 만료되면 bootstrap 을 다시 합니다.
- 처음 보는 식별키만 앱인토스 검증 API 를 호출합니다(앱당 분당 3,000회 한도).
- anonKey 원문은 저장하지 않습니다. 조회는 HMAC fingerprint 로만 합니다.

### 운영 환경 전환 체크리스트

`IDENTITY_PROVIDER=mock` 은 개발 전용입니다. 운영에서는 서버가 기동하지 않습니다.

1. 앱인토스 콘솔에서 mTLS 인증서 발급
2. `AIT_MTLS_CERT_PATH` / `AIT_MTLS_KEY_PATH` 를 Secret Manager 로 주입
3. `IDENTITY_PROVIDER=toss` 로 전환
4. **Outbound 방화벽 허용**: `117.52.3.192`, `211.115.96.192`, `106.249.5.192` (443)
5. 인증서 만료 모니터링과 회전 책임자 지정 (인증서를 2개 이상 등록하면 무중단 교체 가능)

## 관리자 API

사용자 API 와 **인증 경계가 분리**돼 있습니다 (공통 04 §2).

| 구분 | 사용자 | 관리자 |
| --- | --- | --- |
| 경로 | `/v1/*` | `/admin/v1/*` |
| 서명 키 | `INTERNAL_TOKEN_SECRET` | `ADMIN_TOKEN_SECRET` (다른 값 강제) |
| 발급 | `POST /v1/auth/bootstrap` | CLI |
| 수명 | 30분 | 12시간 |

서로의 토큰은 교차 사용할 수 없습니다. 관리자 로그인 화면은 만들지 않습니다.

```bash
# 관리자 토큰 발급 (admin_users 에 등록된 이메일 기준)
pnpm --filter @hanguksa/backend admin:token dev-reviewer@example.test
```

- 역할: `reviewer`(읽기) / `editor`, `admin`(쓰기)
- 모든 관리자 쓰기는 `admin_audit_logs` 와 `exam_schedule_audits` 에 기록됩니다.
- `ADMIN_IP_ALLOWLIST` 를 설정하면 해당 IP 에서만 관리자 API 가 열립니다.

## 앱인토스 플랫폼

- 설정 파일은 `frontend/apps-in-toss.config.ts` 입니다 (SDK 3.x). `granite.config.ts` 는 쓰지 않습니다.
- `appName` 은 콘솔 등록 후 **수정할 수 없고**, 서버 CORS 허용 목록의 원본입니다.
  - `https://<appName>.web.tossmini.com` (실서비스)
  - `https://<appName>.private-web.tossmini.com` (콘솔 QR 테스트)
- `appName` 은 **`hanguksa5min` 으로 확정**했습니다(2026-08-29). 콘솔 등록 후에는 변경할 수 없습니다.
- 딥링크 `intoss://hanguksa5min`, 서비스 URL `https://hanguksa5min.web.tossmini.com`, mTLS 인증서 CN 이 모두 이 값을 따릅니다.
- 한글 서비스명(앱 이름)은 콘솔에서 나중에 변경할 수 있으므로 상표 확인과 분리해 진행합니다.
- `pnpm build` 는 `vite build && ait build` 를 실행해 `.ait` 번들을 만듭니다.

## 기여 규칙

- 커밋 메시지: `common/commit_rule` (`FEAT|FIX|DOCS|STYLE|REFACTOR|TEST|CHORE: 제목`)
- PR 템플릿: `common/merge_rule`
- 코드를 쓰기 전에 `AGENTS.md` 를 읽습니다. 문서에 없는 정책은 임의로 정하지 않습니다.
