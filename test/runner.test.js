/**
 * B12 — coverage for the two functions that actually RUN things.
 *
 * Every seam test in `test/wiring.test.js` injects `runGate`/`spawnWatcher`, so a break
 * in the spawn argv, the stdin payload, the exit-code handling, the timeout/abort path,
 * or the job piping would pass CI. These tests execute the real implementations against
 * fixture scripts and a real child process, so each one fails if that path breaks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runGateScript, spawnWatcherProcess, gatePayload } from '../lib/index.js';

/** Write an executable fixture script and return its path. */
function fixture(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-opencharly-runner-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A job-shaped recorder matching the `job.append` surface `spawnWatcherProcess` uses. */
function recorder() {
  const appended = [];
  return {
    appended,
    append(chunk, options) {
      appended.push({ chunk, channel: options?.channel ?? 'stdout' });
    },
    text() {
      return appended.map((a) => a.chunk).join('');
    }
  };
}

test('runGateScript: exit 0 is an allow, and the payload reaches stdin as {tool_input:{command}}', async () => {
  const ws = workspace();
  try {
    const seen = join(ws.dir, 'seen.json');
    const script = fixture(ws.dir, 'allow.sh', `cat > "${seen}"\nexit 0`);
    const outcome = await runGateScript(script, gatePayload('git status'));

    assert.equal(outcome.code, 0);
    assert.equal(outcome.error, null);
    assert.equal(outcome.aborted, false);
    // The payload contract the committed gate scripts parse.
    assert.deepEqual(JSON.parse(readFileSync(seen, 'utf8')), {
      tool_input: { command: 'git status' }
    });
  } finally {
    ws.done();
  }
});

test('runGateScript: exit 2 is a block, and the reason is the script stderr', async () => {
  const ws = workspace();
  try {
    const script = fixture(
      ws.dir,
      'block.sh',
      'echo "BLOCKED: --no-verify bypasses the gate" >&2\nexit 2'
    );
    const outcome = await runGateScript(script, gatePayload('git commit --no-verify'));

    assert.equal(outcome.code, 2);
    assert.match(outcome.stderr, /BLOCKED: --no-verify/);
    assert.equal(outcome.error, null);
  } finally {
    ws.done();
  }
});

test('runGateScript: an anomalous exit is surfaced, never treated as an allow', async () => {
  const ws = workspace();
  try {
    const script = fixture(ws.dir, 'weird.sh', 'exit 3');
    const outcome = await runGateScript(script, gatePayload('git push origin main'));

    assert.equal(outcome.code, 3);
    assert.equal(outcome.error, null); // the code is the signal; the CALLER decides
  } finally {
    ws.done();
  }
});

test('runGateScript: a missing script settles with an error instead of hanging', async () => {
  const ws = workspace();
  try {
    const outcome = await runGateScript(
      join(ws.dir, 'does-not-exist.sh'),
      gatePayload('git push')
    );
    // bash runs and fails to find the script, so code is non-zero with stderr set;
    // either way it must SETTLE and must not look like an allow.
    assert.notEqual(outcome.code, 0);
  } finally {
    ws.done();
  }
});

test('runGateScript: a timeout kills the child and reports it as such', async () => {
  const ws = workspace();
  try {
    const script = fixture(ws.dir, 'slow.sh', 'sleep 30\nexit 0');
    const outcome = await runGateScript(script, gatePayload('git push'), { timeoutMs: 250 });

    assert.equal(outcome.code, null);
    assert.match(outcome.error, /timed out after 250ms/);
    assert.equal(outcome.aborted, false);
  } finally {
    ws.done();
  }
});

test('runGateScript: an abort settles with aborted=true and does not wait for the child', async () => {
  const ws = workspace();
  try {
    const script = fixture(ws.dir, 'forever.sh', 'sleep 30\nexit 0');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 120);
    const outcome = await runGateScript(script, gatePayload('git push'), {
      signal: controller.signal,
      timeoutMs: 30000
    });

    assert.equal(outcome.aborted, true);
    assert.equal(outcome.code, null);
    assert.match(outcome.error, /cancelled/);
  } finally {
    ws.done();
  }
});

test('spawnWatcherProcess: a clean watcher exit pipes both channels and settles completed', async () => {
  const job = recorder();
  const hooks = spawnWatcherProcess(
    ['-c', 'echo "MERGED acme/widget#1"; echo "diagnostic" >&2; exit 0'],
    { cwd: tmpdir(), job }
  );
  const outcome = await hooks.done;

  assert.equal(outcome.status, 'completed');
  assert.match(job.text(), /MERGED acme\/widget#1/);
  // stdout events and stderr diagnostics are tagged, so the wake line is separable.
  assert.ok(job.appended.some((a) => a.channel === 'stderr' && /diagnostic/.test(a.chunk)));
  assert.ok(job.appended.some((a) => a.channel === 'stdout' && /MERGED/.test(a.chunk)));
  assert.ok(job.appended.some((a) => a.channel === 'log' && /exit code: 0/.test(a.chunk)));
});

test('spawnWatcherProcess: a non-zero watcher exit settles failed with the code', async () => {
  const job = recorder();
  const hooks = spawnWatcherProcess(['-c', 'exit 7'], { cwd: tmpdir(), job });
  const outcome = await hooks.done;

  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail, /exit code: 7/);
});

test('spawnWatcherProcess: cancel settles as killed, so a job is never left dangling', async () => {
  const job = recorder();
  const hooks = spawnWatcherProcess(['-c', 'sleep 30'], { cwd: tmpdir(), job });
  hooks.cancel('superseded');

  const outcome = await hooks.done;
  assert.equal(outcome.status, 'killed');
  assert.equal(outcome.detail, 'superseded');
});
