// Stop: before Claude reports "done", run the same gate as pre-commit and CI (`npm run check`)
// if any source file changed. A failing gate blocks the stop and the output goes back to Claude.
import { ROOT, readEvent, run, tail } from './lib.mjs';

const event = await readEvent();
// Already continuing because of this hook: let it stop rather than loop forever.
if (event?.stop_hook_active) process.exit(0);

const status = run('git', ['status', '--porcelain', '--', 'apps', 'tests', 'package.json'], {
  shell: false,
});
const changed = status.output
  .split('\n')
  .map((line) => line.slice(3).trim())
  .filter((path) => /\.(ts|tsx|mjs|json|sql)$/.test(path));
if (!status.ok || changed.length === 0) process.exit(0);

// npm is npm.cmd on Windows, which needs a shell; the command itself contains no paths.
const check = run('npm', ['run', 'check'], { cwd: ROOT, shell: process.platform === 'win32' });
if (!check.ok) {
  process.stderr.write(
    [
      `\`npm run check\` fails with uncommitted changes in: ${changed.slice(0, 8).join(', ')}`,
      'Fix it (or tell the user exactly what is broken and why) before finishing.',
      '',
      tail(check.output, 5000),
    ].join('\n'),
  );
  process.exit(2);
}
process.exit(0);
