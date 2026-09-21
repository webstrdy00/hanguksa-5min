import { env } from '../config/env.ts';
import { adoptJournal, migrateJournal } from './maintenance.ts';

async function main(): Promise<void> {
  const action = process.argv[2];
  const url = env.DELETION_JOURNAL_DATABASE_URL;
  const id = env.DELETION_JOURNAL_ID;
  if (url == null || id == null || !['migrate', 'adopt'].includes(action ?? '')) {
    throw new Error('JOURNAL_CONFIGURATION_REQUIRED');
  }
  if (action === 'migrate') {
    await migrateJournal(url);
    console.log('Deletion journal migration completed. Adoption remains required.');
  } else {
    const result = await adoptJournal(env.DATABASE_URL, url, id);
    console.log(
      JSON.stringify({ adoption: 'complete', importedSubjects: result.importedSubjects }),
    );
  }
}
main().catch(() => {
  console.error('Deletion journal maintenance failed. Service must remain closed for restore.');
  process.exitCode = 1;
});
