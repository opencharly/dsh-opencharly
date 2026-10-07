import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GATE_KINDS,
  GATE_RELATIVE,
  classifyCommand,
  classifyCommands,
  extractCommand,
  gatePayload,
  gateScriptFor,
  gitInvocations,
  mentionsSubcommand,
  resolveGateScripts,
  tokenize
} from '../lib/gates.js';

/** A temp directory with the real gate script layout under it. */
function tempRoot({ commit = true, push = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-opencharly-gates-'));
  mkdirSync(join(root, '.claude/hooks'), { recursive: true });
  if (commit) writeFileSync(join(root, GATE_RELATIVE.commit), '#!/usr/bin/env bash\nexit 0\n');
  if (push) writeFileSync(join(root, GATE_RELATIVE.push), '#!/usr/bin/env bash\nexit 0\n');
  return root;
}

// ── extractCommand: the match inputs ────────────────────────────────────────────

test('extractCommand reads exec.arguments.command of a bash call', () => {
  assert.equal(
    extractCommand({ name: 'bash', arguments: { command: 'git push origin main' } }),
    'git push origin main'
  );
});

test('extractCommand returns null for a non-bash exec', () => {
  for (const name of ['read', 'write', 'edit', 'grep', 'glob', 'pr_merge', 'job_output']) {
    assert.equal(extractCommand({ name, arguments: { command: 'git push origin main' } }), null, name);
  }
});

test('extractCommand returns null for an absent, blank, or non-string command', () => {
  assert.equal(extractCommand(undefined), null);
  assert.equal(extractCommand(null), null);
  assert.equal(extractCommand('bash'), null);
  assert.equal(extractCommand({ name: 'bash' }), null);
  assert.equal(extractCommand({ name: 'bash', arguments: null }), null);
  assert.equal(extractCommand({ name: 'bash', arguments: { command: 42 } }), null);
  assert.equal(extractCommand({ name: 'bash', arguments: { command: '   ' } }), null);
  assert.equal(extractCommand({ name: 'bash', arguments: { command: '\n\t' } }), null);
});

// ── classifyCommand: positives ──────────────────────────────────────────────────

test('classifyCommand recognizes the plain forms', () => {
  assert.equal(classifyCommand('git commit -m "feat: x"'), 'commit');
  assert.equal(classifyCommand('git push origin main'), 'push');
  assert.equal(classifyCommand('git push'), 'push');
  assert.equal(classifyCommand('/usr/bin/git push'), 'push');
});

test('classifyCommand sees through compound commands', () => {
  assert.equal(classifyCommand('cd /repo && git push origin main'), 'push');
  assert.equal(classifyCommand('true; git commit -m x'), 'commit');
  assert.equal(classifyCommand('git commit -m x || git commit --amend -m y'), 'commit');
  assert.equal(classifyCommand('(git push origin main)'), 'push');
  assert.equal(classifyCommand('echo hi | git commit -F -'), 'commit');
});

test('classifyCommand sees through shell keywords and modifiers', () => {
  assert.equal(classifyCommand('if git push; then echo ok; fi'), 'push');
  assert.equal(classifyCommand('sudo git commit -m x'), 'commit');
  assert.equal(classifyCommand('env GIT_AUTHOR_NAME=x git push'), 'push');
  assert.equal(classifyCommand('time git push'), 'push');
  assert.equal(classifyCommand('FOO=1 git commit -m x'), 'commit');
});

test('classifyCommand reads git global options, including value-taking ones', () => {
  assert.equal(classifyCommand('git -C /repo push'), 'push');
  assert.equal(classifyCommand('git --git-dir=/repo/.git commit -m x'), 'commit');
  assert.equal(classifyCommand('git -c core.hooksPath=/tmp/h push'), 'push');
  assert.equal(classifyCommand('git --no-pager commit -m x'), 'commit');
});

test('classifyCommand reports BOTH gates for a compound commit-and-push', () => {
  assert.deepEqual(classifyCommands('git commit -m x && git push origin main'), ['push', 'commit']);
  assert.equal(classifyCommand('git commit -m x && git push origin main'), 'push');
  assert.deepEqual(classifyCommands('git push origin main'), ['push']);
  assert.deepEqual(classifyCommands('git commit -m x'), ['commit']);
});

test('classifyCommand is NOT fooled by git inside a quoted argument', () => {
  assert.equal(null, classifyCommand('echo "git push origin main"'));
  assert.equal(null, classifyCommand("printf '%s\\n' 'git commit -m x'"));
  assert.equal(null, classifyCommand('git log --grep="git push"'));
  assert.equal(null, classifyCommand('git log --oneline --grep=push'));
  assert.deepEqual(classifyCommands('echo "git push" && git push origin main'), ['push']);
});

test('classifyCommand is NOT fooled by a comment or by a different subcommand', () => {
  assert.equal(null, classifyCommand('# git push origin main'));
  assert.equal(null, classifyCommand('git status'));
  assert.equal(null, classifyCommand('git pushx origin main'));
  assert.equal(null, classifyCommand('git commitx -m x'));
  assert.equal(null, classifyCommand('git log --oneline'));
  assert.equal(null, classifyCommand('echo git'));
  assert.equal(null, classifyCommand('ls -la'));
  assert.equal(null, classifyCommand(''));
  assert.equal(null, classifyCommand('   '));
  assert.deepEqual(classifyCommands(undefined), []);
  assert.deepEqual(classifyCommands(42), []);
});

test('classifyCommand keeps a git subcommand named after a git argument', () => {
  // `commit` as an ARGUMENT of a push is not a commit invocation.
  assert.deepEqual(classifyCommands('git push origin commit'), ['push']);
  // …and the reverse.
  assert.deepEqual(classifyCommands('git commit -m push'), ['commit']);
});

// ── fail-closed on unparseable input ─────────────────────────────────────────────

test('tokenize throws on an unbalanced quote', () => {
  assert.throws(() => tokenize('git commit -m "unbalanced'), /unterminated double quote/);
  assert.throws(() => tokenize("git commit -m 'unbalanced"), /unterminated single quote/);
  assert.throws(() => tokenize('echo "it is'), /unterminated double quote/);
});

test('classifyCommand fails CLOSED when the command cannot be tokenized', () => {
  // An apostrophe in a heredoc body is the measured shape (`.claude/hooks/gitcmd.py:9-17`).
  assert.equal(classifyCommand(`cat <<'EOF' > x\nit's a note\nEOF\ngit push origin main`), 'push');
  assert.equal(classifyCommand('git commit -m "don\'t'), 'commit');
  // Untokenizable and git-free: correctly nothing.
  assert.equal(classifyCommand('echo "it is'), null);
});

test('mentionsSubcommand is the loose fail-closed predicate', () => {
  assert.equal(mentionsSubcommand('git push origin main', 'push'), true);
  assert.equal(mentionsSubcommand('x && git   push', 'push'), true);
  assert.equal(mentionsSubcommand('git push origin main', 'commit'), false);
  assert.equal(mentionsSubcommand('gitx push', 'push'), false);
});

// ── gitInvocations: segment bounding ─────────────────────────────────────────────

test('gitInvocations bounds each invocation to its own shell segment', () => {
  const found = gitInvocations('git commit -m x && git push origin main', 'commit');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].args, ['-m', 'x']);
});

