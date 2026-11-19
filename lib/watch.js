/**
 * The watcher seam: read the harness-portable item list, build the argument vector for
 * the org's ONE watcher — the umbrella's `node scripts/gh/cli.ts watch`
 * (opencharly/opencharly#1140) — and decide, after each wake, what to re-arm.
 *
 * This module owns no watching: it does not poll and does not judge a verdict. The CLI
 * does that, identically for every harness that binds it. A finished BACKGROUND JOB is
 * DSH's notification, so each wake is one finite watcher run, and this seam re-arms the
 * next one — the same rule the pi binding follows (`.pi/extensions/watch.ts`):
 *
 *   - an item whose STATE event fired is RETIRED, never re-armed: a state event fires from
 *     the arm baseline and `--no-arm-wake` does not suppress it, so re-arming an item still
 *     in that state re-fires it at once (a hot-loop measured in pi on opencharly#1163).
 *     WHICH events are state events is the engine's own `STATE_EVENTS`, passed in — this
 *     module names none of them;
 *   - every other wake, and a timeout, re-arms the rest with `--no-arm-wake`;
 *   - a usage, lock, rate-limit or poll failure stops, visibly.
 *
 * @module dsh-opencharly/watch
 */

/** The org's GitHub watch list, relative to the project root. */
export const WATCH_ITEMS_RELATIVE = '.dsh/watch.items';

/** The org's ONE watcher CLI, relative to the project root. */
export const DEFAULT_WATCH_SCRIPT = 'scripts/gh/cli.ts';

/** The watcher engine whose `STATE_EVENTS` decides which wakes retire an item. */
export const ENGINE_RELATIVE = 'scripts/gh/lib/watch.ts';

/**
 * `owner/repo#num` — the short form.
 * Ported from `.pi/extensions/watch.ts:137` (`isGithubItem`), the org's canonical
 * validator, so an item list stays portable between harnesses.
 */
