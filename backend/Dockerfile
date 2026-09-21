# 한능검 5분 백엔드 (Node 24 + Fastify)
#
# 이 서버가 만족해야 하는 조건 (AGENTS.md §9 #1, 공통 06 §2):
#  - 상주 프로세스: DB 커넥션 풀과 재계산 배치가 필요하다. 서버리스로는 안 된다.
#  - mTLS 클라이언트 인증서를 **파일로** 읽는다 (AIT_MTLS_CERT_PATH/KEY_PATH).
#    호스팅의 Secret 파일 마운트를 그대로 쓸 수 있게 경로 기반을 유지한다.
#  - 이미지에 인증서와 secret 을 굽지 않는다. 런타임 주입만 허용한다.

# ---------- build ----------
FROM node:24-alpine AS build
WORKDIR /app

RUN corepack enable

# 의존성 레이어를 먼저 고정해 소스 변경 시 재설치를 피한다.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY backend/package.json backend/
RUN pnpm install --frozen-lockfile --filter @hanguksa/backend...

COPY backend/ backend/
RUN pnpm --filter @hanguksa/backend build

# 운영 의존성만 남긴다.
RUN pnpm install --frozen-lockfile --prod --filter @hanguksa/backend...

# ---------- runtime ----------
FROM node:24-alpine AS runtime
WORKDIR /app

# 마이그레이션은 TypeScript 소스를 직접 실행한다(Node 24 네이티브 TS).
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/backend/src ./backend/src
COPY --from=build /app/backend/migrations ./backend/migrations
COPY --from=build /app/backend/journal-migrations ./backend/journal-migrations
COPY --from=build /app/backend/package.json ./backend/package.json

WORKDIR /app/backend

# root 로 돌리지 않는다.
USER node

EXPOSE 8080

# 컨테이너 오케스트레이터가 상태를 판단할 수 있게 한다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 기동 시 migration 을 먼저 적용한다. 실패하면 서버를 띄우지 않는다.
CMD ["sh", "-c", "node --env-file-if-exists=.env src/db/migrate.ts && node dist/index.js"]
