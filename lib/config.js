/**
 * The row's `config:` block, read defensively.
 *
 * This module exists because `dsh-opencharly` ships **no build step and no new
 * runtime dependencies** — in particular no `@deepseek-ai/schemastery`, the peer
 * the other plugins use for their `Config` export. Cordis treats `Config` as
 * optional (`resolveConfig` returns the raw value unchanged when a plugin
 * declares none — see `@deepseek-ai/cordis/lib/index.js:956-962`), so the profile
 * entry's `config:` reaches {@link normalizeConfig} verbatim and every key here
 * is defaulted and type-checked by hand.
 *
 * A wrong-typed value is REPLACED by its default rather than throwing: a
 * mis-typed knob must degrade to the documented default, never take a whole
 * session's gates, identity, and watcher down with it.
 *
 * @module dsh-opencharly/config
 */

/**
 * The complete default configuration. Frozen so no seam can mutate the shared
 * baseline; {@link normalizeConfig} always returns a fresh, unfrozen object.
 */
export const DEFAULT_CONFIG = Object.freeze({
  /**
   * Root the other three sections resolve their relative paths against, when
   * set. Empty means "resolve per session" (see {@link resolveProjectRoot}).
   */
  projectRoot: '',
  gates: Object.freeze({
    /** Master switch for the `tools/pre-execute` git interceptor. */
    enabled: true,
    /** Explicit root holding `.claude/hooks/{pre-commit,pre-push}-gate.sh`. */
    root: '',
    /** Explicit absolute path to the commit gate; overrides `root`. */
    commitScript: '',
    /** Explicit absolute path to the push gate; overrides `root`. */
    pushScript: '',
    /** Hard deadline for one gate invocation, milliseconds. */
    timeoutMs: 15000,
    /**
     * What to do when a gate script exists but cannot answer (spawn failure,
     * timeout, an exit code that is neither the allow `0` nor the block `2`).
     * `'allow'` skips visibly and lets the call through; `'deny'` fails closed.
     * The gate scripts are DISCIPLINE BACKSTOPS, not a security boundary
     * (`.claude/hooks/gitcmd.py:1-17`), so the default refuses to brick every
     * git call in a checkout whose gate cannot run.
     */
    onGateError: 'allow'
  }),
  soul: Object.freeze({
    /** Master switch for the `SOUL.md` system-prompt section. */
    enabled: true,
    /** SOUL file path, relative to the resolved project root. */
    path: 'SOUL.md',
    /** Prompt-section name; a duplicate registration in one layer throws. */
    sectionName: 'charly:soul',
    /**
     * Centrally allocated prompt-section slot this contribution takes. Resolved
     * through `ctx.systemPrompt.getSectionOrder(name)` at apply time. The SOUL is
     * the deployment identity prefix, so it takes that slot.
     */
    orderName: 'DEPLOYMENT_PERSONA_PREFIX',
    /**
     * A raw numeric order that overrides `orderName` when it is a finite number.
     * `null` means "use `orderName`".
     */
    order: null,
    /** UTF-8 byte cap for the injected identity; `0` means no cap. */
    maxBytes: 0,
    /**
     * Inject only inside an OpenCharly umbrella checkout. A DSH profile serves
     * every project on the machine, so without this guard the charly identity
     * would be injected into unrelated sessions. Same repo guard as the reasonix
     * arm (`.reasonix/soul-inject.sh`).
     */
    requireUmbrellaMarker: true,
    /** Marker file whose presence identifies an OpenCharly umbrella checkout. */
    umbrellaMarker: '.claude/hooks/pre-push-gate.sh',
    /** Emit the visible content-loss warning when SOUL.md is absent. */
    warnOnMissing: true
  }),
  watch: Object.freeze({
    /** Master switch for the session-start watcher auto-arm. */
    enabled: true,
    /** Explicit root holding the watcher and the item list; overrides `projectRoot`. */
    root: '',
    /** The item list, relative to the resolved project root. */
    itemsPath: '.dsh/watch.items',
    /** The org's canonical watcher, relative to the resolved project root. */
    scriptPath: 'marketplace/scripts/gh_watch.sh',
    /** `gh_watch.sh --events` value. `stall` is the silence alarm and stays in. */
    events: 'comment,verdict,merged,closed,stall',
    /** `gh_watch.sh --interval`, seconds. The script refuses anything under 60. */
    intervalSec: 60,
    /** `gh_watch.sh --stallmin`, minutes. */
    stallMin: 60,
    /** `gh_watch.sh --workflow`, the validator run name to watch. */
    workflow: 'charly/pr-validator',
    /** `gh_watch.sh --timeout`, seconds; `0` omits the flag (no deadline). */
    timeoutSec: 0,
    /**
     * `--auto-rearm`: keep the watch alive across DELTA fires (comment/verdict).
     * A STATE fire (merged/closed/stall) settles the job on purpose — exiting IS
     * the wake the session is notified by.
     */
    autoRearm: true,
    /** Skip sessions created as subagent children. */
    skipSubagents: true,
    /** Registered job kind; also the job id prefix. */
    jobKind: 'opencharly-watch'
  }),
  /**
   * The goal auto-rearm seam.
   *
   * A goal is DISARMED on every `agent/created`, which is the safety property: a
   * fresh post-resume process must not silently continue work a human never
   * re-authorized. The cost was that a human had to say a magic word. This seam
   * re-arms on the HUMAN TURN instead — `user/message` is the only user-shaped
   * event in the stream (established by exercise, not by an API list) — so the
   * safety distinction survives while the magic word goes away.
   */
  rearm: Object.freeze({
    /** Master switch for the `session/event` → `user/message` re-arm seam. */
    enabled: true,
    /**
     * The ONLY goal phase this seam re-arms. `resume` is arming-legal for
     * `active`/`paused`/`blocked`, but re-arming a `paused` or `blocked` goal
     * would override a human's explicit stop — so this seam re-arms `active`
     * only and says one line otherwise.
     */
    phase: 'active'
  })
});

