import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function runHook(script: string, event: unknown): { code: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [resolve(ROOT, '.claude/hooks', script)], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
  });
  return { code: result.status, stderr: result.stderr };
}

const bash = (command: string) =>
  runHook('guard-commands.mjs', { tool_name: 'Bash', tool_input: { command } });
const edit = (file_path: string, tool_name = 'Edit') =>
  runHook('guard-files.mjs', { tool_name, tool_input: { file_path: resolve(ROOT, file_path) } });

describe('guard-commands hook', () => {
  it.each([
    'git commit -m "wip" --no-verify',
    'git commit -nm "wip"',
    'git push --force origin main',
    'git push -f',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git rebase -i HEAD~3',
    'git commit --amend -m x',
    'npx drizzle-kit push',
    'psql -c "DROP DATABASE ezeats"',
    'psql -c "TRUNCATE checks"',
    'docker compose down -v',
    'rm -rf apps/api/drizzle',
    'rm -rf .',
    'export PGPASSWORD=hunter2 && psql',
    'DATABASE_URL=postgres://postgres:secret@db:5432/ezeats npm run db:migrate',
    'cat .env',
    'Get-Content .env.local',
  ])('blocks: %s', (command) => {
    const result = bash(command);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Blocked/);
  });

  it.each([
    'npm run check',
    'git commit -m "feat: x"',
    'git push origin main',
    'git status',
    'cat .env.example',
    'npm run db:generate -- --name add_index',
    'rm -rf apps/admin/dist',
    'DATABASE_URL=$DATABASE_URL npm run db:migrate',
    'docker compose down',
  ])('allows: %s', (command) => {
    expect(bash(command).code).toBe(0);
  });
});

describe('guard-files hook', () => {
  it('blocks edits to generated migrations', () => {
    const result = edit('apps/api/drizzle/0000_init.sql');
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/db:generate/);
  });

  it('blocks reading or editing .env files but not .env.example', () => {
    expect(edit('.env', 'Read').code).toBe(2);
    expect(edit('.env.production', 'Write').code).toBe(2);
    expect(edit('.env.example', 'Read').code).toBe(0);
    expect(edit('.env.example').code).toBe(0);
  });

  it('blocks hand-editing package-lock.json', () => {
    expect(edit('package-lock.json', 'Write').code).toBe(2);
  });

  it('allows normal source edits and reading migrations', () => {
    expect(edit('apps/api/src/sync/sync-machine.ts').code).toBe(0);
    expect(edit('apps/api/drizzle/0000_init.sql', 'Read').code).toBe(0);
  });
});
