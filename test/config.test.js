import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, normalizeConfig, resolveProjectRoot } from '../lib/config.js';

test('normalizeConfig fills every default when config is absent', () => {
  assert.deepEqual(normalizeConfig(undefined), {
    projectRoot: '',
    gates: { ...DEFAULT_CONFIG.gates },
    soul: { ...DEFAULT_CONFIG.soul },
    watch: { ...DEFAULT_CONFIG.watch }
  });
});

test('normalizeConfig accepts null, arrays, scalars and empty objects', () => {
  for (const raw of [null, [], 7, 'nope', true, {}]) {
    assert.deepEqual(normalizeConfig(raw), normalizeConfig(undefined), `raw=${JSON.stringify(raw)}`);
  }
});

test('normalizeConfig keeps a well-formed override and defaults the rest', () => {
  const config = normalizeConfig({
    projectRoot: '/umbrella',
    gates: { enabled: false, onGateError: 'deny', timeoutMs: 2500 },
    soul: { order: -500, maxBytes: 1024 },
    watch: { intervalSec: 120, autoRearm: false, events: 'merged,stall' }
  });
  assert.equal(config.projectRoot, '/umbrella');
  assert.equal(config.gates.enabled, false);
  assert.equal(config.gates.onGateError, 'deny');
  assert.equal(config.gates.timeoutMs, 2500);
  assert.equal(config.gates.root, '');
  assert.equal(config.soul.order, -500);
  assert.equal(config.soul.maxBytes, 1024);
  assert.equal(config.soul.sectionName, DEFAULT_CONFIG.soul.sectionName);
  assert.equal(config.watch.intervalSec, 120);
  assert.equal(config.watch.autoRearm, false);
  assert.equal(config.watch.events, 'merged,stall');
  assert.equal(config.watch.stallMin, DEFAULT_CONFIG.watch.stallMin);
});

test('normalizeConfig replaces a wrong-typed value with its default instead of throwing', () => {
  const config = normalizeConfig({
    projectRoot: 42,
    gates: { enabled: 'yes', root: null, timeoutMs: -1, onGateError: 'explode' },
    soul: { enabled: 0, path: [], order: 'first', maxBytes: 'lots' },
    watch: { intervalSec: '60', autoRearm: 'true', jobKind: {} }
  });
  assert.equal(config.projectRoot, DEFAULT_CONFIG.projectRoot);
  // A negative timeout is finite and therefore accepted as given; the caller owns it.
  assert.equal(config.gates.timeoutMs, -1);
  assert.equal(config.gates.enabled, DEFAULT_CONFIG.gates.enabled);
  assert.equal(config.gates.root, DEFAULT_CONFIG.gates.root);
  assert.equal(config.gates.onGateError, 'allow');
  assert.equal(config.soul.enabled, DEFAULT_CONFIG.soul.enabled);
  assert.equal(config.soul.path, DEFAULT_CONFIG.soul.path);
  assert.equal(config.soul.order, null);
  assert.equal(config.soul.maxBytes, DEFAULT_CONFIG.soul.maxBytes);
  assert.equal(config.watch.intervalSec, DEFAULT_CONFIG.watch.intervalSec);
  assert.equal(config.watch.autoRearm, DEFAULT_CONFIG.watch.autoRearm);
  assert.equal(config.watch.jobKind, DEFAULT_CONFIG.watch.jobKind);
});

test('normalizeConfig drops unknown keys so a typo cannot masquerade as a knob', () => {
  const config = normalizeConfig({ gates: { onGateErr: 'deny', enable: false } });
  assert.equal(config.gates.onGateError, 'allow');
  assert.equal(config.gates.enabled, true);
  assert.equal('onGateErr' in config.gates, false);
  assert.equal('enable' in config.gates, false);
});

test('normalizeConfig never mutates the frozen defaults', () => {
  const before = JSON.stringify(DEFAULT_CONFIG);
  const config = normalizeConfig({ watch: { events: 'merged' } });
  config.watch.events = 'nothing';
  config.soul.enabled = false;
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), true);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.watch), true);
});

test('resolveProjectRoot takes the first non-blank candidate in the documented order', () => {
  assert.equal(
    resolveProjectRoot({ explicitRoot: '/config', sessionRoot: '/session', envDir: '/env', cwd: '/cwd' }),
    '/config'
  );
  assert.equal(resolveProjectRoot({ sessionRoot: '/session', envDir: '/env', cwd: '/cwd' }), '/session');
  assert.equal(resolveProjectRoot({ envDir: '/env', cwd: '/cwd' }), '/env');
  assert.equal(resolveProjectRoot({ cwd: '/cwd' }), '/cwd');
});

test('resolveProjectRoot skips blanks and nulls, and returns null when nothing is usable', () => {
  assert.equal(resolveProjectRoot({ explicitRoot: '   ', sessionRoot: '', envDir: '\t', cwd: ' /real ' }), '/real');
  assert.equal(resolveProjectRoot({ explicitRoot: '  ', sessionRoot: null, envDir: null, cwd: null }), null);
  assert.equal(resolveProjectRoot(), null);
  assert.equal(resolveProjectRoot({ sessionRoot: 12, envDir: {}, cwd: [] }), null);
});