/** True for a plain (non-null, non-array) object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` when it is a string, else `fallback`. */
function str(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

/** `value` when it is a finite number, else `fallback`. */
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** `value` when it is a boolean, else `fallback`. */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** `value` when it is a finite number or `null`, else `fallback`. */
function nullableNum(value, fallback) {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Normalize one raw profile-row `config:` value into the full documented shape.
 *
 * Every field is optional and every wrong-typed field falls back to its default.
 * Unknown keys are dropped, so a typo cannot masquerade as a live knob.
 *
 * @param raw - the value cordis hands `apply`; anything at all, including `undefined`.
 * @returns a fresh, fully populated configuration object.
 */
export function normalizeConfig(raw) {
  const source = isRecord(raw) ? raw : {};
  const gates = isRecord(source.gates) ? source.gates : {};
  const soul = isRecord(source.soul) ? source.soul : {};
  const watch = isRecord(source.watch) ? source.watch : {};
  const rearm = isRecord(source.rearm) ? source.rearm : {};
  const d = DEFAULT_CONFIG;

  return {
    projectRoot: str(source.projectRoot, d.projectRoot),
    gates: {
      enabled: bool(gates.enabled, d.gates.enabled),
      root: str(gates.root, d.gates.root),
      commitScript: str(gates.commitScript, d.gates.commitScript),
      pushScript: str(gates.pushScript, d.gates.pushScript),
      timeoutMs: num(gates.timeoutMs, d.gates.timeoutMs),
      onGateError: gates.onGateError === 'deny' ? 'deny' : 'allow'
    },
    soul: {
      enabled: bool(soul.enabled, d.soul.enabled),
      path: str(soul.path, d.soul.path),
      sectionName: str(soul.sectionName, d.soul.sectionName),
      orderName: str(soul.orderName, d.soul.orderName),
      order: nullableNum(soul.order, d.soul.order),
      maxBytes: num(soul.maxBytes, d.soul.maxBytes),
      requireUmbrellaMarker: bool(soul.requireUmbrellaMarker, d.soul.requireUmbrellaMarker),
      umbrellaMarker: str(soul.umbrellaMarker, d.soul.umbrellaMarker),
      warnOnMissing: bool(soul.warnOnMissing, d.soul.warnOnMissing)
    },
    watch: {
      enabled: bool(watch.enabled, d.watch.enabled),
      root: str(watch.root, d.watch.root),
      itemsPath: str(watch.itemsPath, d.watch.itemsPath),
      scriptPath: str(watch.scriptPath, d.watch.scriptPath),
      events: str(watch.events, d.watch.events),
      intervalSec: num(watch.intervalSec, d.watch.intervalSec),
      stallMin: num(watch.stallMin, d.watch.stallMin),
      workflow: str(watch.workflow, d.watch.workflow),
      timeoutSec: num(watch.timeoutSec, d.watch.timeoutSec),
      autoRearm: bool(watch.autoRearm, d.watch.autoRearm),
      skipSubagents: bool(watch.skipSubagents, d.watch.skipSubagents),
      jobKind: str(watch.jobKind, d.watch.jobKind)
    },
    rearm: {
      enabled: bool(rearm.enabled, d.rearm.enabled),
      phase: str(rearm.phase, d.rearm.phase)
    }
  };
}

/**
 * Pick the project root the three seams resolve their relative paths against.
 *
 * One rule, one implementation (R3), in the documented order:
 * explicit config → the session's own cwd → `$CLAUDE_PROJECT_DIR` → the process cwd.
 * A blank/whitespace candidate is skipped; an absolute value is kept verbatim.
 *
 * @param options - the candidate roots, most authoritative first.
 * @returns the first usable candidate, or `null` when none is non-empty.
 */
export function resolveProjectRoot({ explicitRoot = '', sessionRoot = null, envDir = null, cwd = null } = {}) {
  for (const candidate of [explicitRoot, sessionRoot, envDir, cwd]) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}
