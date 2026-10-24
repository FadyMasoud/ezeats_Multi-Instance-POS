// Fails when src/db/schema.ts has changes that no generated migration covers.
// (`drizzle-kit check` only validates existing migrations; it does not detect a forgotten one.)
// Works on a temporary copy of drizzle/, so the real migrations folder is never touched.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Must be relative: drizzle-kit prefixes "./" to --out, which breaks absolute Windows paths.
const tmp = mkdtempSync(join(apiDir, '.drift-'));
const out = relative(apiDir, join(tmp, 'drizzle')).replaceAll('\\', '/');
const sqlFiles = () => readdirSync(join(apiDir, out)).filter((f) => f.endsWith('.sql'));

let exitCode = 0;
try {
  cpSync(join(apiDir, 'drizzle'), join(apiDir, out), { recursive: true });
  const before = sqlFiles().length;
  const run = spawnSync(
    process.execPath,
    [
      join(apiDir, '..', '..', 'node_modules', 'drizzle-kit', 'bin.cjs'),
      'generate',
      '--dialect=postgresql',
      '--schema=./src/db/schema.ts',
      `--out=${out}`,
      '--name=drift_probe',
    ],
    { cwd: apiDir, encoding: 'utf8' },
  );
  const output = `${run.stdout}\n${run.stderr}`;
  const after = sqlFiles().length;

  // drizzle-kit can print an error and still exit 0, so require a positive signal either way.
  if (after > before && /migration file/i.test(output)) {
    console.error(
      'Migration drift: src/db/schema.ts changed but no migration covers it.\n' +
        'Run `npm run db:generate -- --name <change>` and commit the new file in apps/api/drizzle/.',
    );
    exitCode = 1;
  } else if (after === before && /no schema changes/i.test(output)) {
    console.log('migrations are in sync with src/db/schema.ts');
  } else {
    console.error(`Migration drift check could not run:\n${output}`);
    exitCode = 2;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);
