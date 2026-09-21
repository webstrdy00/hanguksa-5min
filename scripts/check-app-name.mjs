#!/usr/bin/env node
/**
 * appName 일관성 검사.
 *
 * 근거:
 * - 00_공개출시_하드게이트_체크리스트_v1.3: "콘솔 appName과 apps-in-toss.config.ts appName 일치" (P0)
 * - SDK 3.x 마이그레이션 문서: CORS Origin 허용 목록이 appName에서 파생된다.
 *     https://<appName>.apps.tossmini.com          (실서비스)
 *     https://<appName>.private-apps.tossmini.com  (콘솔 QR 테스트)
 *     https://<appName>.web.tossmini.com          (SDK 3.x)
 *     https://<appName>.private-web.tossmini.com  (SDK 3.x QR)
 *
 * 코드상의 단일 원본은 frontend/apps-in-toss.config.ts 의 appName 리터럴이다.
 * backend는 같은 값을 APP_NAME 환경변수로 받아 CORS allowlist를 만든다.
 * 이 스크립트는 둘이 어긋나는 것을 CI에서 잡는다.
 *
 * 콘솔 등록값과의 일치는 사람이 확인한다(자동화 불가).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** appName은 서브도메인으로 쓰이므로 DNS label 규칙을 만족해야 한다. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function fail(message) {
  console.error(`✖ appName 검사 실패: ${message}`);
  process.exit(1);
}

function readAppNameFromConfig() {
  const configPath = path.join(repoRoot, 'frontend', 'apps-in-toss.config.ts');
  const source = readFileSync(configPath, 'utf8');
  const match = source.match(/appName:\s*['"]([^'"]+)['"]/);
  if (match?.[1] == null) {
    fail(`frontend/apps-in-toss.config.ts 에서 appName 리터럴을 찾지 못했습니다.`);
  }
  return match[1];
}

function readAppNameFromEnvExample() {
  const envPath = path.join(repoRoot, 'backend', '.env.example');
  const source = readFileSync(envPath, 'utf8');
  const match = source.match(/^APP_NAME=(.*)$/m);
  if (match?.[1] == null) {
    fail('backend/.env.example 에 APP_NAME 항목이 없습니다.');
  }
  return match[1].trim();
}

const configAppName = readAppNameFromConfig();
const envExampleAppName = readAppNameFromEnvExample();

if (!DNS_LABEL.test(configAppName)) {
  fail(
    `appName "${configAppName}" 은 서브도메인으로 쓸 수 없습니다. ` +
      '소문자/숫자/하이픈만 사용하고 하이픈으로 시작하거나 끝나면 안 됩니다.',
  );
}

if (configAppName !== envExampleAppName) {
  fail(
    `frontend/apps-in-toss.config.ts(appName="${configAppName}")와 ` +
      `backend/.env.example(APP_NAME="${envExampleAppName}")이 다릅니다. ` +
      'CORS allowlist가 어긋나 실기기에서 API 요청이 차단됩니다.',
  );
}

const runtimeAppName = process.env.APP_NAME;
if (runtimeAppName != null && runtimeAppName !== configAppName) {
  fail(
    `환경변수 APP_NAME="${runtimeAppName}" 이 apps-in-toss.config.ts appName="${configAppName}" 과 다릅니다.`,
  );
}

console.log(`✔ appName = "${configAppName}"`);
console.log('  파생 CORS origin:');
console.log(`    https://${configAppName}.apps.tossmini.com`);
console.log(`    https://${configAppName}.private-apps.tossmini.com`);
console.log(`    https://${configAppName}.web.tossmini.com`);
console.log(`    https://${configAppName}.private-web.tossmini.com`);
console.log('  ⚠ 앱인토스 콘솔 등록값과의 일치는 사람이 직접 확인해야 합니다(등록 후 수정 불가).');