test('gitInvocations carries the global options of the invocation it matched', () => {
  const found = gitInvocations('git -c core.hooksPath=/tmp/h push origin main', 'push');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].globals, ['-c', 'core.hooksPath=/tmp/h']);
  assert.deepEqual(found[0].args, ['origin', 'main']);
});

// ── gateScriptFor and gatePayload ────────────────────────────────────────────────

test('gateScriptFor resolves the two gate scripts and rejects an unknown kind', () => {
  assert.equal(gateScriptFor('commit'), '.claude/hooks/pre-commit-gate.sh');
  assert.equal(gateScriptFor('push'), '.claude/hooks/pre-push-gate.sh');
  assert.equal(gateScriptFor('commit', '/repo'), '/repo/.claude/hooks/pre-commit-gate.sh');
  assert.equal(gateScriptFor('push', '/repo/'), '/repo/.claude/hooks/pre-push-gate.sh');
  assert.equal(gateScriptFor('force'), null);
  assert.equal(gateScriptFor('commit', '  '), '.claude/hooks/pre-commit-gate.sh');
});

test('gatePayload is exactly what the gate scripts read off stdin', () => {
  assert.deepEqual(gatePayload('git push origin main'), {
    tool_input: { command: 'git push origin main' }
  });
  assert.equal(JSON.stringify(gatePayload('a\nb')), '{"tool_input":{"command":"a\\nb"}}');
});

test('GATE_KINDS and GATE_RELATIVE describe the same two gates', () => {
  assert.deepEqual([...GATE_KINDS].sort(), ['commit', 'push']);
  assert.deepEqual(Object.keys(GATE_RELATIVE).sort(), ['commit', 'push']);
});

// ── resolveGateScripts: resolution order ─────────────────────────────────────────

