/**
 * The git-gate seam: recognize a `git commit` / `git push` tool call and resolve
 * the repo's OWN gate scripts for it.
 *
 * This module NEVER re-implements gate policy. Force-push, `--no-verify`,
 * `core.hooksPath`, direct-to-`main`, lint cleanliness and attribution are all
 * decided by `.claude/hooks/pre-commit-gate.sh` and `.claude/hooks/pre-push-gate.sh`
 * in the session's checkout. This module only answers two questions: *does this
 * command call for a gate*, and *where is that gate*. Anything else would be a
 * second policy implementation that drifts from the first (R3).
 *
 * DISCIPLINE BACKSTOP, NOT A SECURITY BOUNDARY. The tokenizer below parses the
 * common, honest command forms and does NOT try to defeat deliberate obfuscation —
 * splitting the command word, assembling it at runtime, or hiding it inside a
 * quoted string passed to `bash -c`. That is an infinite regress no static parser
 * wins, and GitHub branch protection plus the fresh `pr-validator` are the real
 * authority. This framing is inherited verbatim from the gate scripts' own shared
 * parser, `.claude/hooks/gitcmd.py:1-17`, which this port follows statement for
 * statement so the two cannot drift.
 *
 * @module dsh-opencharly/gates
 */

import { join, resolve as resolveAbsolute } from 'node:path';
import { statSync } from 'node:fs';

/** Separator characters that bound one simple command inside a compound line. */
const SEPARATOR_CHARS = '&|;()<>';

/**
 * Shell keywords / command-modifier words a real `git` may hide behind. Mirrors
 * `_SKIP` in `.claude/hooks/gitcmd.py:30-32`.
 */
const SKIP_WORDS = new Set([
  'if', 'then', 'elif', 'else', 'do', 'while', 'until', '!',
  'command', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf',
  'setsid', 'sudo', 'doas', 'env', 'xargs', 'builtin'
]);

/**
 * `git` GLOBAL options that consume the NEXT token as their value. A subcommand's
 * own options sit AFTER the subcommand, so a scan that stops at the first
 * non-option token never mistakes them for globals.
 * Mirrors `_VALUE_OPTS` in `.claude/hooks/gitcmd.py:26-27`.
 */
const VALUE_OPTS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace',
  '--config-env', '--exec-path', '--super-prefix'
]);

/** A leading `NAME=value` environment assignment. */
const ENV_ASSIGN = /^\w+=/;

/** The gate kinds this seam recognizes, in evaluation order. */
export const GATE_KINDS = Object.freeze(['push', 'commit']);

/**
 * The repo-relative path of each gate script, exactly where the org keeps them.
 * `commit` is listed second so `GATE_KINDS` stays push-first without reordering.
 */
export const GATE_RELATIVE = Object.freeze({
  commit: '.claude/hooks/pre-commit-gate.sh',
  push: '.claude/hooks/pre-push-gate.sh'
});

/** Basename of a POSIX path, without pulling in `node:path` semantics for it. */
function baseName(token) {
  return token.slice(token.lastIndexOf('/') + 1);
}

/** True for a run of shell separator punctuation. */
function isSeparator(token) {
  if (token.length === 0) return false;
  for (const ch of token) {
    if (!SEPARATOR_CHARS.includes(ch)) return false;
  }
  return true;
}

/** POSIX-shell word splitting: quotes, backslash escapes, punctuation, comments. */
function pushToken(tokens, state) {
  if (!state.started) return;
  tokens.push(state.current);
  state.current = '';
  state.started = false;
}

/**
 * Split a shell command into shell words.
 *
 * `&&`/`||`/`;`/`|`/`&`/`(`/`)`/`<`/`>` become their own tokens, a quoted argument
 * containing a space stays ONE token (the fail-open a bare regex has), and a `#`
 * at a word boundary starts a comment to end of line.
 *
 * @param command - the raw shell command.
 * @returns the token list.
 * @throws {Error} when the command carries an unbalanced or unterminated quote —
 *   the caller must fail CLOSED on that, exactly as `.claude/hooks/gitcmd.py:52,82-87`
 *   requires; returning "no command" there is how a gate silently stops gating.
 */
