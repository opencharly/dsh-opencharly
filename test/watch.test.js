import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WATCH_SCRIPT,
  ENGINE_RELATIVE,
  WATCH_ITEMS_RELATIVE,
  buildWatcherArgv,
  decideRearm,
  itemKey,
  normalizeWatchItem,
  parseWatchItems
} from '../lib/watch.js';

// ── normalizeWatchItem ───────────────────────────────────────────────────────────

test('normalizeWatchItem accepts every documented form', () => {
  for (const item of [
    'owner/repo#12',
    'opencharly/opencharly#359',
    'owner/repo/pull/12',
    'owner/repo/issues/12',
    'https://github.com/owner/repo/pull/12',
    'http://github.com/owner/repo/issues/12',
    'https://github.com/owner/repo#12'
  ]) {
    assert.equal(normalizeWatchItem(item), item, item);
  }
});

test('normalizeWatchItem trims surrounding whitespace', () => {
  assert.equal(normalizeWatchItem('  owner/repo#12\t'), 'owner/repo#12');
});

test('normalizeWatchItem rejects anything malformed', () => {
  for (const item of [
    '',
    '   ',
    'owner/repo',
    'owner/repo#',
    'owner/repo#abc',
    'owner/repo/12',
    'owner/repo/commits/12',
    'owner/repo#12 extra',
    'just some prose',
    'https://gitlab.com/owner/repo/pull/12',
    null,
    undefined,
    42,
    {}
  ]) {
    assert.equal(normalizeWatchItem(item), null, JSON.stringify(item));
  }
});

// ── parseWatchItems ──────────────────────────────────────────────────────────────

test('parseWatchItems drops blank lines and # comments, preserving order', () => {
  const text = [
    '# a comment',
    '',
    '   ',
    'opencharly/opencharly#359',
    '  # an indented comment',
    'opencharly/marketplace/pull/42',
    'https://github.com/opencharly/.github/issues/7',
    'not an item',
    'opencharly/charly#1'
  ].join('\n');
  assert.deepEqual(parseWatchItems(text), [
    'opencharly/opencharly#359',
    'opencharly/marketplace/pull/42',
    'https://github.com/opencharly/.github/issues/7',
    'opencharly/charly#1'
  ]);
});

test('parseWatchItems: a comment-only list is INERT (the shipped default)', () => {
  const text = [
    '# watch.items — the PR/issue items a DSH session watches.',
    '#',
    '# acme/widget#12',
    '#   owner/repo/pull/9',
    '#'
  ].join('\n');
  assert.deepEqual(parseWatchItems(text), []);
});

test('parseWatchItems: absent/empty/whitespace-only input is inert', () => {
  assert.deepEqual(parseWatchItems(''), []);
  assert.deepEqual(parseWatchItems('\n\n  \n'), []);
  assert.deepEqual(parseWatchItems(null), []);
  assert.deepEqual(parseWatchItems(undefined), []);
  assert.deepEqual(parseWatchItems(42), []);
});

test('parseWatchItems treats # as a comment only at the start of a line', () => {
  // A `#` inside an item belongs to `owner/repo#num` and is NOT a comment.
  assert.deepEqual(parseWatchItems('owner/repo#12'), ['owner/repo#12']);
  // A trailing prose comment after an item makes the line malformed, so it is
  // dropped — the same outcome the canonical `.pi/extensions/watch.ts:135`
  // validator produces, because item text must survive a round trip verbatim.
  assert.deepEqual(parseWatchItems('owner/repo#12 # trailing prose'), []);
});

test('parseWatchItems preserves duplicates, exactly as the pi binding hands them over', () => {
  assert.deepEqual(parseWatchItems('a/b#1\na/b#1\n'), ['a/b#1', 'a/b#1']);
});

