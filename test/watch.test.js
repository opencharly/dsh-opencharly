import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WATCH_SCRIPT,
  WATCH_ITEMS_RELATIVE,
  buildWatcherArgv,
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
    '# harness-INDEPENDENT watcher, `marketplace/scripts/gh_watch.sh`.',
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

test('buildWatcherArgv produces the exact gh_watch.sh vector', () => {
  assert.deepEqual(
    buildWatcherArgv(['opencharly/opencharly#359', 'opencharly/marketplace/pull/42'], {
      scriptPath: '/umbrella/marketplace/scripts/gh_watch.sh',
      events: 'comment,verdict,merged,closed,stall',
      intervalSec: 60,
      stallMin: 60,
      workflow: 'charly/pr-validator',
      timeoutSec: 0,
      autoRearm: true
    }),
    [
      '/umbrella/marketplace/scripts/gh_watch.sh',
      '--events', 'comment,verdict,merged,closed,stall',
      '--interval', '60',
      '--stallmin', '60',
      '--workflow', 'charly/pr-validator',
      '--auto-rearm',
      'opencharly/opencharly#359',
      'opencharly/marketplace/pull/42'
    ]
  );
});

test('buildWatcherArgv omits --timeout at 0 and emits it above 0', () => {
  const base = { scriptPath: 'gh_watch.sh', events: 'merged', intervalSec: 60, stallMin: 60, workflow: 'wf' };
  assert.equal(buildWatcherArgv(['a/b#1'], { ...base, timeoutSec: 0 }).includes('--timeout'), false);
  assert.equal(buildWatcherArgv(['a/b#1'], { ...base, timeoutSec: 600 }).includes('--timeout'), true);
  assert.deepEqual(buildWatcherArgv(['a/b#1'], { ...base, timeoutSec: 600 }), [
    'gh_watch.sh', '--events', 'merged', '--interval', '60', '--stallmin', '60', '--workflow', 'wf',
    '--timeout', '600', '--auto-rearm', 'a/b#1'
  ]);
});

test('buildWatcherArgv switches to --no-rearm only for an explicit false', () => {
  const argv = (autoRearm) => buildWatcherArgv(['a/b#1'], { scriptPath: 'gh_watch.sh', autoRearm });
  assert.equal(argv(false).includes('--no-rearm'), true);
  assert.equal(argv(false).includes('--auto-rearm'), false);
  assert.equal(argv(true).includes('--auto-rearm'), true);
  // Omitting the flag keeps the standing watch; a DEFAULT must never be the one-shot.
  assert.equal(argv(undefined).includes('--auto-rearm'), true);
});

test('buildWatcherArgv defaults the script path to the org watcher', () => {
  assert.equal(buildWatcherArgv(['a/b#1'])[0], DEFAULT_WATCH_SCRIPT);
  assert.equal(WATCH_ITEMS_RELATIVE, '.dsh/watch.items');
});

test('buildWatcherArgv is inert (empty argv) with nothing to watch', () => {
  assert.deepEqual(buildWatcherArgv([]), []);
  assert.deepEqual(buildWatcherArgv([], { scriptPath: 'gh_watch.sh' }), []);
  assert.deepEqual(buildWatcherArgv(null), []);
  assert.deepEqual(buildWatcherArgv(undefined), []);
  assert.deepEqual(buildWatcherArgv(['', '   ', null, 42]), []);
});

test('buildWatcherArgv skips flags whose value is empty or nonsense', () => {
  assert.deepEqual(buildWatcherArgv(['a/b#1'], { scriptPath: 'g.sh', events: '', workflow: '', intervalSec: 0 }), [
    'g.sh', '--auto-rearm', 'a/b#1'
  ]);
  assert.deepEqual(buildWatcherArgv(['a/b#1'], { scriptPath: 'g.sh', stallMin: 0 }), [
    'g.sh', '--stallmin', '0', '--auto-rearm', 'a/b#1'
  ]);
});
