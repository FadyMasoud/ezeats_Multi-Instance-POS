// PreToolUse (Bash|PowerShell): blocks shell commands that are destructive, bypass the quality
// gates, or handle secrets. Each rule exists because the action is irreversible or hides a problem.
import { block, readEvent } from './lib.mjs';

const RULES = [
  {
    // -n may be combined with other short flags (e.g. -nm).
    test: /\bgit\s+commit\b[^\n]*(--no-verify|\s-[a-zA-Z]*n[a-zA-Z]*(\s|$))/,
    why: 'Do not skip the pre-commit hook. Fix what `npm run check` reports instead.',
  },
  {
    test: /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/,
    why: 'Force-push rewrites shared history (reviewers read the commit history). Ask the user.',
  },
  {
    test: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.(\s|$)|restore\s+\.(\s|$))/,
    why: 'This discards uncommitted work irreversibly. Ask the user first.',
  },
  {
    test: /\bgit\s+rebase\b|\bgit\s+commit\b[^\n]*--amend/,
    why: 'Keep the commit history as-is (no rebase/amend); make a new commit instead.',
  },
  {
    test: /drizzle-kit\s+(push|drop)\b/,
    why: 'Schema changes go through generated migrations: edit schema.ts, run `npm run db:generate`.',
  },
  {
    test: /\b(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\s+\w)/i,
    why: 'Destructive SQL from the shell is not allowed. Tests reset their own database.',
  },
  {
    test: /docker\s+compose\b[^\n]*\bdown\b[^\n]*(-v\b|--volumes\b)/,
    why: 'This deletes the Postgres volume. Ask the user first.',
  },
  {
    test: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|~|\.|\*|\.\/?|apps\/?|apps\/api\/drizzle\/?)(\s|$)/,
    why: 'Recursive delete of the repo, apps/ or migrations is blocked.',
  },
  {
    test: /Remove-Item\b[^\n]*-Recurse[^\n]*(\s|["'])(\.|apps|apps[\\/]api[\\/]drizzle)(["']|\s|$)/i,
    why: 'Recursive delete of the repo, apps/ or migrations is blocked.',
  },
  {
    // Added after an agent looped over guessed database passwords (see AI_NOTES.md).
    test: /PGPASSWORD\s*=|postgres(ql)?:\/\/[^:\s/]+:[^@\s$]+@/i,
    why: 'Do not put or guess database credentials in commands. They come from .env; if a credential is missing, ask the user.',
  },
  {
    test: /\b(cat|type|less|more|head|tail|Get-Content|gc|bat|code)\b[^|;&\n]*(^|[\s"'/\\])\.env(\.(?!example)[\w.-]+)?(["'\s]|$)/i,
    why: '.env holds secrets; do not print it. Use .env.example to learn the variable names.',
  },
  {
    test: /\bnpm\s+publish\b/,
    why: 'Publishing is not part of this project.',
  },
];

const event = await readEvent({ failClosed: true });
const command = String(event?.tool_input?.command ?? '');
for (const rule of RULES) {
  if (rule.test.test(command)) block(`Blocked by .claude/hooks/guard-commands.mjs: ${rule.why}`);
}
process.exit(0);
