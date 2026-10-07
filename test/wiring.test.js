import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plugin from '../lib/index.js';

/**
 * A fake cordis context that behaves like the real one where it matters:
 * `ctx.effect(fn, label)` RUNS `fn` and records the effect, exactly as cordis does
 * (`cordis/lib/types/fiber.d.ts:145-159`), so the plugin's own registration code path
 * is what populates the record — nothing is stubbed in its place.
 */
function makeFakeCtx({ jobs, sessions = new Map(), orders = {} } = {}) {
  const record = {
    effects: [],
    listeners: [],
    sections: [],
    logs: [],
    jobsStarted: [],
    sectionDisposals: 0,
    listenerDisposals: 0
  };

  const makeLog = (level) => (...args) => record.logs.push({ level, text: args.map(String).join(' ') });
  const namedLogger = { info: makeLog('info'), warn: makeLog('warn'), debug: makeLog('debug'), error: makeLog('error') };
  const logger = () => namedLogger;

  const ctx = {
    logger,
    effect(fn, label) {
      const dispose = fn();
      record.effects.push({ label, dispose });
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    on(event, handler) {
      record.listeners.push({ event, handler });
      return () => {
        record.listenerDisposals += 1;
      };
    },
    systemPrompt: {
      section(section) {
        record.sections.push(section);
        return () => {
          record.sectionDisposals += 1;
        };
      },
      getSectionOrder(name) {
        return orders[name] ?? 0;
      }
    },
    sessions: { get: (id) => sessions.get(id) },
    // `ctx.reflect.get(name, strict)` — "read a service ... without the inject
    // requirement" (`cordis/lib/index.js:754-765`). `jobs` is the optional one.
    reflect: { get: (name) => (name === 'jobs' ? jobs : undefined) }
  };

  return { ctx, record };
}

/** The recorded `tools/pre-execute` listener, with a `next` spy. */
function gateOf(record) {
  const entry = record.listeners.find((l) => l.event === 'tools/pre-execute');
  assert.ok(entry, 'the tools/pre-execute gate listener must be registered');
  let nextCalls = 0;
  const next = async () => {
    nextCalls += 1;
    return { kind: 'allow' };
  };
  return {
    run: (exec) => entry.handler(exec, next),
    nextCalls: () => nextCalls
  };
}

/** The recorded `session/created` listeners, in registration order. */
function sessionListeners(record) {
  return record.listeners.filter((l) => l.event === 'session/created').map((l) => l.handler);
}

/** A temp checkout with the umbrella marker, gate scripts, watcher and item list. */
function tempCheckout({ soul = null, items = null, watcher = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-opencharly-wiring-'));
  mkdirSync(join(root, '.claude/hooks'), { recursive: true });
  writeFileSync(join(root, '.claude/hooks/pre-commit-gate.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(join(root, '.claude/hooks/pre-push-gate.sh'), '#!/usr/bin/env bash\nexit 0\n');
  if (soul !== null) writeFileSync(join(root, 'SOUL.md'), soul);
  if (watcher) {
    mkdirSync(join(root, 'marketplace/scripts'), { recursive: true });
    writeFileSync(join(root, 'marketplace/scripts/gh_watch.sh'), '#!/usr/bin/env bash\nexit 0\n');
  }
  if (items !== null) {
    mkdirSync(join(root, '.dsh'), { recursive: true });
    writeFileSync(join(root, '.dsh/watch.items'), items);
  }
  return root;
}

/** A gate runner that records its calls and answers with a scripted verdict. */
function fakeGate(verdicts = [{ code: 0, stdout: '', stderr: '', error: null, aborted: false }]) {
  const calls = [];
  let index = 0;
  const runGate = async (script, payload, options) => {
    calls.push({ script, payload, options });
    const verdict = verdicts[Math.min(index, verdicts.length - 1)];
    index += 1;
    return verdict;
  };
  return { calls, runGate };
}

function bashExec(command, agent = undefined) {
  return { name: 'bash', arguments: { command }, ...(agent !== undefined ? { agent } : {}) };
}

// ── the export shape, matched against the two installed, loading plugins ─────────

test('the module exports the shape the installed third-party plugins export', () => {
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(plugin.name, 'dsh-opencharly');
  assert.ok(Array.isArray(plugin.inject));
  assert.deepEqual([...plugin.inject].sort(), ['sessions', 'systemPrompt', 'tools']);
  assert.equal(typeof plugin.normalizeConfig, 'function');
  assert.equal(typeof plugin.runGateScript, 'function');
  assert.equal(typeof plugin.spawnWatcherProcess, 'function');
});

// ── the three seams all register ─────────────────────────────────────────────────

test('apply() registers ALL THREE seams', () => {
  const { ctx, record } = makeFakeCtx();
  plugin.apply(ctx, {});

  // Seam 1 — the git gate.
  assert.ok(
    record.listeners.some((l) => l.event === 'tools/pre-execute'),
    'SEAM 1 (git gates): no tools/pre-execute listener registered'
  );
  // Seam 2 — the SOUL identity.
  assert.ok(
    record.sections.some((s) => s.name === 'charly:soul'),
    'SEAM 2 (SOUL injection): no systemPrompt section registered'
  );
  // Seam 3 — the session-start watch auto-arm.
  assert.ok(
    record.listeners.some((l) => l.event === 'session/created'),
    'SEAM 3 (watch auto-arm): no session/created listener registered'
  );

  // Every registration lives in an effect, so disposal reverses it.
  const labels = record.effects.map((e) => e.label);
  for (const label of ['dsh-opencharly.gates', 'dsh-opencharly.soul', 'dsh-opencharly.watch']) {
    assert.ok(labels.includes(label), `no effect labelled ${label}`);
  }
});

test('the three-seam assertion is not vacuous: a disabled seam really is absent', () => {
  const cases = [
    { config: { gates: { enabled: false } }, event: 'tools/pre-execute', what: 'gate' },
    { config: { soul: { enabled: false } }, section: 'charly:soul', what: 'soul' },
    { config: { watch: { enabled: false } }, listenerCount: 1, what: 'watch' }
  ];
  for (const { config, event, section, listenerCount } of cases) {
    const { ctx, record } = makeFakeCtx();
    plugin.apply(ctx, config);
    if (event !== undefined) {
      assert.equal(record.listeners.some((l) => l.event === event), false, config && 'gate');
      assert.ok(record.logs.some((l) => /DISABLED/.test(l.text)), 'the disabled seam must say so');
    }
    if (section !== undefined) {
      assert.equal(record.sections.some((s) => s.name === section), false);
      assert.ok(record.logs.some((l) => /DISABLED/.test(l.text)));
    }
    if (listenerCount !== undefined) {
      // Only the always-on session-root tracker remains.
      assert.equal(record.listeners.filter((l) => l.event === 'session/created').length, listenerCount);
      assert.ok(record.logs.some((l) => /DISABLED/.test(l.text)));
    }
  }
});

test('the SOUL section carries the resolved order and opts out of interpolation', () => {
  const { ctx, record } = makeFakeCtx({ orders: { DEPLOYMENT_PERSONA_PREFIX: 0, HARNESS_IDENTITY: -1000 } });
  plugin.apply(ctx, {});
  const section = record.sections[0];
  assert.equal(section.name, 'charly:soul');
  assert.equal(section.order, 0);
  assert.equal(section.interpolate, false);
  assert.equal(typeof section.text, 'function', 'text must be a provider, re-read every assembly');
});

// ── SEAM 1: the git gate, end to end through the registered listener ────────────

test('SEAM 1 blocks by DELEGATING to the push gate, not by re-implementing it', async () => {
  const root = tempCheckout();
  const sessions = new Map([['s1', { header: { cwd: root } }]]);
  const gate = fakeGate([{ code: 2, stdout: '', stderr: 'pre-push-gate BLOCKED: force-push is forbidden', error: null, aborted: false }]);
  const { ctx, record } = makeFakeCtx({ sessions });
  plugin.apply(ctx, {}, { runGate: gate.runGate });
  try {
    const decision = await gateOf(record).run(bashExec('git push --force origin main', { sessionId: 's1' }));
    assert.deepEqual(decision, {
      kind: 'deny',
      reason: 'pre-push-gate BLOCKED: force-push is forbidden'
    });
    assert.equal(gate.calls.length, 1);
    assert.equal(gate.calls[0].script, join(root, '.claude/hooks/pre-push-gate.sh'));
    assert.deepEqual(gate.calls[0].payload, { tool_input: { command: 'git push --force origin main' } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 1 runs EVERY gate a compound command calls for, push before commit', async () => {
  const root = tempCheckout();
  const sessions = new Map([['s1', { header: { cwd: root } }]]);
  const gate = fakeGate([{ code: 0, stdout: '', stderr: '', error: null, aborted: false }]);
  const { ctx, record } = makeFakeCtx({ sessions });
  plugin.apply(ctx, {}, { runGate: gate.runGate });
  try {
    const handle = gateOf(record);
    const decision = await handle.run(bashExec('git commit -m x && git push origin main', { sessionId: 's1' }));
    assert.deepEqual(decision, { kind: 'allow' });
    assert.deepEqual(gate.calls.map((c) => c.script), [
      join(root, '.claude/hooks/pre-push-gate.sh'),
      join(root, '.claude/hooks/pre-commit-gate.sh')
    ]);
    assert.equal(handle.nextCalls(), 1, 'an allowing gate set delegates exactly once');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 1 delegates with next() for a non-bash exec and never calls a gate', async () => {
  const root = tempCheckout();
  const gate = fakeGate();
  const { ctx, record } = makeFakeCtx();
  plugin.apply(ctx, { gates: { root } }, { runGate: gate.runGate });
  try {
    for (const exec of [undefined, 'bash', { name: 'read' }, { name: 'grep', arguments: { pattern: 'git push' } }]) {
      const handle = gateOf(record);
      assert.deepEqual(await handle.run(exec), { kind: 'allow' });
      assert.equal(handle.nextCalls(), 1);
    }
    assert.equal(gate.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 1 delegates for a safe command and never calls a gate', async () => {
  const root = tempCheckout();
  const gate = fakeGate();
  const { ctx, record } = makeFakeCtx();
  plugin.apply(ctx, { gates: { root } }, { runGate: gate.runGate });
  try {
    for (const command of ['git status', 'git log --oneline', 'ls -la', 'echo "git push origin main"']) {
      const handle = gateOf(record);
      assert.deepEqual(await handle.run(bashExec(command)), { kind: 'allow' }, command);
      assert.equal(handle.nextCalls(), 1, command);
    }
    assert.equal(gate.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 1 SKIPS VISIBLY — never blocks — when the gate scripts cannot be found', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'dsh-opencharly-nogates-'));
  const gate = fakeGate();
  const { ctx, record } = makeFakeCtx();
  plugin.apply(ctx, { gates: { root: empty } }, { runGate: gate.runGate });
  try {
    const handle = gateOf(record);
    const decision = await handle.run(bashExec('git push --force origin main'));
    assert.deepEqual(decision, { kind: 'allow' }, 'R7a: no script means NO fabricated block');
    assert.equal(handle.nextCalls(), 1);
    assert.equal(gate.calls.length, 0, 'no gate script may be invented');
    const skip = record.logs.find((l) => l.level === 'warn' && /git gate SKIPPED/.test(l.text));
    assert.ok(skip, 'the skip must be logged, not silent');
    assert.match(skip.text, /no pre-commit-gate\.sh \/ pre-push-gate\.sh found/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('SEAM 1 logs a HALF-resolved gate set as skipped and still runs the present one', async () => {
  const root = tempCheckout();
  rmSync(join(root, '.claude/hooks/pre-push-gate.sh'));
  const gate = fakeGate([{ code: 0, stdout: '', stderr: '', error: null, aborted: false }]);
  const { ctx, record } = makeFakeCtx();
  plugin.apply(ctx, { gates: { root } }, { runGate: gate.runGate });
  try {
    const handle = gateOf(record);
    assert.deepEqual(await handle.run(bashExec('git push origin main')), { kind: 'allow' });
    assert.equal(gate.calls.length, 0, 'the missing push gate is skipped, not run');
    assert.ok(record.logs.some((l) => l.level === 'warn' && /push gate SKIPPED/.test(l.text)));

    assert.deepEqual(await handle.run(bashExec('git commit -m x')), { kind: 'allow' });
    assert.equal(gate.calls.length, 1, 'the present commit gate still runs');
    assert.equal(gate.calls[0].script, join(root, '.claude/hooks/pre-commit-gate.sh'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 1 treats an ANOMALOUS gate exit as no verdict: visible, never a fabricated block', async () => {
  const root = tempCheckout();
  const { ctx, record } = makeFakeCtx();
  plugin.apply(
    ctx,
    { gates: { root } },
    { runGate: async () => ({ code: 1, stdout: 'junk', stderr: 'python3: not found', error: null, aborted: false }) }
  );
  try {
    const handle = gateOf(record);
    assert.deepEqual(await handle.run(bashExec('git push origin main')), { kind: 'allow' });
    assert.ok(record.logs.some((l) => l.level === 'warn' && /gave no verdict/.test(l.text)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 1 can be configured to fail CLOSED on an anomalous gate', async () => {
  const root = tempCheckout();
  const { ctx, record } = makeFakeCtx();
  plugin.apply(
    ctx,
    { gates: { root, onGateError: 'deny' } },
    { runGate: async () => ({ code: null, stdout: '', stderr: '', error: 'gate timed out after 15000ms', aborted: false }) }
  );
  try {
    const decision = await gateOf(record).run(bashExec('git push origin main'));
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /gate timed out after 15000ms/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 1 never breaks dispatch when a gate runner throws', async () => {
  const root = tempCheckout();
  const { ctx, record } = makeFakeCtx();
  plugin.apply(ctx, { gates: { root } }, {
    runGate: async () => {
      throw new Error('spawn EACCES');
    }
  });
  try {
    const handle = gateOf(record);
    assert.deepEqual(await handle.run(bashExec('git commit -m x')), { kind: 'allow' });
    assert.equal(handle.nextCalls(), 1);
    assert.ok(record.logs.some((l) => l.level === 'warn' && /git gate errored/.test(l.text)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 1 hands the gate runner its deadline and the caller cancellation signal', async () => {
  const root = tempCheckout();
  const gate = fakeGate();
  const controller = new AbortController();
  const { ctx, record } = makeFakeCtx();
  plugin.apply(ctx, { gates: { root, timeoutMs: 4321 } }, { runGate: gate.runGate });
  try {
    await gateOf(record).run({ name: 'bash', arguments: { command: 'git push' }, signal: controller.signal });
    assert.equal(gate.calls[0].options.timeoutMs, 4321);
    assert.equal(gate.calls[0].options.signal, controller.signal, 'gates must observe exec.signal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── SEAM 2: the SOUL identity ───────────────────────────────────────────────────

test('SEAM 2 injects the project-root SOUL.md, resolved from the session cwd', () => {
  const root = tempCheckout({ soul: '# SOUL.md — Who You Are\n\nYou are charly.\n' });
  const { ctx, record } = makeFakeCtx();
  plugin.apply(ctx, {});
  try {
    for (const onCreated of sessionListeners(record)) {
      onCreated({ id: 's1', header: { cwd: root, isSeeded: false, version: 3, createdAt: 0 } });
    }
    const section = record.sections.find((s) => s.name === 'charly:soul');
    const text = section.text({});
    assert.match(text, /^## Who you are — SOUL\.md\n\n# SOUL\.md — Who You Are\n\nYou are charly\.\n$/);
    assert.ok(record.logs.some((l) => l.level === 'info' && /injecting charly:soul from/.test(l.text)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 2 emits the VISIBLE content-loss warning when SOUL.md is absent', () => {
  const root = tempCheckout({ soul: null });
  const { ctx, record } = makeFakeCtx();
  plugin.apply(ctx, {});
  try {
    for (const onCreated of sessionListeners(record)) {
      onCreated({ id: 's1', header: { cwd: root, isSeeded: false, version: 3, createdAt: 0 } });
    }
    const text = record.sections[0].text({});
    assert.match(text, /SOUL\.md is NOT present at the project root/);
    assert.ok(record.logs.some((l) => l.level === 'warn' && /SOUL is ABSENT/.test(l.text)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 2 stays out of a checkout that is not an OpenCharly umbrella', () => {
  const plain = mkdtempSync(join(tmpdir(), 'dsh-opencharly-plain-'));
  writeFileSync(join(plain, 'SOUL.md'), 'someone else identity\n');
  const { ctx, record } = makeFakeCtx();
  plugin.apply(ctx, {});
  try {
    for (const onCreated of sessionListeners(record)) {
      onCreated({ id: 's1', header: { cwd: plain, isSeeded: false, version: 3, createdAt: 0 } });
    }
    assert.equal(record.sections[0].text({}), '');
    assert.ok(record.logs.some((l) => l.level === 'info' && /not an OpenCharly umbrella checkout/.test(l.text)));
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test('SEAM 2 never breaks prompt assembly when the provider throws', () => {
  const { ctx, record } = makeFakeCtx();
  plugin.apply(ctx, { soul: { requireUmbrellaMarker: false } });
  const exploding = {
    header: {
      get cwd() {
        throw new Error('poisoned session header');
      }
    }
  };
  try {
    for (const onCreated of sessionListeners(record)) onCreated(exploding);
    assert.equal(typeof record.sections[0].text({}), 'string');
  } finally {
    /* the provider must have survived; assert the section is still usable */
    assert.ok(record.sections[0].text({}).length > 0);
  }
});

// ── SEAM 3: the session-start watch auto-arm ─────────────────────────────────────

/** A jobs service stand-in that records starts and exposes the produced hooks. */
function fakeJobs() {
  const started = [];
  return {
    started,
    service: {
      start(spec) {
        started.push(spec);
        return `opencharly-watch-${started.length}`;
      }
    }
  };
}

/** A watcher producer stand-in that records its argv and hands back controllable hooks. */
function fakeSpawner() {
  const calls = [];
  const settle = [];
  const append = [];
  const producer = (argv, options) => {
    calls.push({ argv, cwd: options.cwd });
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    settle.push((outcome) => resolveDone(outcome));
    return {
      cancel: (reason) => resolveDone({ status: 'killed', detail: reason ?? 'cancelled' }),
      done
    };
  };
  return { calls, settle, producer, append };
}

test('SEAM 3 arms gh_watch.sh as a JOB from .dsh/watch.items, with the exact argv', () => {
  const root = tempCheckout({ items: '# comment\n\nopencharly/opencharly#359\nopencharly/marketplace/pull/42\n' });
  const jobs = fakeJobs();
  const spawner = fakeSpawner();
  const { ctx, record } = makeFakeCtx({ jobs: jobs.service });
  plugin.apply(ctx, {}, { spawnWatcher: spawner.producer });
  try {
    for (const onCreated of sessionListeners(record)) {
      onCreated({ id: 's1', header: { cwd: root, isSeeded: false, version: 3, createdAt: 0 } });
    }

    assert.equal(jobs.started.length, 1, 'exactly one job per session');
    const spec = jobs.started[0];
    assert.equal(spec.kind, 'opencharly-watch');
    assert.match(spec.label, /gh_watch 2 item\(s\): opencharly\/opencharly#359 opencharly\/marketplace\/pull\/42/);

    // The job body delegates to the watcher producer with the built argv.
    const job = { append() {}, updateProgress() {} };
    spec.run(job);
    assert.equal(spawner.calls.length, 1);
    assert.equal(spawner.calls[0].cwd, root);
    assert.deepEqual(spawner.calls[0].argv, [
      join(root, 'marketplace/scripts/gh_watch.sh'),
      '--events', 'comment,verdict,merged,closed,stall',
      '--interval', '60',
      '--stallmin', '60',
      '--workflow', 'charly/pr-validator',
      '--auto-rearm',
      'opencharly/opencharly#359',
      'opencharly/marketplace/pull/42'
    ]);
    assert.ok(record.logs.some((l) => /armed job opencharly-watch-1 watching 2 item\(s\)/.test(l.text)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 3 is INERT — and says so — on a comment-only item list', () => {
  const root = tempCheckout({ items: '# watch.items — inert by default\n# acme/widget#12\n' });
  const jobs = fakeJobs();
  const spawner = fakeSpawner();
  const { ctx, record } = makeFakeCtx({ jobs: jobs.service });
  plugin.apply(ctx, {}, { spawnWatcher: spawner.producer });
  try {
    for (const onCreated of sessionListeners(record)) onCreated({ id: 's1', header: { cwd: root } });
    assert.equal(jobs.started.length, 0, 'a comment-only list must arm nothing');
    assert.equal(spawner.calls.length, 0);
    assert.ok(record.logs.some((l) => l.level === 'info' && /watch INERT/.test(l.text)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 3 is inert when the item list is absent', () => {
  const root = tempCheckout({ items: null });
  const jobs = fakeJobs();
  const { ctx, record } = makeFakeCtx({ jobs: jobs.service });
  plugin.apply(ctx, {}, { spawnWatcher: fakeSpawner().producer });
  try {
    for (const onCreated of sessionListeners(record)) onCreated({ id: 's1', header: { cwd: root } });
    assert.equal(jobs.started.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 3 SKIPS VISIBLY when the watcher script is missing (stale marketplace pin)', () => {
  const root = tempCheckout({ items: 'opencharly/opencharly#359\n', watcher: false });
  const jobs = fakeJobs();
  const { ctx, record } = makeFakeCtx({ jobs: jobs.service });
  plugin.apply(ctx, {}, { spawnWatcher: fakeSpawner().producer });
  try {
    for (const onCreated of sessionListeners(record)) onCreated({ id: 's1', header: { cwd: root } });
    assert.equal(jobs.started.length, 0);
    assert.ok(record.logs.some((l) => l.level === 'warn' && /gh_watch\.sh not found/.test(l.text)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 3 SKIPS VISIBLY when no job controller serves unowned work', () => {
  const root = tempCheckout({ items: 'opencharly/opencharly#359\n' });
  const { ctx, record } = makeFakeCtx({ jobs: undefined });
  plugin.apply(ctx, {}, { spawnWatcher: fakeSpawner().producer });
  try {
    for (const onCreated of sessionListeners(record)) onCreated({ id: 's1', header: { cwd: root } });
    const skip = record.logs.find((l) => l.level === 'warn' && /no job controller/.test(l.text));
    assert.ok(skip, 'a missing jobs seam must be a visible skip');
    assert.match(skip.text, /dsh-tool-jobs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 3 SKIPS VISIBLY when the job registry refuses the start', () => {
  const root = tempCheckout({ items: 'opencharly/opencharly#359\n' });
  const { ctx, record } = makeFakeCtx({
    jobs: {
      start() {
        throw new Error('cannot get property "jobs" without inject');
      }
    }
  });
  plugin.apply(ctx, {}, { spawnWatcher: fakeSpawner().producer });
  try {
    for (const onCreated of sessionListeners(record)) onCreated({ id: 's1', header: { cwd: root } });
    assert.ok(record.logs.some((l) => l.level === 'warn' && /job registry refused the start/.test(l.text)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 3 never arms for a subagent child session', () => {
  const root = tempCheckout({ items: 'opencharly/opencharly#359\n' });
  const jobs = fakeJobs();
  const { ctx, record } = makeFakeCtx({ jobs: jobs.service });
  plugin.apply(ctx, {}, { spawnWatcher: fakeSpawner().producer });
  try {
    for (const onCreated of sessionListeners(record)) {
      onCreated({ id: 'child', header: { cwd: root, origin: 'subagent', delegationDepth: 1 } });
    }
    assert.equal(jobs.started.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 3 does not double-arm a root while its watcher is live, and re-arms once it settles', async () => {
  const root = tempCheckout({ items: 'opencharly/opencharly#359\n' });
  const jobs = fakeJobs();
  const spawner = fakeSpawner();
  const { ctx, record } = makeFakeCtx({ jobs: jobs.service });
  plugin.apply(ctx, {}, { spawnWatcher: spawner.producer });
  try {
    const onCreated = sessionListeners(record);
    for (const listener of onCreated) listener({ id: 's1', header: { cwd: root } });
    assert.equal(jobs.started.length, 1);

    for (const listener of onCreated) listener({ id: 's2', header: { cwd: root } });
    assert.equal(jobs.started.length, 1, 'a live watcher must not be duplicated');
    assert.ok(record.logs.some((l) => /watch already armed for/.test(l.text)));

    // Settle the standing job (a STATE fire: the session is woken, the watch ends).
    jobs.started[0].run({ append() {}, updateProgress() {} });
    await spawner.settle[0]({ status: 'completed', detail: 'exit code: 0' });
    await new Promise((resolve) => setImmediate(resolve));

    for (const listener of onCreated) listener({ id: 's3', header: { cwd: root } });
    assert.equal(jobs.started.length, 2, 'a settled watcher must be re-armable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEAM 3 never throws out of session/created, which vetoes on a throw', () => {
  const { ctx, record } = makeFakeCtx();
  ctx.reflect.get = () => {
    throw new Error('the jobs service is unavailable');
  };
  plugin.apply(ctx, { soul: { requireUmbrellaMarker: false } });
  const poisoned = [
    undefined,
    null,
    {},
    { header: null },
    { header: { get cwd() { throw new Error('poisoned header'); } } }
  ];
  for (const session of poisoned) {
    for (const onCreated of sessionListeners(record)) {
      assert.doesNotThrow(() => onCreated(session), 'a throwing session/created listener vetoes the session');
    }
  }
  assert.ok(record.logs.some((l) => l.level === 'warn'), 'a skip must leave a visible trace');
});

// ── the real (uninjected) wiring: apply() with no deps must still register ───────

test('apply() with no injected deps still registers all three seams and stays inert', () => {
  const { ctx, record } = makeFakeCtx();
  plugin.apply(ctx);
  assert.ok(record.listeners.some((l) => l.event === 'tools/pre-execute'));
  assert.ok(record.listeners.some((l) => l.event === 'session/created'));
  assert.ok(record.sections.some((s) => s.name === 'charly:soul'));
});