test('parseWatchItems parses the umbrella watch.items header block to nothing', () => {
  // Verbatim shape of the shipped `.dsh/watch.items` header: prose lines that start
  // with `#`, one blank line between paragraphs, and one commented-out example item.
  const text = [
    '# watch.items — the PR/issue items a DSH session watches through the',
    '# ONE watcher every harness uses, `node scripts/gh/cli.ts watch`.',
    '#',
    '# One item per line: `owner/repo#num`, `owner/repo/pull/num`,',
    '# `owner/repo/issues/num`, or a full https://github.com/owner/repo/(pull|issues)/num',
    '# URL. Blank lines and lines starting with `#` are ignored. This is the SAME',
    '# grammar `.pi/watch.items`, `.reasonix/watch.items` and `.dsh/watch.items`',
    '# use, so an item list is portable between harnesses.',
    '#',
    '# acme/widget#12'
  ].join('\n');
  assert.deepEqual(parseWatchItems(text), []);
  // …and the same file with the example line UNCOMMENTED arms exactly one item,
  // which proves the header block above is inert for the right reason.
  assert.deepEqual(parseWatchItems(text.replace('# acme/widget#12', 'acme/widget#12')), ['acme/widget#12']);
});

// ── buildWatcherArgv ─────────────────────────────────────────────────────────────

test('buildWatcherArgv produces the exact CLI vector', () => {
  assert.deepEqual(
    buildWatcherArgv(['opencharly/opencharly#359', 'opencharly/marketplace/pull/42'], {
      scriptPath: '/umbrella/scripts/gh/cli.ts',
      events: 'comment,verdict,merged,closed,conflict,stall',
      intervalSec: 300,
      stallMin: 60,
      workflow: 'charly/pr-validator',
      timeoutSec: 0
    }),
    [
      '/umbrella/scripts/gh/cli.ts',
      'watch',
      '--events', 'comment,verdict,merged,closed,conflict,stall',
      '--interval', '300',
      '--stallmin', '60',
      '--workflow', 'charly/pr-validator',
      'opencharly/opencharly#359',
      'opencharly/marketplace/pull/42'
    ]
  );
});

test('buildWatcherArgv omits --timeout at 0 and emits it above 0', () => {
  const base = { scriptPath: 'cli.ts', events: 'merged', intervalSec: 300, stallMin: 60, workflow: 'wf' };
  assert.equal(buildWatcherArgv(['a/b#1'], { ...base, timeoutSec: 0 }).includes('--timeout'), false);
  assert.deepEqual(buildWatcherArgv(['a/b#1'], { ...base, timeoutSec: 600 }), [
    'cli.ts', 'watch', '--events', 'merged', '--interval', '300', '--stallmin', '60', '--workflow', 'wf',
    '--timeout', '600', 'a/b#1'
  ]);
});

test('buildWatcherArgv adds --no-arm-wake only on a re-arm (an explicit true)', () => {
  const argv = (noArmWake) => buildWatcherArgv(['a/b#1'], { scriptPath: 'cli.ts', noArmWake });
  assert.equal(argv(true).includes('--no-arm-wake'), true);
  // The FIRST arm must report a verdict already on the head, so the default never suppresses it.
  assert.equal(argv(false).includes('--no-arm-wake'), false);
  assert.equal(argv(undefined).includes('--no-arm-wake'), false);
});

test('buildWatcherArgv defaults to the org watcher CLI', () => {
  assert.deepEqual(buildWatcherArgv(['a/b#1']).slice(0, 2), [DEFAULT_WATCH_SCRIPT, 'watch']);
  assert.equal(DEFAULT_WATCH_SCRIPT, 'scripts/gh/cli.ts');
  assert.equal(ENGINE_RELATIVE, 'scripts/gh/lib/watch.ts');
  assert.equal(WATCH_ITEMS_RELATIVE, '.dsh/watch.items');
});

test('buildWatcherArgv is inert (empty argv) with nothing to watch', () => {
  assert.deepEqual(buildWatcherArgv([]), []);
  assert.deepEqual(buildWatcherArgv([], { scriptPath: 'cli.ts' }), []);
  assert.deepEqual(buildWatcherArgv(null), []);
  assert.deepEqual(buildWatcherArgv(undefined), []);
  assert.deepEqual(buildWatcherArgv(['', '   ', null, 42]), []);
});

