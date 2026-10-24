// PostToolUse (Edit|Write|MultiEdit): checks the agent's work right after each edit.
//  - Biome lint/format on the edited file
//  - TypeScript typecheck of the workspace the file belongs to
//  - migration drift when the Drizzle schema was edited
// Exit 2 sends the findings back to Claude so it fixes them before moving on.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readEvent, repoPath, run, runNodeBin, tail } from './lib.mjs';

const event = await readEvent();
const file = repoPath(event?.tool_input?.file_path ?? '');
if (!file || !existsSync(join(ROOT, file))) process.exit(0);

const problems = [];

if (/\.(ts|tsx|mts|mjs|js|json)$/.test(file) && !file.startsWith('apps/api/drizzle/')) {
  const lint = runNodeBin('@biomejs/biome/bin/biome', ['check', '--no-errors-on-unmatched', file]);
  if (!lint.ok)
    problems.push(`Biome (run \`npm run lint:fix\` for formatting):\n${tail(lint.output, 2500)}`);
}

const project = [
  ['apps/api/', 'apps/api/tsconfig.json'],
  ['apps/fake-pos/', 'apps/fake-pos/tsconfig.json'],
  ['apps/admin/', 'apps/admin/tsconfig.json'],
  ['tests/', 'tests/tsconfig.json'],
].find(([prefix]) => file.startsWith(prefix));
if (project && /\.(ts|tsx)$/.test(file)) {
  const tsc = runNodeBin('typescript/bin/tsc', ['-p', project[1], '--noEmit', '--pretty', 'false']);
  if (!tsc.ok) problems.push(`TypeScript (${project[1]}):\n${tail(tsc.output, 3000)}`);
}

if (file === 'apps/api/src/db/schema.ts') {
  const drift = run(process.execPath, ['scripts/check-migration-drift.mjs'], {
    cwd: join(ROOT, 'apps/api'),
  });
  if (!drift.ok) problems.push(drift.output.trim());
}

if (problems.length) {
  process.stderr.write(`Checks failed after editing ${file}:\n\n${problems.join('\n\n')}\n`);
  process.exit(2);
}
process.exit(0);
