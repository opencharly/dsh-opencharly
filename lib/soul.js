/**
 * The identity seam: read the project-root `SOUL.md`.
 *
 * The identity itself is INJECTED — not pointed at from `AGENTS.md` — because a
 * pointer is not an identity. `SOUL.md` is the org's one identity document and sits
 * beside the harness binding with no harness-specific copy (opencharly/opencharly
 * #359); the opencode, pi and reasonix arms all inject its text, and this module is
 * the DSH arm's reader.
 *
 * @module dsh-opencharly/soul
 */

import { readFileSync } from 'node:fs';

/** The header every harness's SOUL block carries. */
export const SOUL_HEADER = '## Who you are — SOUL.md';

/**
 * The visible content-loss warning, emitted when SOUL.md is absent.
 *
 * A MISSING SOUL MUST BE LOUD. The failure it names — a session that silently runs
 * without the charly identity — is indistinguishable from a session that has it,
 * which is exactly why it cannot be a quiet empty string. Same wording as the pi and
 * reasonix arms.
 */
export const SOUL_MISSING_WARNING =
  'WARNING: SOUL.md is NOT present at the project root, so the charly identity is NOT ' +
  'injected this session. That is the content-loss signature — restore SOUL.md at the ' +
  'umbrella root.';

/** Marker appended when the injected identity was truncated by `maxBytes`. */
export const SOUL_TRUNCATION_MARKER = '\n…[SOUL.md truncated by dsh-opencharly soul.maxBytes]';

/**
 * Read a SOUL file.
 *
 * NEVER THROWS. An absent file, an unreadable file, a directory, or a file that
 * vanishes between the stat and the read all return `''` — a session must not fail to
 * start because an identity document is missing.
 *
 * @param path - absolute path to the SOUL file.
 * @param options - `{ maxBytes }`; `0` (the default) means no cap.
 * @returns the file text, or `''`.
 */
export function readSoul(path, { maxBytes = 0 } = {}) {
  if (typeof path !== 'string' || path.trim().length === 0) return '';

  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return '';
  }
  if (typeof text !== 'string' || text.length === 0) return '';

  const cap = typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.trunc(maxBytes)
    : 0;
  if (cap > 0) {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.byteLength > cap) {
      // Slice on a byte boundary, then let a partial trailing code point drop out of
      // the decode rather than emit a replacement character mid-identity.
      text = bytes.subarray(0, cap).toString('utf8') + SOUL_TRUNCATION_MARKER;
    }
  }
  return text;
}

/**
 * Render the system-prompt section text for one SOUL reading.
 *
 * An empty reading yields either the visible warning (the default) or `''` when the
 * operator has explicitly turned the warning off; `''` makes the prompt registry drop
 * the section entirely (`dsh-system-prompt/lib/index.js:113-115` filters empty text),
 * which is the only honest way to say "no identity, and no comment about it".
 *
 * @param text - the value from {@link readSoul}.
 * @param options - `{ warnOnMissing }`.
 * @returns the section text.
 */
export function soulSectionText(text, { warnOnMissing = true } = {}) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length === 0) {
    return warnOnMissing ? `${SOUL_HEADER}\n\n${SOUL_MISSING_WARNING}\n` : '';
  }
  return `${SOUL_HEADER}\n\n${trimmed}\n`;
}