test('resolveGateScripts picks the config root first, then session, env, cwd', () => {
  const have = (paths) => (p) => paths.includes(p);
  const configRoot = tempRoot();
  const sessionRoot = tempRoot();
  const envRoot = tempRoot();
  const cwdRoot = tempRoot();
  const all = [configRoot, sessionRoot, envRoot, cwdRoot].flatMap((r) => [
    join(r, GATE_RELATIVE.commit),
    join(r, GATE_RELATIVE.push)
  ]);
  const probe = have(all);
  try {
    assert.equal(
      resolveGateScripts({ explicit: { root: configRoot }, sessionRoot, envDir: envRoot, cwd: cwdRoot, probe }).source,
      'config'
    );
    assert.equal(resolveGateScripts({ sessionRoot, envDir: envRoot, cwd: cwdRoot, probe }).source, 'session');
    assert.equal(resolveGateScripts({ envDir: envRoot, cwd: cwdRoot, probe }).source, 'env');
    assert.equal(resolveGateScripts({ cwd: cwdRoot, probe }).source, 'cwd');
  } finally {
    for (const root of [configRoot, sessionRoot, envRoot, cwdRoot]) rmSync(root, { recursive: true, force: true });
  }
});

test('resolveGateScripts walks past a candidate that holds no gate at all', () => {
  const empty = mkdtempSync(join(tmpdir(), 'dsh-opencharly-empty-'));
  const real = tempRoot();
  const probe = (p) => p.startsWith(real);
  try {
    const resolution = resolveGateScripts({ sessionRoot: empty, envDir: real, probe });
    assert.equal(resolution.source, 'env');
    assert.equal(resolution.root, real);
    assert.deepEqual(resolution.missing, []);
    assert.equal(resolution.reason, '');
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test('resolveGateScripts tries a duplicated root only once', () => {
  const root = tempRoot();
  let calls = 0;
  const probe = (p) => {
    calls += 1;
    return p.startsWith(root);
  };
  try {
    const resolution = resolveGateScripts({ explicit: { root }, sessionRoot: root, cwd: root, probe });
    assert.equal(resolution.source, 'config');
    assert.equal(calls, 2, 'two probes for two kinds, not six');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── resolveGateScripts: the visible-skip contract ────────────────────────────────

test('resolveGateScripts reports SKIP (never a fabricated block) when no gate exists', () => {
  const resolution = resolveGateScripts({ sessionRoot: '/nope', envDir: '/nope', cwd: '/nope' });
  assert.equal(resolution.root, null);
  assert.equal(resolution.source, null);
  assert.deepEqual(resolution.scripts, { commit: null, push: null });
  assert.deepEqual(resolution.available, { commit: false, push: false });
  assert.deepEqual(resolution.missing.sort(), ['commit', 'push']);
  assert.match(resolution.reason, /no pre-commit-gate\.sh \/ pre-push-gate\.sh found/);
});

test('resolveGateScripts reports a HALF-resolved set as missing, with a reason', () => {
  const root = tempRoot({ push: false });
  try {
    const resolution = resolveGateScripts({ sessionRoot: root, probe: (p) => p.startsWith(root) && !p.endsWith('pre-push-gate.sh') });
    assert.equal(resolution.source, 'session');
    assert.deepEqual(resolution.missing, ['push']);
    assert.equal(resolution.available.commit, true);
    assert.equal(resolution.available.push, false);
    assert.match(resolution.reason, /pre-push-gate\.sh not found/);
    assert.match(resolution.reason, /SKIPPED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveGateScripts honours an explicit per-kind script path', () => {
  const root = tempRoot({ commit: false });
  const custom = join(root, 'my-commit-gate.sh');
  writeFileSync(custom, '#!/usr/bin/env bash\nexit 0\n');
  try {
    const resolution = resolveGateScripts({
      explicit: { root, commitScript: custom },
      probe: (p) => p.startsWith(root) && !p.endsWith('pre-push-gate.sh')
    });
    assert.equal(resolution.scripts.commit, custom);
    assert.equal(resolution.available.commit, true);
    assert.deepEqual(resolution.missing, ['push']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveGateScripts uses the REAL filesystem probe by default', () => {
  const root = tempRoot();
  try {
    const resolution = resolveGateScripts({ sessionRoot: root });
    assert.equal(resolution.root, root);
    assert.equal(resolution.source, 'session');
    assert.equal(resolution.available.commit, true);
    assert.equal(resolution.available.push, true);
    assert.deepEqual(resolution.scripts, {
      commit: join(root, GATE_RELATIVE.commit),
      push: join(root, GATE_RELATIVE.push)
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveGateScripts never probes a directory as a gate script', () => {
  const root = tempRoot({ commit: false, push: false });
  try {
    // The layout exists as DIRECTORIES, which is not a usable gate.
    const resolution = resolveGateScripts({ sessionRoot: root });
    assert.equal(resolution.root, null);
    assert.equal(resolution.available.commit, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
