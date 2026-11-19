import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';

/**
 * LIVE: the plugin's REAL watch wiring — `apply()`, `spawnWatcherProcess` and
 * `loadEngineStateEvents`, nothing injected — runs the umbrella's REAL watcher CLI and
 * imports its REAL engine (`scripts/gh/`, copied from the checkout named by
 * `DSH_OPENCHARLY_UMBRELLA`), against a local GitHub that always serves a PR in conflict
 * with its base.
 *
 * The property is the one the pi binding broke (opencharly/opencharly#1163): a state
 * event fires from the arm baseline and `--no-arm-wake` does not suppress it, so a
 * binding that re-armed a CONFLICT item would hot-loop — a request and a wake every few
 * seconds. Correct: ONE arm, ONE request, and the watch ends.
 *
 * Only the DSH host is stood in for (the job controller runs a job at start, as the real
 * one does); a live run inside `dsh` itself is evidence for the PR, not a unit of this suite.
 * Skipped visibly when `DSH_OPENCHARLY_UMBRELLA` is unset.
 */
const UMBRELLA = process.env.DSH_OPENCHARLY_UMBRELLA ?? '';

test('LIVE: a CONFLICT wake from the real CLI retires its item — one arm, one request, the watch ends', { skip: UMBRELLA === '' ? 'set DSH_OPENCHARLY_UMBRELLA=<an umbrella checkout> to run the real watcher CLI' : false }, async () => {
  assert.ok(existsSync(join(UMBRELLA, 'scripts/gh/cli.ts')), `${UMBRELLA} carries scripts/gh/cli.ts`);

  let requests = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' });
      if (req.url !== '/graphql') return res.end('{}');
      requests += 1;
      const data = {};
      for (const [, n] of JSON.parse(body).query.matchAll(/\bi(\d+):/g)) {
        data[`i${n}`] = {
          pullRequest: {
            state: 'OPEN', merged: false, mergeable: 'CONFLICTING', updatedAt: new Date().toISOString(), headRefOid: 'h1',
            comments: { totalCount: 0, nodes: [] },
            commits: { nodes: [{ commit: { oid: 'h1', checkSuites: { nodes: [] } } }] }
          },
          issue: null
        };
      }
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const root = mkdtempSync(join(tmpdir(), 'dsh-opencharly-live-'));
  const saved = { GITHUB_API_URL: process.env.GITHUB_API_URL, GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_WATCH_RUNTIME_DIR: process.env.GH_WATCH_RUNTIME_DIR };
  try {
    cpSync(join(UMBRELLA, 'scripts/gh'), join(root, 'scripts/gh'), { recursive: true });
    mkdirSync(join(root, '.dsh'), { recursive: true });
    writeFileSync(join(root, '.dsh/watch.items'), 'acme/widget#1\n');
    process.env.GITHUB_API_URL = `http://127.0.0.1:${server.address().port}`;
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.GH_WATCH_RUNTIME_DIR = root;

    const logs = [];
    const listeners = [];
    const started = [];
    const job = { append() {}, updateProgress() {} };
    const jobs = {
      start(spec) {
        started.push(spec);
        spec.run(job);
        return `opencharly-watch-${started.length}`;
      }
    };
    const log = (level) => (...args) => logs.push({ level, text: args.map(String).join(' ') });
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

    // Several re-arm cycles' worth of time, far below the 300 s poll floor: a hot-loop
    // makes many requests here, a correct binding exactly one.
    await new Promise((resolve) => setTimeout(resolve, 15000));

    assert.equal(started.length, 1, `one watcher job (got ${started.length}); logs:\n${logs.map((l) => l.text).join('\n')}`);
    assert.equal(requests, 1, `one GraphQL request (got ${requests})`);
    assert.ok(logs.some((l) => /watch ended — CONFLICT acme\/widget#1/.test(l.text)), `the watch ended on the CONFLICT; logs:\n${logs.map((l) => l.text).join('\n')}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
