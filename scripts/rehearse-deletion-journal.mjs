import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// LOCAL TEST ONLY: independent databases in one disposable PostgreSQL instance.
// Production requires distinct projects and an independently retained journal.
// Do not inherit application configuration, URLs, webhooks, NODE_OPTIONS or secrets.
const env = {};
for (const key of [
  'PATH',
  'Path',
  'SystemRoot',
  'WINDIR',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
const secret = () => randomBytes(32).toString('hex');
const password = secret();
const journalId = randomUUID();
const oldId = randomUUID();
const newId = randomUUID();
const backend = fileURLToPath(new URL('../backend/', import.meta.url));
const name = `hanguksa-journal-check-${randomBytes(6).toString('hex')}`;
Object.assign(env, {
  POSTGRES_PASSWORD: password,
  NODE_ENV: 'development',
  APP_ENV: 'dev',
  APP_NAME: 'hanguksa5min',
  IDENTITY_PROVIDER: 'mock',
  LOG_LEVEL: 'silent',
  SERVER_PEPPER: secret(),
  INTERNAL_TOKEN_SECRET: secret(),
  ADMIN_TOKEN_SECRET: secret(),
  // Overwritten with disposable endpoints before any application code runs.
  DATABASE_URL: 'postgres://invalid@127.0.0.1/never_connect',
  DELETION_JOURNAL_DATABASE_URL: 'postgres://invalid@127.0.0.1/never_connect',
  DELETION_JOURNAL_ID: journalId,
});
delete env.DISCORD_ALERT_WEBHOOK_URL;
const report = {
  status: 'FAIL',
  checkedAt: '',
  engine: 'PostgreSQL 17',
  productionDataUsed: false,
  checks: {},
  assumptions: [
    'Local test only: separate source and journal databases share a disposable container; production requires distinct projects.',
    'Requires Docker, installed backend dependencies, and Node with native TypeScript stripping.',
    'Synthetic SQL fixtures and disposable superuser connections only; not a production least-privilege or backup-retention certification.',
    'Rejoin preservation tests a new UUID with the original mock fingerprint, not the HTTP identity-provider flow.',
  ],
};
let stage = 'containerStartup';
let attemptedContainer = false;
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    env,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  // Child output can contain SQL, UUIDs or connection secrets. Never forward it.
  if (result.error || result.status !== 0) {
    // 고정 진단 코드와 eval 행 번호만 출력한다. SQL/값/원문 stack은 출력하지 않는다.
    const diagnostic =
      (result.stderr ?? '').match(/REHEARSAL_[A-Z0-9_]+/) ??
      (result.stderr ?? '').match(/ERR_[A-Z_]+|DEPENDENCY_UNAVAILABLE/);
    const line = (result.stderr ?? '').match(/\[eval1\]:(\d+):(\d+)/);
    report.childDiagnostic = {
      code: diagnostic?.[0] ?? 'CHILD_COMMAND_FAILED',
      line: line?.[1] ?? null,
    };
    throw new Error('REHEARSAL_COMMAND_FAILED');
  }
  return result.stdout.trim();
}
function query(database, statement) {
  return command('docker', [
    'exec',
    name,
    'psql',
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    database,
    '-Atc',
    statement,
  ]);
}
function url(database) {
  const endpoint = new URL(env.DATABASE_URL);
  endpoint.pathname = `/${database}`;
  return endpoint.toString();
}
function child(database, source, overrides = {}) {
  return command(process.execPath, ['--input-type=module'], {
    cwd: backend,
    input: source,
    env: { ...env, DATABASE_URL: url(database), ...overrides },
  });
}
function service(database, source, overrides = {}) {
  return child(
    database,
    `
    import assert from 'node:assert/strict';
    import { randomUUID } from 'node:crypto';
    import postgres from 'postgres';
    import { inspect } from 'node:util';
    const stores = [];
    const clients = [];
    let closeDb, closeDeletionJournal;
    try {
      ({ closeDb } = await import('./src/db/client.ts'));
      ({ closeDeletionJournal } = await import('./src/deletion-journal/runtime.ts'));
      const { requestDeletion, replayDeletionJournal, runPendingDeletionJobs } = await import('./src/services/deletion.ts');
      const { createDeletionJournalStore } = await import('./src/deletion-journal/store.ts');
      const connect = (endpoint) => {
        const sql = postgres(endpoint, { max: 1, connect_timeout: 5, onnotice: () => {}, connection: { statement_timeout: 10000 } });
        clients.push(sql); return sql;
      };
      const main = connect(process.env.DATABASE_URL);
      const makeStore = (endpoint = process.env.DELETION_JOURNAL_DATABASE_URL, id = process.env.DELETION_JOURNAL_ID) => {
        const store = createDeletionJournalStore(endpoint, id); stores.push(store); return store;
      };
      const expectUnavailable = async (operation) => {
        await assert.rejects(operation, (error) => {
          assert.match(error.message, /^(DEPENDENCY_UNAVAILABLE|DELETION_JOURNAL_UNAVAILABLE)$/);
          const rendered = inspect(error, { depth: 10 });
          for (const value of [process.env.DATABASE_URL, process.env.DELETION_JOURNAL_DATABASE_URL,
            new URL(process.env.DELETION_JOURNAL_DATABASE_URL).password,
            process.env.SERVER_PEPPER, process.env.INTERNAL_TOKEN_SECRET, process.env.ADMIN_TOKEN_SECRET]) {
            assert.ok(!rendered.includes(value));
          }
          return true;
        });
      };
      ${source}
    } finally {
      const closed = await Promise.allSettled([
        ...stores.map((store) => store.close()), ...clients.map((sql) => sql.end({ timeout: 5 })),
        closeDeletionJournal?.(), closeDb?.(),
      ]);
      assert.ok(closed.every((entry) => entry.status === 'fulfilled'));
    }
  `,
    overrides,
  );
}
function check(label, operation) {
  stage = label;
  operation();
  report.checks[label] = 'PASS';
}
function fixture(database, id, fingerprint = `MOCK-journal-${id}`) {
  query(
    database,
    `insert into users (id, anon_key_fingerprint, target_grade) values ('${id}', '${fingerprint}', 2);
    insert into notification_consents (user_id, functional_agreed, functional_agreed_at) values ('${id}', true, now());`,
  );
}
function absent(database, id) {
  assert.equal(
    query(
      database,
      `select (select count(*) from users where id = '${id}') + (select count(*) from notification_consents where user_id = '${id}')`,
    ),
    '0',
  );
  assert.equal(
    query(
      database,
      `
    select (select count(*) from study_sessions where user_id = '${id}')
      + (select count(*) from user_question_state where user_id = '${id}')
      + (select count(*) from mastery where user_id = '${id}')
      + (select count(*) from idempotency_keys where user_id = '${id}')
      + (select count(*) from question_reports where reporter_user_id = '${id}')
  `,
    ),
    '0',
  );
}
function restore(database) {
  command('docker', ['exec', name, 'createdb', '-U', 'postgres', database]);
  command('docker', [
    'exec',
    name,
    'pg_restore',
    '-U',
    'postgres',
    '-d',
    database,
    '--exit-on-error',
    '/tmp/before_request.dump',
  ]);
}
function migrateJournal(database) {
  command('docker', ['exec', name, 'createdb', '-U', 'postgres', database]);
  child(
    'source',
    `const { migrateJournal } = await import('./src/deletion-journal/maintenance.ts'); await migrateJournal(process.env.DELETION_JOURNAL_DATABASE_URL);`,
    {
      DELETION_JOURNAL_DATABASE_URL: url(database),
    },
  );
}
try {
  attemptedContainer = true;
  command('docker', [
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '-e',
    'POSTGRES_PASSWORD',
    '-e',
    'POSTGRES_DB=source',
    '-p',
    '127.0.0.1::5432',
    'postgres:17-alpine',
  ]);
  for (let attempt = 0; ; attempt++) {
    const ready = spawnSync(
      'docker',
      ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'source'],
      {
        env,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    if (ready.status === 0) break;
    if (attempt >= 30) throw new Error('DISPOSABLE_DATABASE_NOT_READY');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const bindings = JSON.parse(command('docker', ['inspect', name]))[0].NetworkSettings.Ports[
    '5432/tcp'
  ];
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].HostIp, '127.0.0.1');
  env.DATABASE_URL = `postgres://postgres:${password}@127.0.0.1:${bindings[0].HostPort}/source`;
  env.DELETION_JOURNAL_DATABASE_URL = url('journal');
  assert.equal(query('source', "select current_setting('server_version_num')::int / 10000"), '17');
  report.checks.containerStartup = 'PASS';

  check('migrationAdoptionAndSourceOnlySnapshot', () => {
    command(process.execPath, ['src/db/migrate.ts'], { cwd: backend });
    migrateJournal('journal');
    const legacyId = randomUUID();
    fixture('source', legacyId);
    service('source', `await requestDeletion('${legacyId}'); await runPendingDeletionJobs();`, {
      DELETION_JOURNAL_DATABASE_URL: undefined,
      DELETION_JOURNAL_ID: undefined,
    });
    absent('source', legacyId);
    fixture('source', oldId, 'MOCK-journal-rejoin');
    child(
      'source',
      `const { adoptJournal } = await import('./src/deletion-journal/maintenance.ts');
      await adoptJournal(process.env.DATABASE_URL, process.env.DELETION_JOURNAL_DATABASE_URL, process.env.DELETION_JOURNAL_ID);`,
    );
    assert.equal(
      query('source', 'select journal_enforced from deletion_restore_state where id = 1'),
      't',
    );
    assert.equal(
      query(
        'journal',
        `select count(*) from journal_entries where subject_user_id = '${legacyId}'`,
      ),
      '1',
    );
    service(
      'source',
      `
      const { buildApp } = await import('./src/app.ts');
      const { issueAccessToken } = await import('./src/auth/token.ts');
      const { insertAdmin, createQuestionPool } = await import('./src/db/test-helpers.ts');
      const reviewer = await insertAdmin(main);
      await createQuestionPool(main, reviewer, 6);
      await main\`insert into feature_flags (key, enabled, description)
        values ('daily_study', true, 'MOCK'), ('question_report', true, 'MOCK')\`;
      const app = await buildApp();
      try {
        const { token } = await issueAccessToken('${oldId}');
        const post = async (path, payload) => {
          const response = await app.inject({ method: 'POST', url: path,
            headers: { authorization: 'Bearer ' + token, 'idempotency-key': randomUUID() },
            ...(payload === undefined ? {} : { payload }) });
          assert.ok(response.statusCode >= 200 && response.statusCode < 300,
            'REHEARSAL_HTTP_' + response.statusCode + '_' + path.replace(/[^a-z]/gi, '_').toUpperCase());
          return response.json();
        };
        const session = await post('/v1/study/today');
        for (const [index, item] of session.items.entries()) {
          await post('/v1/sessions/' + session.session.id + '/answer', {
            questionRevisionId: item.questionRevisionId, selectedIndex: index === 0 ? 1 : 0,
          });
        }
        await post('/v1/sessions/' + session.session.id + '/complete');
        await post('/v1/questions/' + session.items[0].questionRevisionId + '/report',
          { reason: 'ambiguous', detail: 'MOCK isolated restore report' });
        await main\`insert into idempotency_keys
          (actor_key, user_id, idempotency_key, endpoint, request_hash, state, response_status, expires_at)
          values ('user:${oldId}', '${oldId}', 'MOCK-restore', 'MOCK-restore', 'MOCK',
            'completed', 200, now() + interval '1 day')\`;
        for (const table of ['answers', 'study_sessions', 'study_session_items',
          'user_question_state', 'mastery', 'idempotency_keys', 'question_reports']) {
          const [row] = await main.unsafe('select count(*)::int as count from ' + table);
          assert.ok(row.count > 0, 'REHEARSAL_EMPTY_TABLE_' + table.toUpperCase());
        }
      } finally { await app.close(); }
    `,
    );
    command('docker', [
      'exec',
      name,
      'pg_dump',
      '-U',
      'postgres',
      '-d',
      'source',
      '-Fc',
      '-f',
      '/tmp/before_request.dump',
    ]);
  });
  check('adoptedFenceRejectsLegacyWriterTransaction', () => {
    service(
      'source',
      `await assert.rejects(() => requestDeletion('${oldId}'), (error) => {
      assert.equal(error.cause?.message ?? error.message, 'DELETION_JOURNAL_REQUIRED'); return true;
    });`,
      { DELETION_JOURNAL_DATABASE_URL: undefined, DELETION_JOURNAL_ID: undefined },
    );
    assert.equal(
      query('source', `select identity_status from users where id = '${oldId}'`),
      'active',
    );
    assert.equal(
      query(
        'source',
        `select functional_agreed from notification_consents where user_id = '${oldId}'`,
      ),
      't',
    );
    assert.equal(
      query('source', `select count(*) from deletion_jobs where subject_user_id = '${oldId}'`),
      '0',
    );
  });
  check('acceptedDeletionAndWorker', () => {
    service('source', `await requestDeletion('${oldId}'); await runPendingDeletionJobs();`);
    absent('source', oldId);
    assert.equal(query('journal', 'select count(*) from journal_entries'), '2');
  });
  check('preRequestRestoreIndependentJournal', () => {
    restore('restored');
    assert.equal(query('restored', `select count(*) from users where id = '${oldId}'`), '1');
    assert.equal(
      query(
        'restored',
        `select functional_agreed from notification_consents where user_id = '${oldId}'`,
      ),
      't',
    );
    assert.equal(
      query('restored', `select count(*) from deletion_jobs where subject_user_id = '${oldId}'`),
      '0',
    );
    service('restored', 'await replayDeletionJournal();');
    absent('restored', oldId);
    assert.equal(query('restored', 'select count(*) from answers'), '0');
    assert.equal(query('restored', 'select count(*) from study_session_items'), '0');
    assert.equal(
      query(
        'restored',
        'select count(*) from question_reports where reporter_user_id is not null or detail is not null',
      ),
      '0',
    );
    assert.equal(query('restored', 'select count(*) from question_reports'), '1');
    assert.equal(query('restored', 'select count(*) from question_revisions'), '6');
  });
  check('idempotencyAndRejoinNewUuidPreservation', () => {
    fixture('restored', newId, 'MOCK-journal-rejoin');
    const jobs = query('restored', 'select count(*) from deletion_jobs');
    service(
      'restored',
      'await replayDeletionJournal(); await replayDeletionJournal(); assert.equal(await runPendingDeletionJobs(), 0);',
    );
    absent('restored', oldId);
    assert.equal(query('restored', 'select count(*) from deletion_jobs'), jobs);
    assert.equal(
      query('restored', `select identity_status from users where id = '${newId}'`),
      'active',
    );
    assert.equal(
      query(
        'restored',
        `select functional_agreed from notification_consents where user_id = '${newId}'`,
      ),
      't',
    );
  });
  check('journalOnlyIntentReplay', () => {
    const id = randomUUID();
    fixture('restored', id);
    service(
      'restored',
      `await makeStore().append('${id}', new Date());
      const [before] = await main\`select identity_status from users where id = '${id}'\`;
      assert.equal(before.identity_status, 'active');
      await replayDeletionJournal();`,
    );
    absent('restored', id);
  });
  check('interruptedMainCommitRecovery', () => {
    const id = randomUUID();
    fixture('source', id);
    query(
      'source',
      `create function rehearsal_reject_update() returns trigger language plpgsql as $$ begin raise exception 'REHEARSAL_MAIN_REJECTED'; end $$;
      create trigger rehearsal_reject_update before update on users for each row execute function rehearsal_reject_update();`,
    );
    try {
      service(
        'source',
        `await assert.rejects(() => requestDeletion('${id}'), (error) => {
          assert.equal(error.cause?.message ?? error.message, 'REHEARSAL_MAIN_REJECTED'); return true;
        });
        assert.equal(await makeStore().has('${id}'), true);
        const [user] = await main\`select identity_status from users where id = '${id}'\`;
        assert.equal(user.identity_status, 'active');
        const [jobs] = await main\`select count(*)::int as count from deletion_jobs where subject_user_id = '${id}'\`;
        assert.equal(jobs.count, 0);`,
      );
    } finally {
      query(
        'source',
        'drop trigger rehearsal_reject_update on users; drop function rehearsal_reject_update();',
      );
    }
    service('source', 'await runPendingDeletionJobs(); await replayDeletionJournal();');
    absent('source', id);
  });
  check('unavailableGateAndRequestNoMutationOrSecretLeak', () => {
    const id = randomUUID();
    fixture('source', id);
    service(
      'source',
      `
      const [before] = await main\`select count(*)::int as count from deletion_jobs\`;
      await expectUnavailable(() => replayDeletionJournal());
      await expectUnavailable(() => requestDeletion('${id}'));
      await expectUnavailable(() => makeStore().inspect());
      const [user] = await main\`select identity_status from users where id = '${id}'\`;
      const [consent] = await main\`select functional_agreed from notification_consents where user_id = '${id}'\`;
      const [after] = await main\`select count(*)::int as count from deletion_jobs\`;
      assert.equal(user.identity_status, 'active'); assert.equal(consent.functional_agreed, true);
      assert.equal(after.count, before.count);
    `,
      { DELETION_JOURNAL_DATABASE_URL: url('unavailable_journal') },
    );
  });
  check('wrongUuidGate', () => {
    service('restored', 'await expectUnavailable(() => replayDeletionJournal());', {
      DELETION_JOURNAL_ID: randomUUID(),
    });
  });
  check('missingMetadataGateAndInspect', () => {
    migrateJournal('empty_journal');
    service(
      'restored',
      'await expectUnavailable(() => replayDeletionJournal()); await expectUnavailable(() => makeStore().inspect());',
      {
        DELETION_JOURNAL_DATABASE_URL: url('empty_journal'),
      },
    );
  });
  check('foreignDatasetGate', () => {
    restore('foreign_dataset');
    query(
      'foreign_dataset',
      `update deletion_restore_state set dataset_id = '${randomUUID()}' where id = 1`,
    );
    service('foreign_dataset', 'await expectUnavailable(() => replayDeletionJournal());');
    assert.equal(query('foreign_dataset', `select count(*) from users where id = '${oldId}'`), '1');
  });
  check('replayedOrdinalBeyondLedgerGate', () => {
    restore('ahead_cursor');
    query(
      'ahead_cursor',
      'update deletion_restore_state set replayed_ordinal = 2147483647 where id = 1',
    );
    service('ahead_cursor', 'await expectUnavailable(() => replayDeletionJournal());');
  });
  check('preMarkerBackupGate', () => {
    restore('pre_marker');
    query('pre_marker', 'drop table deletion_restore_state');
    service('pre_marker', 'await expectUnavailable(() => replayDeletionJournal());');
    assert.equal(query('pre_marker', `select count(*) from users where id = '${oldId}'`), '1');
  });
  check('immutableJournalUpdateDeleteTruncate', () => {
    service(
      'source',
      `const ledger = connect(process.env.DELETION_JOURNAL_DATABASE_URL);
      for (const statement of [
        'update journal_entries set requested_at = now()', 'delete from journal_entries',
        'truncate journal_entries', 'delete from journal_metadata', 'truncate journal_metadata',
        'update journal_metadata set journal_id = gen_random_uuid()',
      ]) await assert.rejects(() => ledger.unsafe(statement), /DELETION_JOURNAL_(IMMUTABLE|IDENTITY_IMMUTABLE)/);
      await makeStore().inspect();`,
    );
  });
  check('actualSubjectLockAndCanonicalDuplicateAppend', () => {
    service(
      'source',
      `
      const subject = randomUUID();
      const reader = makeStore(); const writer = makeStore();
      const observer = connect(process.env.DELETION_JOURNAL_DATABASE_URL);
      let release; const released = new Promise((resolve) => { release = resolve; });
      let entered; const started = new Promise((resolve) => { entered = resolve; });
      const protectedWork = reader.withActiveSubject(subject, async () => { entered(); await released; return 'protected'; });
      // Attach immediately so a connection failure cannot become an unhandled rejection.
      protectedWork.catch(() => {});
      let append; let appended = false;
      try {
        await Promise.race([started, protectedWork.then(() => { throw new Error('CALLBACK_NOT_ENTERED'); })]);
        const timestamp = new Date('2026-01-01T00:00:00.000Z');
        append = writer.append(subject, timestamp).then((entry) => { appended = true; return entry; });
        append.catch(() => {});
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const [locks] = await observer\`select exists (
            select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
            where l.locktype = 'advisory' and not l.granted and a.datname = current_database()
          ) as waiting\`;
          if (locks.waiting) { waiting = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(waiting, true, 'Append must actually wait on a database advisory lock');
        assert.equal(appended, false);
        // 사용자 A의 main 작업이 사용자 B의 탈퇴 접수를 막으면 안 된다.
        const unrelatedId = randomUUID();
        const unrelated = await makeStore().append(unrelatedId, new Date());
        assert.equal(unrelated.userId, unrelatedId);
        const [before] = await observer\`select count(*)::int as count from journal_entries where subject_user_id = \${subject}::uuid\`;
        assert.equal(before.count, 0);
        release();
        assert.equal(await protectedWork, 'protected');
        const original = await append;
        const duplicates = await Promise.all([
          reader.append(subject, new Date('2026-02-01T00:00:00.000Z')),
          writer.append(subject.toUpperCase(), new Date('2026-03-01T00:00:00.000Z')),
        ]);
        for (const entry of duplicates) {
          assert.equal(entry.ordinal, original.ordinal);
          assert.equal(entry.requestedAt.getTime(), timestamp.getTime());
        }
        const [count] = await observer\`select count(*)::int as count from journal_entries where subject_user_id = \${subject}::uuid\`;
        assert.equal(count.count, 1);
        let callbackRan = false;
        await assert.rejects(() => reader.withActiveSubject(subject, async () => { callbackRan = true; }), /DELETION_JOURNAL_SUBJECT_DELETED/);
        assert.equal(callbackRan, false);
        await reader.inspect();
      } finally {
        release(); await Promise.allSettled([protectedWork, append]);
      }
    `,
    );
  });
  check('missingHistoryInspectAndGate', () => {
    migrateJournal('missing_history');
    const dataset = query('source', 'select dataset_id from deletion_restore_state where id = 1');
    // Deliberately fabricate an incomplete independent journal as a disposable superuser.
    // No immutable entries or triggers in the authoritative journal are altered.
    query(
      'missing_history',
      `insert into journal_metadata (id, journal_id, dataset_id, initialized, entry_count) values (1, '${journalId}', '${dataset}', true, 1)`,
    );
    service(
      'restored',
      'await expectUnavailable(() => makeStore().inspect()); await expectUnavailable(() => replayDeletionJournal());',
      {
        DELETION_JOURNAL_DATABASE_URL: url('missing_history'),
      },
    );
  });
  check('corruptNonContiguousHistoryInspectAndGate', () => {
    migrateJournal('corrupt_history');
    const dataset = query('source', 'select dataset_id from deletion_restore_state where id = 1');
    query(
      'corrupt_history',
      `insert into journal_metadata (id, journal_id, dataset_id, initialized, entry_count) values (1, '${journalId}', '${dataset}', true, 1);
      insert into journal_entries (subject_user_id, requested_at, ordinal) values ('${randomUUID()}', now(), 2)`,
    );
    service(
      'restored',
      'await expectUnavailable(() => makeStore().inspect()); await expectUnavailable(() => replayDeletionJournal());',
      {
        DELETION_JOURNAL_DATABASE_URL: url('corrupt_history'),
      },
    );
  });
  check('realStartupFailsClosedAndReplaysBeforeListen', () => {
    restore('startup_restore');
    service(
      'startup_restore',
      `
      const { spawn } = await import('node:child_process');
      const { createServer } = await import('node:net');
      const reserve = createServer();
      await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
      const port = reserve.address().port;
      await new Promise((resolve, reject) => reserve.close((error) => error ? reject(error) : resolve()));
      const boot = (id, shouldStart) => new Promise((resolve, reject) => {
        let started = false;
        const child = spawn(process.execPath, ['src/index.ts'], {
          env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
            LOG_LEVEL: 'info', DELETION_JOURNAL_ID: id }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('STARTUP_TIMEOUT')); }, 30000);
        child.stdout.on('data', (chunk) => {
          if (chunk.toString().includes('server_started')) { started = true; child.kill('SIGTERM'); }
        });
        child.stderr.on('data', () => {});
        child.on('error', () => { clearTimeout(timer); reject(new Error('STARTUP_SPAWN_FAILED')); });
        child.on('exit', (code, signal) => {
          clearTimeout(timer);
          try {
            assert.equal(started, shouldStart);
            if (shouldStart) assert.ok(code === 0 || (process.platform === 'win32' && signal === 'SIGTERM'));
            else assert.equal(code, 1);
            resolve();
          }
          catch (error) { reject(error); }
        });
      });
      await boot(randomUUID(), false);
      const [before] = await main\`select count(*)::int as count from users where id = '${oldId}'\`;
      assert.equal(before.count, 1);
      await boot(process.env.DELETION_JOURNAL_ID, true);
    `,
    );
    absent('startup_restore', oldId);
  });
  check('finalReplayAndNewUuidStillActive', () => {
    service('restored', 'await replayDeletionJournal(); await replayDeletionJournal();');
    absent('restored', oldId);
    assert.equal(
      query('restored', `select identity_status from users where id = '${newId}'`),
      'active',
    );
    assert.equal(
      query(
        'restored',
        `select functional_agreed from notification_consents where user_id = '${newId}'`,
      ),
      't',
    );
  });
  report.status = 'PASS';
} catch {
  report.checks[stage] = 'FAIL';
  // No exception text: driver/child failures can include secrets or subject identifiers.
  report.failure =
    'A rehearsal assertion or disposable command failed; inspect the named check locally.';
  process.exitCode = 1;
} finally {
  if (attemptedContainer) {
    try {
      command('docker', ['rm', '-f', name]);
      report.checks.cleanup = 'PASS';
    } catch {
      report.checks.cleanup = 'FAIL';
      report.status = 'FAIL';
      report.failure = 'Disposable container cleanup failed; inspect local Docker containers.';
      process.exitCode = 1;
    }
  }
  report.checkedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
}