export function tokenize(command) {
  const tokens = [];
  const state = { current: '', started: false };
  let i = 0;

  while (i < command.length) {
    const ch = command[i];

    if (ch === '\\') {
      state.started = true;
      if (i + 1 < command.length) state.current += command[i + 1];
      i += 2;
      continue;
    }

    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) throw new Error('unterminated single quote');
      state.current += command.slice(i + 1, end);
      state.started = true;
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= command.length) throw new Error('unterminated double quote');
        const c = command[j];
        if (c === '\\') {
          if (j + 1 >= command.length) throw new Error('unterminated double quote');
          const next = command[j + 1];
          // Inside double quotes only these four escapes are special.
          value += next === '"' || next === '\\' || next === '$' || next === '`' ? next : `\\${next}`;
          j += 2;
          continue;
        }
        if (c === '"') break;
        value += c;
        j += 1;
      }
      state.current += value;
      state.started = true;
      i = j + 1;
      continue;
    }

    if (ch === '#' && !state.started) {
      const newline = command.indexOf('\n', i);
      if (newline === -1) break;
      i = newline;
      continue;
    }

    if (/\s/.test(ch)) {
      pushToken(tokens, state);
      i += 1;
      continue;
    }

    if (SEPARATOR_CHARS.includes(ch)) {
      pushToken(tokens, state);
      let j = i;
      while (j < command.length && SEPARATOR_CHARS.includes(command[j])) j += 1;
      tokens.push(command.slice(i, j));
      i = j;
      continue;
    }

    state.current += ch;
    state.started = true;
    i += 1;
  }

  pushToken(tokens, state);
  return tokens;
}

/**
 * Every `git [global-opts] <subcommand> [args]` in `command`, bounded to its own
 * shell segment so a compound `… && …` cannot bleed one command's args into
 * another. Port of `git_invocations` (`.claude/hooks/gitcmd.py:48-79`).
 *
 * @param command - the raw shell command.
 * @param subcommand - `'commit'` or `'push'`.
 * @returns one `{ globals, args }` per matching invocation, in command order.
 * @throws {Error} when `command` cannot be tokenized — the caller fails closed.
 */