test('buildWatcherArgv skips flags whose value is empty or nonsense', () => {
  assert.deepEqual(buildWatcherArgv(['a/b#1'], { scriptPath: 'c.ts', events: '', workflow: '', intervalSec: 0 }), [
    'c.ts', 'watch', 'a/b#1'
  ]);
  assert.deepEqual(buildWatcherArgv(['a/b#1'], { scriptPath: 'c.ts', stallMin: 0 }), [
    'c.ts', 'watch', '--stallmin', '0', 'a/b#1'
  ]);
});

// ── itemKey ──────────────────────────────────────────────────────────────────────

test('itemKey gives the CLI\'s owner/repo#num for every accepted form', () => {
  for (const raw of ['acme/widget#12', 'acme/widget/pull/12', 'acme/widget/issues/12', 'https://github.com/acme/widget/pull/12?x=1', '  acme/widget#12  ']) {
    assert.equal(itemKey(raw), 'acme/widget#12', raw);
  }
  assert.equal(itemKey('not an item'), null);
});

// ── decideRearm ──────────────────────────────────────────────────────────────────

// The engine's set, as a test fixture: the real binding IMPORTS it from the umbrella's
// scripts/gh/lib/watch.ts and never names a member (see lib/index.js loadEngineStateEvents).
const ENGINE_STATE_EVENTS = new Set(['merged', 'closed', 'conflict', 'stall']);
const items = ['acme/widget#1', 'https://github.com/acme/widget/pull/2'];

test('decideRearm: a STATE event retires exactly its item, matched by key across forms', () => {
  const next = decideRearm({ items, code: 0, line: 'CONFLICT acme/widget#2  conflicts with its base  https://x', stateEvents: ENGINE_STATE_EVENTS });
  assert.deepEqual(next.rearm, ['acme/widget#1']);
  assert.equal(next.retired, 'acme/widget#2');
});

test('decideRearm: the last item retired leaves nothing to re-arm (the watch ends)', () => {
  const next = decideRearm({ items: ['acme/widget#1'], code: 0, line: 'MERGED   acme/widget#1  (unblocked)  https://x', stateEvents: ENGINE_STATE_EVENTS });
  assert.deepEqual(next.rearm, []);
});

test('decideRearm: a DELTA wake or an ARM report keeps every item', () => {
  for (const line of ['COMMENT  acme/widget#1  new comment (1 -> 2)  https://x', 'VERDICT  acme/widget#1  BLOCK  validate / validate failure at h1  https://x', 'ARM      acme/widget#1  state=open  verdict=BLOCK  https://x']) {
    assert.deepEqual(decideRearm({ items, code: 0, line, stateEvents: ENGINE_STATE_EVENTS }).rearm, items, line);
  }
});

test('decideRearm: the set decides — an event the engine does not list as state is never retired', () => {
  // Same CONFLICT line, but an engine set WITHOUT conflict: the item is kept. The binding
  // follows the engine's set, whatever it is, which is what keeps it from drifting.
  const next = decideRearm({ items, code: 0, line: 'CONFLICT acme/widget#2  x', stateEvents: new Set(['merged']) });
  assert.deepEqual(next.rearm, items);
});

test('decideRearm: a timeout re-arms everything; every failure exit stops, visibly', () => {
  assert.deepEqual(decideRearm({ items, code: 4, line: 'TIMEOUT  no event within 600s', stateEvents: ENGINE_STATE_EVENTS }).rearm, items);
  for (const code of [5, 6, 7, 8, 143, 1]) {
    const next = decideRearm({ items, code, line: '', stateEvents: ENGINE_STATE_EVENTS });
    assert.deepEqual(next.rearm, [], `exit ${code}`);
    assert.ok(next.reason.length > 0, `exit ${code} names its reason`);
  }
});
