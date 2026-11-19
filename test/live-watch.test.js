import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';

/**
 * LIVE: the plugin's REAL watch wiring — `apply()`, `spawnWatcherProcess` and
 * `loadEngineStateEvents`, nothing injected — runs the umbrella's REAL watcher CLI and
 * imports its REAL engine (`scripts/gh/`, copied from the checkout named by
 * `DSH_OPENCHARLY_UMBRELLA`), against REAL GitHub.
 *
 * The property is the one the pi binding broke (opencharly/opencharly#1163): a state event
 * fires from the arm baseline and `--no-arm-wake` does not suppress it, so a binding that
 * re-armed such an item would re-arm without end. The item watched here is a real PR that
 * merged long ago — a state that never changes, so the test is deterministic against the
 * real service and only ever READS. Correct: ONE arm, and the watch ends on `MERGED`.
 *
 * The job controller is the only stand-in (DSH's host); it runs a job at start, as the real
 * one does, and refuses after MAX_STARTS, so a broken seam fails fast instead of spending
 * the account's API budget in a loop. Skipped visibly without `DSH_OPENCHARLY_UMBRELLA` or
 * without a GitHub credential (`GITHUB_TOKEN`, `GH_TOKEN`, or a logged-in `gh`).
 */
const UMBRELLA = process.env.DSH_OPENCHARLY_UMBRELLA ?? '';
const MERGED_PR = 'opencharly/dsh-opencharly#3';
const MAX_STARTS = 5;

function hasGithubCredential() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return true;
  try {
    execFileSync('gh', ['auth', 'token'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skip =
  UMBRELLA === ''
    ? 'set DSH_OPENCHARLY_UMBRELLA=<an umbrella checkout> to run the real watcher CLI'
    : !hasGithubCredential()
      ? 'no GitHub credential (GITHUB_TOKEN, GH_TOKEN or a logged-in gh) for the real GitHub read'
      : false;

test(`LIVE: a real MERGED state event (${MERGED_PR}) retires its item — one arm, and the watch ends`, { skip }, async () => {
  assert.ok(existsSync(join(UMBRELLA, 'scripts/gh/cli.ts')), `${UMBRELLA} carries scripts/gh/cli.ts`);

  const root = mkdtempSync(join(tmpdir(), 'dsh-opencharly-live-'));
  const savedRuntime = process.env.GH_WATCH_RUNTIME_DIR;
  try {
    cpSync(join(UMBRELLA, 'scripts/gh'), join(root, 'scripts/gh'), { recursive: true });
    mkdirSync(join(root, '.dsh'), { recursive: true });
    writeFileSync(join(root, '.dsh/watch.items'), `${MERGED_PR}\n`);
    process.env.GH_WATCH_RUNTIME_DIR = root;

    const logs = [];
    const listeners = [];
    let starts = 0;
    let ended;
    const done = new Promise((resolve) => (ended = resolve));
    const job = { append() {}, updateProgress() {} };
    const jobs = {
      start(spec) {
        starts += 1;
        if (starts > MAX_STARTS) {
          ended('runaway');
          return `refused-${starts}`;
        }
        spec.run(job);
        return `opencharly-watch-${starts}`;
      }
    };
    const log = (level) => (...args) => {
      const text = args.map(String).join(' ');
      logs.push({ level, text });
      if (/watch ended/.test(text)) ended('ended');
    };
    const ctx = {
      logger: () => ({ info: log('info'), warn: log('warn'), debug: log('debug'), error: log('error') }),
      effect: (fn) => fn(),
      on: (event, handler) => {
        listeners.push({ event, handler });
        return () => {};
      },
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
      sessions: { get: () => undefined },
      reflect: { get: (name) => (name === 'jobs' ? jobs : undefined) }
    };
    plugin.apply(ctx, { soul: { requireUmbrellaMarker: false }, gates: { enabled: false } });
    for (const l of listeners.filter((x) => x.event === 'session/created')) l.handler({ id: 's1', header: { cwd: root } });

    const outcome = await Promise.race([done, new Promise((resolve) => setTimeout(() => resolve('timeout'), 60000))]);
    const trace = logs.map((l) => l.text).join('\n');
    assert.equal(outcome, 'ended', `the watch must end on its own (got '${outcome}'); logs:\n${trace}`);
    assert.equal(starts, 1, `one watcher job (got ${starts}); logs:\n${trace}`);
    assert.ok(logs.some((l) => l.text.includes(`watch ended — MERGED ${MERGED_PR}`)), `the watch ended on the real MERGED event; logs:\n${trace}`);
  } finally {
    if (savedRuntime === undefined) delete process.env.GH_WATCH_RUNTIME_DIR;
    else process.env.GH_WATCH_RUNTIME_DIR = savedRuntime;
    rmSync(root, { recursive: true, force: true });
  }
});
