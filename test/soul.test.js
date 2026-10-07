import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SOUL_HEADER,
  SOUL_MISSING_WARNING,
  SOUL_TRUNCATION_MARKER,
  readSoul,
  soulSectionText
} from '../lib/soul.js';

/** A temp directory holding one SOUL file. */
function tempSoul(text) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-opencharly-soul-'));
  const path = join(root, 'SOUL.md');
  writeFileSync(path, text);
  return { root, path };
}

test('readSoul returns the file text verbatim', () => {
  const { root, path } = tempSoul('# SOUL.md — Who You Are\n\nYou are charly.\n');
  try {
    assert.equal(readSoul(path), '# SOUL.md — Who You Are\n\nYou are charly.\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readSoul returns empty string — never throws — when the file is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-opencharly-soul-missing-'));
  try {
    assert.equal(readSoul(join(root, 'SOUL.md')), '');
    assert.equal(readSoul('/definitely/not/here/SOUL.md'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readSoul returns empty string for a directory and for a bad argument', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-opencharly-soul-dir-'));
  try {
    assert.equal(readSoul(root), '');
    assert.equal(readSoul(''), '');
    assert.equal(readSoul('   '), '');
    assert.equal(readSoul(null), '');
    assert.equal(readSoul(undefined), '');
    assert.equal(readSoul(42), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readSoul returns empty string for an empty file', () => {
  const { root, path } = tempSoul('');
  try {
    assert.equal(readSoul(path), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readSoul caps at maxBytes with a visible truncation marker', () => {
  const { root, path } = tempSoul('abcdefghij');
  try {
    assert.equal(readSoul(path, { maxBytes: 4 }), `abcd${SOUL_TRUNCATION_MARKER}`);
    // A cap above the byte length leaves the text untouched, marker included or not.
    assert.equal(readSoul(path, { maxBytes: 4096 }), 'abcdefghij');
    // 0 and nonsense mean "no cap".
    assert.equal(readSoul(path, { maxBytes: 0 }), 'abcdefghij');
    assert.equal(readSoul(path, { maxBytes: -1 }), 'abcdefghij');
    assert.equal(readSoul(path, { maxBytes: 'lots' }), 'abcdefghij');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readSoul caps on a UTF-8 byte boundary, not a UTF-16 code-unit boundary', () => {
  const { root, path } = tempSoul('éééé');
  try {
    // 4 bytes = two 'é' (2 bytes each); the third must not be half-emitted.
    const capped = readSoul(path, { maxBytes: 4 });
    assert.equal(capped, `éé${SOUL_TRUNCATION_MARKER}`);
    assert.equal(capped.includes('\uFFFD'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('soulSectionText frames a present identity under the canonical header', () => {
  assert.equal(soulSectionText('# SOUL.md — Who You Are\n\nYou are charly.\n'), `## Who you are — SOUL.md\n\n# SOUL.md — Who You Are\n\nYou are charly.\n`);
  assert.equal(SOUL_HEADER, '## Who you are — SOUL.md');
});

test('soulSectionText emits the VISIBLE content-loss warning when the identity is absent', () => {
  const text = soulSectionText('');
  assert.match(text, /SOUL\.md is NOT present at the project root/);
  assert.match(text, /charly identity is NOT injected/);
  assert.equal(text.includes(SOUL_MISSING_WARNING), true);
  assert.equal(soulSectionText('   \n  ').includes(SOUL_MISSING_WARNING), true);
  assert.equal(soulSectionText(null).includes(SOUL_MISSING_WARNING), true);
});

test('soulSectionText returns the empty string only when the warning is explicitly off', () => {
  assert.equal(soulSectionText('', { warnOnMissing: false }), '');
  // …and never drops a PRESENT identity, whatever the warning setting.
  assert.equal(soulSectionText('identity', { warnOnMissing: false }), `${SOUL_HEADER}\n\nidentity\n`);
});

test('soulSectionText trims the identity but keeps its interior structure', () => {
  assert.equal(soulSectionText('\n\n  a\n\n  b  \n\n'), `${SOUL_HEADER}\n\na\n\n  b\n`);
});