const ITEM_SHORT = /^[^/\s#]+\/[^/\s#]+#[0-9]+$/;

/** `owner/repo/pull|issues/num` — the explicit form, and the URL form once stripped. */
const ITEM_PATH = /^[^/\s]+\/[^/\s]+\/(?:pull|issues)\/[0-9]+$/;

/**
 * Normalize one candidate line, or reject it.
 *
 * Accepts `owner/repo#num`, `owner/repo/pull/num`, `owner/repo/issues/num`, and the
 * matching `https://github.com/…` URL (a `?query` is ignored when validating but
 * preserved in the returned item, which is what the CLI receives).
 *
 * @param raw - one raw line.
 * @returns the trimmed item as written, or `null` when it is not a well-formed item.
 */
export function normalizeWatchItem(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const bare = trimmed.replace(/^https?:\/\/github\.com\//i, '').split('?')[0];
  return ITEM_SHORT.test(bare) || ITEM_PATH.test(bare) ? trimmed : null;
}

/**
 * Split a `watch.items` file into its items, in order.
 *
 * Grammar: one item per line; blank lines and lines whose first non-blank character
 * is `#` are ignored; anything else that is not a well-formed item is dropped. This
 * is the SAME grammar `.pi/watch.items`, `.reasonix/watch.items` and
 * `.dsh/watch.items` use. A comment-only or absent list returns `[]` — inert, which
 * is the shipped default.
 *
 * Duplicates are preserved deliberately: the CLI is handed the list verbatim, exactly
 * as the pi binding hands it, so the two bindings cannot disagree.
 *
 * @param text - the file contents.
 * @returns the accepted items, in file order.
 */
export function parseWatchItems(text) {
  if (typeof text !== 'string') return [];
  const items = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const item = normalizeWatchItem(trimmed);
    if (item !== null) items.push(item);
  }
  return items;
}

/**
 * The key the CLI prints an item under: `owner/repo#num`, from any accepted form.
 *
 * @param raw - an item as written in the list.
 * @returns the key, or `null` when the item is not well-formed.
 */
export function itemKey(raw) {
  if (normalizeWatchItem(raw) === null) return null;
  const bare = raw.trim().replace(/^https?:\/\/github\.com\//i, '').split('?')[0];
  const m = /^([^/\s#]+)\/([^/\s#]+)(?:#|\/(?:pull|issues)\/)([0-9]+)$/.exec(bare);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
}

/**
 * Build the exact watcher argument vector: `<cli> watch [flags] <item>…`.
 *
 * Flag spelling follows the CLI (`scripts/gh/cli.ts`): `--events`, `--interval`,
 * `--stallmin`, `--workflow`, `--timeout` (omitted at `0`, "no deadline"), and
 * `--no-arm-wake` on a RE-arm, so a verdict already reported at the first arm does not
 * wake the session again. The CLI's own validations — a sub-300 s interval, an unknown
 * flag — are NOT duplicated here (R3): it exits 5 with a message, which the caller
 * surfaces as a visible failure. This function only formats.
 *
 * @param items - the items from {@link parseWatchItems}.
 * @param opts - `{ scriptPath, events, intervalSec, stallMin, workflow, timeoutSec, noArmWake }`.
 * @returns the argv (the CLI path first; the caller runs it with node), or `[]` when there
 *   is nothing to watch.
 */
export function buildWatcherArgv(items, opts = {}) {
  const list = Array.isArray(items)
    ? items.filter((item) => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (list.length === 0) return [];

  const scriptPath =
    typeof opts.scriptPath === 'string' && opts.scriptPath.trim().length > 0
      ? opts.scriptPath
      : DEFAULT_WATCH_SCRIPT;

  const argv = [scriptPath, 'watch'];
  if (typeof opts.events === 'string' && opts.events.trim().length > 0) {
    argv.push('--events', opts.events);
  }
  if (Number.isFinite(opts.intervalSec) && opts.intervalSec > 0) {
    argv.push('--interval', String(Math.trunc(opts.intervalSec)));
  }
  if (Number.isFinite(opts.stallMin) && opts.stallMin >= 0) {
    argv.push('--stallmin', String(Math.trunc(opts.stallMin)));
  }
  if (typeof opts.workflow === 'string' && opts.workflow.trim().length > 0) {
    argv.push('--workflow', opts.workflow);
  }
  if (Number.isFinite(opts.timeoutSec) && opts.timeoutSec > 0) {
    argv.push('--timeout', String(Math.trunc(opts.timeoutSec)));
  }
  if (opts.noArmWake === true) argv.push('--no-arm-wake');
  argv.push(...list);
  return argv;
}

/** The CLI's exit codes that end the watch: usage/API, lock, rate limit, failed initial poll, taken over. */
const STOP_CODES = new Map([
  [5, 'a usage or API error'],
  [6, 'a peer holds the watch lock'],
  [7, 'a rate limit (fatal, never retried)'],
  [8, 'the initial poll failed'],
  [143, 'the watcher was taken over or terminated']
]);

/**
 * After a watcher run ends, decide what to re-arm.
 *
 * @param input - `{ items, code, line, stateEvents }`: the items that run watched, its exit
 *   code, its wake line (the last stdout line), and the engine's `STATE_EVENTS`.
 * @returns `{ rearm, retired, reason }`: the items to watch next (empty = stop), the item
 *   retired by a state event (or `null`), and why.
 */
export function decideRearm({ items, code, line, stateEvents }) {
  const list = Array.isArray(items) ? items : [];
  if (code === 4) return { rearm: list, retired: null, reason: 'timeout — no event within the deadline' };
  if (code !== 0) {
    return { rearm: [], retired: null, reason: STOP_CODES.get(code) ?? `the watcher exited ${code}` };
  }
  const [event = '', key = ''] = String(line ?? '').trim().split(/\s+/);
  if (stateEvents.has(event.toLowerCase())) {
    return {
      rearm: list.filter((item) => itemKey(item) !== key),
      retired: key,
      reason: `${event} ${key} — a state event retires its item`
    };
  }
  return { rearm: list, retired: null, reason: `${event || 'a wake'} — the watch continues` };
}
