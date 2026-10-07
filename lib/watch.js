/**
 * The watcher seam: read the harness-portable item list and build the argument
 * vector for the org's ONE canonical watcher, `marketplace/scripts/gh_watch.sh`.
 *
 * This module owns no watching. It does not poll, does not re-arm, does not decide
 * what a wake means — `gh_watch.sh` does all of that, identically for every harness
 * that binds it (`.pi/extensions/watch.ts`, the reasonix binding, and now DSH). The
 * only thing DSH adds is that a finished BACKGROUND JOB is itself the notification,
 * so the watcher's exit needs no bespoke turn-injection to be delivered.
 *
 * @module dsh-opencharly/watch
 */

/** The org's GitHub watch list, relative to the project root. */
export const WATCH_ITEMS_RELATIVE = '.dsh/watch.items';

/** The org's canonical watcher, relative to the project root. */
export const DEFAULT_WATCH_SCRIPT = 'marketplace/scripts/gh_watch.sh';

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
 * preserved in the returned item, which is what `gh_watch.sh` receives).
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
 * Duplicates are preserved deliberately: `gh_watch.sh` is handed the list verbatim,
 * exactly as the pi binding hands it, so the two bindings cannot disagree.
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
 * Build the exact `gh_watch.sh` argument vector.
 *
 * Flag order and spelling follow the script's own parser
 * (`marketplace/scripts/gh_watch.sh:114-127`): `--events`, `--interval`, `--stallmin`,
 * `--workflow`, `--timeout`, then the re-arm switch, then the items. `--timeout` is
 * omitted when it is `0`, the script's own "no deadline" value, so the vector carries
 * only flags that say something. `--auto-rearm` (the default) is the switch that lets
 * a DELTA fire arm its successor; a STATE fire still settles the job on purpose, and
 * that settlement is the wake.
 *
 * The script's own validations are NOT duplicated here (R3): a sub-60s `--interval`,
 * an unknown flag, or a missing `gh`/`jq`/`flock` makes `gh_watch.sh` exit 5 or 6 with
 * a message, which the caller surfaces as a visible failure. This function only
 * formats.
 *
 * @param items - the items from {@link parseWatchItems}.
 * @param opts - `{ scriptPath, events, intervalSec, stallMin, workflow, timeoutSec, autoRearm }`.
 * @returns the argv, or `[]` when there is nothing to watch.
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

  const argv = [scriptPath];
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
  argv.push(opts.autoRearm === false ? '--no-rearm' : '--auto-rearm');
  argv.push(...list);
  return argv;
}
