// Shared helpers for Claude Code hooks. Hooks receive a JSON event on stdin.
// Exit code 2 = block / report to Claude (stderr is shown to it); 0 = allow.
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT =
  process.env.CLAUDE_PROJECT_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Parses the hook event. Guards pass failClosed: an event they cannot read is blocked rather than
 * silently allowed (a guard that fails open is decoration).
 */
export async function readEvent({ failClosed = false } = {}) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  // Some shells (Windows PowerShell 5.1) prepend a UTF-8 byte order mark when piping.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  try {
    return JSON.parse(raw || '{}');
  } catch (error) {
    if (failClosed)
      block(`Hook could not parse its input event (${error.message}); blocking to be safe.`);
    return {};
  }
}

/** Repo-relative path with forward slashes ('' if outside the repo). */
export function repoPath(file) {
  if (!file) return '';
  const rel = relative(ROOT, resolve(ROOT, file)).replaceAll('\\', '/');
  return rel.startsWith('..') ? '' : rel;
}

export function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`;
  return { ok: result.status === 0, output };
}

/**
 * Runs a package's JS entry point with the current node binary. No shell is involved, so repo
 * paths with spaces work on every OS (a shell on Windows splits "E:\My Repo\...").
 */
export function runNodeBin(entry, args, options = {}) {
  return run(process.execPath, [resolve(ROOT, 'node_modules', entry), ...args], options);
}

export const tail = (text, max = 4000) => (text.length > max ? `…${text.slice(-max)}` : text);
