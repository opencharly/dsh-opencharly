import test from 'node:test';
import assert from 'node:assert/strict';

import * as plugin from '../lib/index.js';

/**
 * A fake cordis context shaped like the one `test/wiring.test.js` uses: `effect(fn)`
 * RUNS `fn` and records the disposer, exactly as cordis does, so the plugin's own
 * registration path is what the test exercises. The two services this seam reads are
 * OPTIONAL and therefore resolved through `ctx.reflect.get(name, false)`.
 */
function makeCtx({ agent = {}, goal, withAgents = true, withGoals = true } = {}) {
  const record = { listeners: [], logs: [], resumed: [] };
  const makeLog = (level) => (...args) => record.logs.push({ level, text: args.map(String).join(' ') });
  const named = {
    info: makeLog('info'),
    warn: makeLog('warn'),
    debug: makeLog('debug'),
    error: makeLog('error')
  };

  const ctx = {
    logger: () => named,
    effect(fn) {
      const dispose = fn();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    on(event, handler) {
      record.listeners.push({ event, handler });
      return () => {};
    },
    sessions: { get: () => undefined },
    reflect: {
      get(name) {
        if (name === 'agents') {
          return withAgents ? { get: (id) => (id === 's1' ? agent : undefined) } : undefined;
        }
        if (name === 'goals') {
          return withGoals
            ? {
                get: () => goal,
                resume: (a, revision) => record.resumed.push({ agent: a, revision })
              }
            : undefined;
        }
        return undefined;
      }
    }
  };
  return { ctx, record };
}

/** Apply the plugin with the other three seams disabled, then hand back the rearm listener. */
function rearmListener(options) {
  const { ctx, record } = makeCtx(options);
  plugin.apply(ctx, {
    gates: { enabled: false },
    soul: { enabled: false },
    watch: { enabled: false }
  });
  const listener = record.listeners.find((l) => l.event === 'session/event');
  assert.ok(listener, 'the plugin registered a session/event listener');
  return { listener, record };
}

// ── branch 1: an ACTIVE goal is re-armed on the human turn ───────────────────────

test('rearm: the human turn re-arms an ACTIVE goal through goals.resume', () => {
  const { listener, record } = rearmListener({ goal: { phase: 'active', revision: 7 } });
  listener.handler({ id: 's1' }, { type: 'user/message' });

  assert.equal(record.resumed.length, 1, 'goals.resume was called exactly once');
  assert.equal(record.resumed[0].revision, 7, 'the goal revision is passed through');
  assert.ok(
    record.logs.some((l) => l.text.includes('goal re-armed for the human turn')),
    'the seam says what it did'
  );
});

// ── branch 2: every non-active phase is LEFT DISARMED, with one line ─────────────

test('rearm: paused / blocked / complete goals are NOT re-armed, and the reason is named', () => {
  for (const phase of ['paused', 'blocked', 'complete']) {
    const { listener, record } = rearmListener({ goal: { phase, revision: 3 } });
    listener.handler({ id: 's1' }, { type: 'user/message' });

    assert.equal(record.resumed.length, 0, `${phase} must not be resumed`);
    assert.ok(
      record.logs.some((l) => l.text.includes(`phase '${phase}' is not 'active'`)),
      `${phase} is named in the one-line notice`
    );
  }
});

// ── the event choice IS the safety property: only user/message re-arms ───────────

test('rearm: a non-human event does not re-arm anything', () => {
  for (const type of ['assistant/message', 'turn/start', 'step/start', 'tool/call']) {
    const { listener, record } = rearmListener({ goal: { phase: 'active', revision: 1 } });
    listener.handler({ id: 's1' }, { type });
    assert.equal(record.resumed.length, 0, `${type} must not re-arm`);
  }
});

test('rearm: a session with no agent, or no goal, is a silent no-op', () => {
  const noAgent = rearmListener({ goal: { phase: 'active', revision: 1 } });
  noAgent.listener.handler({ id: 'other-session' }, { type: 'user/message' });
  assert.equal(noAgent.record.resumed.length, 0);

  const noGoal = rearmListener({ goal: undefined });
  noGoal.listener.handler({ id: 's1' }, { type: 'user/message' });
  assert.equal(noGoal.record.resumed.length, 0);
});

// ── a profile without dsh-goal must keep working ─────────────────────────────────

test('rearm: absent agents/goals services are tolerated, never thrown on', () => {
  for (const opts of [{ withAgents: false }, { withGoals: false }]) {
    const { listener, record } = rearmListener({ goal: { phase: 'active', revision: 1 }, ...opts });
    assert.doesNotThrow(() => listener.handler({ id: 's1' }, { type: 'user/message' }));
    assert.equal(record.resumed.length, 0);
  }
});

// ── the toggle ──────────────────────────────────────────────────────────────────

test('rearm: the seam is off by config and registers no session/event listener', () => {
  const { ctx, record } = makeCtx({ goal: { phase: 'active', revision: 1 } });
  plugin.apply(ctx, { rearm: { enabled: false }, gates: { enabled: false }, soul: { enabled: false }, watch: { enabled: false } });
  assert.equal(record.listeners.filter((l) => l.event === 'session/event').length, 0);
});