export function gitInvocations(command, subcommand) {
  const tokens = tokenize(command);

  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (isSeparator(token)) {
      segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  segments.push(current);

  const found = [];
  for (const segment of segments) {
    let i = 0;
    while (i < segment.length && (SKIP_WORDS.has(segment[i]) || ENV_ASSIGN.test(segment[i]))) i += 1;
    if (i >= segment.length || baseName(segment[i]) !== 'git') continue;
    i += 1;

    const globals = [];
    while (i < segment.length && segment[i].startsWith('-')) {
      globals.push(segment[i]);
      i += 1;
      if (VALUE_OPTS.has(globals[globals.length - 1]) && i < segment.length && !segment[i].startsWith('-')) {
        globals.push(segment[i]);
        i += 1;
      }
    }

    if (i < segment.length && segment[i] === subcommand) {
      found.push({ globals, args: segment.slice(i + 1) });
    }
  }
  return found;
}

/**
 * Is a `git … <subcommand>` PLAUSIBLY present in a command the tokenizer could not
 * parse? The fail-closed predicate used after a {@link tokenize} throw. One
 * definition, ported from `mentions_subcommand` (`.claude/hooks/gitcmd.py:82-87`).
 *
 * @param command - the raw shell command.
 * @param subcommand - `'commit'` or `'push'`.
 * @returns `true` when the loose pattern matches.
 */
export function mentionsSubcommand(command, subcommand) {
  const escaped = subcommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s;&|(])git\\b[^\\n]*\\b${escaped}\\b`).test(command);
}

/**
 * Every gate this command calls for, de-duplicated, in {@link GATE_KINDS} order.
 *
 * A compound `git commit … && git push …` legitimately yields BOTH: the caller
 * must run each gate, because passing the commit gate says nothing about the push.
 *
 * @param command - the raw shell command.
 * @returns a subset of `['push', 'commit']`.
 */
export function classifyCommands(command) {
  if (typeof command !== 'string' || command.trim().length === 0) return [];

  const hits = new Set();
  try {
    for (const kind of GATE_KINDS) {
      if (gitInvocations(command, kind).length > 0) hits.add(kind);
    }
  } catch {
    // Untokenizable input (a stray quote — e.g. an apostrophe in a heredoc body).
    // Fail CLOSED on the loose pattern rather than reporting "no git command here".
    for (const kind of GATE_KINDS) {
      if (mentionsSubcommand(command, kind)) hits.add(kind);
    }
  }
  return GATE_KINDS.filter((kind) => hits.has(kind));
}

/**
 * The single gate kind this command calls for — the first in evaluation order.
 *
 * @param command - the raw shell command.
 * @returns `'push'`, `'commit'`, or `null` when no gate applies.
 */
export function classifyCommand(command) {
  const kinds = classifyCommands(command);
  return kinds.length > 0 ? kinds[0] : null;
}

/**
 * The command string of a `bash` tool call, or `null` when this execution is not
 * one this seam inspects.
 *
 * `exec.name === 'bash'` and `exec.arguments.command` are the match inputs the
 * live registry hands a `tools/pre-execute` listener
 * (`dsh-tool-bash/lib/index.js:488` registers the name, `:235` validates the
 * argument). A non-bash exec, an absent/!string `command`, or a blank command
 * yields `null` and the caller simply delegates with `next()`.
 *
 * @param exec - the pending `ToolExecution`.
 * @returns the command string, or `null`.
 */
export function extractCommand(exec) {
  if (typeof exec !== 'object' || exec === null) return null;
  if (exec.name !== 'bash') return null;
  const args = exec.arguments;
  if (typeof args !== 'object' || args === null) return null;
  const command = args.command;
  if (typeof command !== 'string') return null;
  return command.trim().length === 0 ? null : command;
}

/**
 * The stdin payload both gate scripts read: `{"tool_input":{"command":"…"}}`,
 * exactly as the upstream `dsh-hooks-claude-code` bridge maps `PreToolUse`
 * (`dsh-hooks-claude-code/lib/index.js:367-373` builds `tool_input`, `:248-262`
 * runs the hook with it).
 *
 * @param command - the raw shell command.
 * @returns the JSON-serializable stdin object.
 */
export function gatePayload(command) {
  return { tool_input: { command } };
}

/**
 * The gate script path for one kind.
 *
 * @param kind - `'commit'` or `'push'`.
 * @param root - optional project root to resolve against; omitted returns the
 *   repo-relative path.
 * @returns the path, or `null` for an unknown kind.
 */
export function gateScriptFor(kind, root) {
  const relative = GATE_RELATIVE[kind];
  if (relative === undefined) return null;
  if (typeof root !== 'string' || root.trim().length === 0) return relative;
  return join(root, relative);
}

/** Default availability probe: a readable regular file. Never throws. */
export function defaultGateProbe(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve which gate scripts this session will actually use, and why.
 *
 * Candidates are tried in the documented order — an explicit config root, then the
 * session's own repo root, then `$CLAUDE_PROJECT_DIR`, then the process cwd — and
 * the FIRST candidate holding at least one gate script wins. De-duplicated roots
 * are tried once, so a config root equal to the session root costs nothing.
 *
 * The result is deliberately explicit about a HALF-RESOLVED set: `missing` names
 * the kinds with no usable script and `reason` says so in one line, because R7a
 * forbids a gate that silently pretends to gate. The caller's contract is: run
 * every available gate, and log a visible skip line for every missing one.
 *
 * @param options - resolution inputs; all optional.
 * @param options.explicit - `{ root, commitScript, pushScript }` from config.
 * @param options.sessionRoot - the session's own checkout root, when known.
 * @param options.envDir - `$CLAUDE_PROJECT_DIR`, when set.
 * @param options.cwd - the process cwd, the last resort.
 * @param options.probe - injectable availability probe; defaults to the real fs.
 * @returns `{ root, source, scripts, available, missing, reason }`.
 */
export function resolveGateScripts({ explicit = {}, sessionRoot = null, envDir = null, cwd = null, probe = defaultGateProbe } = {}) {
  const explicitCommit = typeof explicit.commitScript === 'string' ? explicit.commitScript.trim() : '';
  const explicitPush = typeof explicit.pushScript === 'string' ? explicit.pushScript.trim() : '';

  const candidates = [];
  const seen = new Set();
  const addCandidate = (value, source) => {
    if (typeof value !== 'string' || value.trim().length === 0) return;
    const root = resolveAbsolute(value.trim());
    if (seen.has(root)) return;
    seen.add(root);
    candidates.push({ root, source });
  };
  addCandidate(explicit.root, 'config');
  addCandidate(sessionRoot, 'session');
  addCandidate(envDir, 'env');
  addCandidate(cwd, 'cwd');

  /** Explicit per-kind script paths win over root derivation, but only where they exist. */
  const scriptFor = (kind, root) => {
    const override = kind === 'commit' ? explicitCommit : explicitPush;
    const path = override.length > 0 ? resolveAbsolute(override) : gateScriptFor(kind, root);
    return { path, available: probe(path) };
  };

  let chosen = null;
  for (const candidate of candidates) {
    const scripts = { commit: null, push: null };
    const available = { commit: false, push: false };
    for (const kind of ['commit', 'push']) {
      const resolved = scriptFor(kind, candidate.root);
      scripts[kind] = resolved.path;
      available[kind] = resolved.available;
    }
    if (available.commit || available.push) {
      chosen = { ...candidate, scripts, available };
      break;
    }
  }

  if (chosen === null) {
    return {
      root: null,
      source: null,
      scripts: { commit: null, push: null },
      available: { commit: false, push: false },
      missing: ['push', 'commit'],
      reason: 'no pre-commit-gate.sh / pre-push-gate.sh found in any candidate root (config, session, $CLAUDE_PROJECT_DIR, cwd)'
    };
  }

  const missing = ['push', 'commit'].filter((kind) => !chosen.available[kind]);
  return {
    root: chosen.root,
    source: chosen.source,
    scripts: chosen.scripts,
    available: chosen.available,
    missing,
    reason: missing.length === 0
      ? ''
      : `${missing.map((kind) => GATE_RELATIVE[kind]).join(' and ')} not found under ${chosen.root} (source: ${chosen.source}); that gate is SKIPPED`
  };
}
