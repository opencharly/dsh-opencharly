/**
 * dsh-opencharly — OpenCharly's native DeepSeek Harness plugin.
 *
 * Three things a DSH session cannot wire from repository config, because a DSH
 * plugin is a host-profile dependency rather than a repo file (`AGENTS.md` Part II
 * rule 5: harness config lives only at the umbrella root):
 *
 * 1. **Git gates.** A `tools/pre-execute` listener that recognizes a `git commit` /
 *    `git push` tool call and BLOCKS it by delegating to the repository's OWN gate
 *    scripts, `.claude/hooks/pre-commit-gate.sh` and `pre-push-gate.sh`. No gate
 *    policy is re-implemented here — the scripts read `{"tool_input":{"command":…}}`
 *    on stdin and exit 2 to block with the reason on stderr.
 * 2. **SOUL injection.** A `systemPrompt` section carrying the project-root
 *    `SOUL.md` identity, read fresh at every assembly.
 * 3. **Session-start watch auto-arm.** A `session/created` listener that arms the
 *    org's canonical watcher, `marketplace/scripts/gh_watch.sh`, from
 *    `.dsh/watch.items` as a background JOB — so a session starts watching with no
 *    human arming it, and the job's own settlement is the wake.
 *
 * EXPORT SHAPE. Verified against two installed, demonstrably-loading third-party
 * plugins, and matched field for field:
 *   - `@perrylink/dsh-github/lib/index.js:10,12,13,78` —
 *     `export const name`, `export const inject`, `export { Config }`,
 *     `export function apply(ctx, config)`; its approval gate at
 *     `lib/approval-gate.js:99-117` is the working listener this file models.
 *   - `dsh-git-worktree/lib/index.js:36-41,67` — the object-form `inject`,
 *     `export const Config`, `export async function apply(ctx, config = {})`, with the
 *     comment "the loader reads inject/apply named exports as plugin metadata".
 * This plugin exports `name`, `inject` and `apply`. It deliberately does NOT export a
 * schemastery `Config`: cordis treats `Config` as optional
 * (`@deepseek-ai/cordis/lib/index.js:956-962` returns the raw value when a plugin
 * declares none), and this package ships no runtime dependencies at all, so
 * `lib/config.js` normalizes defensively instead.
 *
 * @module dsh-opencharly
 */

import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { normalizeConfig, resolveProjectRoot } from './config.js';
import {
  classifyCommands,
  defaultGateProbe,
  extractCommand,
  gatePayload,
  resolveGateScripts
} from './gates.js';
import { buildWatcherArgv, parseWatchItems } from './watch.js';
import { readSoul, soulSectionText } from './soul.js';

export { DEFAULT_CONFIG, normalizeConfig, resolveProjectRoot } from './config.js';
export {
  GATE_KINDS,
  GATE_RELATIVE,
  classifyCommand,
  classifyCommands,
  defaultGateProbe,
  extractCommand,
  gatePayload,
  gateScriptFor,
  gitInvocations,
  mentionsSubcommand,
  resolveGateScripts,
  tokenize
} from './gates.js';
export {
  DEFAULT_WATCH_SCRIPT,
  WATCH_ITEMS_RELATIVE,
  buildWatcherArgv,
  normalizeWatchItem,
  parseWatchItems
} from './watch.js';
export { SOUL_HEADER, SOUL_MISSING_WARNING, readSoul, soulSectionText } from './soul.js';

/**
 * Cordis plugin name. The profile entry's `id` is `dsh-opencharly`.
 */
export const name = 'dsh-opencharly';

/**
 * Services this plugin requires. All three are core rows of any profile built on
 * `@deepseek-ai/dsh-base`, and the names are the cordis service registrations:
 * `tools` (`dsh-tools/lib/index.js:2704`), `sessions`
 * (`dsh-session/lib/index.js:1621`), `systemPrompt`
 * (`dsh-system-prompt/lib/index.js:213`).
 *
 * `jobs` is deliberately NOT injected. The watch auto-arm is the one seam whose
 * service is optional, and it is resolved lazily through `ctx.reflect.get('jobs',
 * false)` — "Read a service from the store without the inject requirement"
 * (`cordis/lib/index.js:754-765`). Injecting it would make a profile without
 * `@deepseek-ai/dsh-tool-jobs` lose the git gates and the SOUL too, which need
 * nothing from the job registry.
 */
export const inject = ['tools', 'sessions', 'systemPrompt'];

/** Error-message extractor that never throws on a non-Error throw. */
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A logger that is safe to call even when the host hands us an unusual context.
 * @param ctx - plugin context.
 * @returns a `{ info, warn, debug, error }` facade.
 */
function makeLogger(ctx) {
  const fallback = { info() {}, warn() {}, debug() {}, error() {} };
  try {
    const service = ctx.logger;
    if (service === undefined || service === null) return fallback;
    const named = typeof service === 'function' ? service('dsh-opencharly') : service;
    return {
      info: (...args) => named.info?.(...args),
      warn: (...args) => named.warn?.(...args),
      debug: (...args) => named.debug?.(...args),
      error: (...args) => named.error?.(...args)
    };
  } catch {
    return fallback;
  }
}

/** Read `.dsh/watch.items`; absent or unreadable is inert, never an error. */
function readWatchItemsFile(path) {
  try {
    return parseWatchItems(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * The session's own checkout root, read from the live session the tool call belongs
 * to. `exec.agent.sessionId` (`dsh-tools/lib/types/index.d.ts:216-247`) names the
 * session; `session.header.cwd` (`dsh-session/lib/types/types.d.ts:58-69`) is the
 * absolute working directory it was created in.
 *
 * @param ctx - plugin context.
 * @param exec - the pending tool execution.
 * @returns the absolute cwd, or `null` when it cannot be read.
 */
function sessionRootOf(ctx, exec) {
  try {
    const sessionId = exec?.agent?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    const cwd = ctx.sessions.get(sessionId)?.header?.cwd;
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
  } catch {
    // The exec carries no resolvable session (a PTC sub-dispatch, a disposed
    // session). Fall through to the captured root, then env, then cwd.
    return null;
  }
}

/**
 * Run one gate script and report its verdict.
 *
 * The contract with the scripts is the upstream `PreToolUse` one: the JSON payload
 * `{"tool_input":{"command":…}}` on stdin; exit 0 allows, exit 2 BLOCKS with the
 * reason on stderr. Any other exit code, a spawn failure, a timeout, or the caller's
 * own cancellation is reported as `error`/`aborted` — never silently as "allowed".
 *
 * @param script - absolute path to the gate script.
 * @param payload - the stdin object from {@link gatePayload}.
 * @param options - `{ timeoutMs, signal }`.
 * @returns `{ code, stdout, stderr, error, aborted }`; `code` is `null` when the
 *   script never reported one.
 */
export function runGateScript(script, payload, { timeoutMs = 15000, signal } = {}) {
  return new Promise((settle) => {
    let finished = false;
    let timer = null;
    let onAbort = null;
    let child = null;
    let stdout = '';
    let stderr = '';

    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      if (timer !== null) clearTimeout(timer);
      if (signal && onAbort) {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          /* a non-standard signal object; nothing to detach */
        }
      }
      settle(outcome);
    };

    try {
      child = spawn('bash', [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ code: null, stdout: '', stderr: '', error: message(error), aborted: false });
      return;
    }

    // A gate script that exits WITHOUT reading stdin (the anomalous-exit case) makes the
    // stdin write fail with EPIPE, and stream errors are emitted ASYNCHRONOUSLY — the
    // try/catch around `stdin.end` below cannot see it. With no listener that becomes an
    // uncaughtException in the HOST process, i.e. a broken gate script could take the
    // session down. MEASURED: `node 22` in CI failed the exit-3 case with `write EPIPE`;
    // `node 24` and the author's `node 26` did not, so this is a real runtime difference,
    // not a flake. The `close` handler owns the outcome; this listener only absorbs it.
    child.stdin.on('error', () => {});

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ code: null, stdout, stderr, error: `gate timed out after ${timeoutMs}ms`, aborted: false });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish({ code: null, stdout, stderr, error: message(error), aborted: false });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr, error: null, aborted: false });
    });

    if (signal) {
      onAbort = () => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        finish({ code: null, stdout, stderr, error: 'caller cancelled', aborted: true });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      finish({ code: null, stdout, stderr, error: message(error), aborted: false });
    }
  });
}

/**
 * Spawn the watcher as a job producer.
 *
 * Every chunk the watcher prints is appended to the job's output ring — `stdout`
 * lines are the events (`MERGED`/`CLOSED`/`COMMENT`/`VERDICT`/`STALL`/`TIMEOUT`) and
 * `stderr` is the diagnostics. The job settles when the watcher exits, and THAT
 * settlement is the wake the session is notified by.
 *
 * @param argv - the vector from {@link buildWatcherArgv}.
 * @param options - `{ cwd, job }`.
 * @returns the `JobHooks` shape `JobSpec.run` must return.
 */
export function spawnWatcherProcess(argv, { cwd, job }) {
  const child = spawn('bash', argv, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

  let settle = null;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    settle(outcome);
  };

  child.stdout.on('data', (chunk) => job.append(chunk.toString()));
  child.stderr.on('data', (chunk) => job.append(chunk.toString(), { channel: 'stderr' }));
  child.on('error', (error) => {
    job.append(`watcher failed to start: ${message(error)}\n`, { channel: 'log' });
    finish({ status: 'failed', detail: message(error) });
  });
  child.on('close', (code, signal) => {
    job.append(`watcher exited (${signal !== null ? `signal ${signal}` : `exit code: ${code}`})\n`, { channel: 'log' });
    finish({
      status: code === 0 ? 'completed' : 'failed',
      detail: signal !== null ? `signal ${signal}` : `exit code: ${code}`
    });
  });

  return {
    cancel: (reason) => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      finish({ status: 'killed', detail: reason ?? 'cancelled' });
    },
    done
  };
}

/**
 * Seam 1 — the git gate.
 *
 * Registers the `tools/pre-execute` waterfall listener. The listener resolves the
 * gate scripts from the CURRENT session's checkout, so one profile serving several
 * projects gates each against its own repository.
 *
 * @param ctx - plugin context.
 * @param config - normalized configuration.
 * @param state - mutable plugin state.
 * @param log - the plugin logger.
 * @param runGate - the gate runner; injectable so tests never spawn a process.
 * @returns the effect disposer from `ctx.on`.
 */
function registerGateSeam(ctx, config, state, log, runGate) {
  if (!config.gates.enabled) {
    log.info('dsh-opencharly: git gates DISABLED by config');
    return () => {};
  }
  state.gateSkipsLogged = new Set();
  // R3: ONE de-duplication for BOTH skip paths. README guarantees "every skip is logged
  // once per distinct reason so a hot tool path cannot flood the log" - so the
  // root-unresolved path must route through this too instead of logging on EVERY git
  // tool call in a non-umbrella checkout (the exact case the plugin tolerates).
  const logSkipOnce = (note) => {
    if (state.gateSkipsLogged.has(note)) return;
    state.gateSkipsLogged.add(note);
    log.warn(note);
  };

  return ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const command = extractCommand(exec);
      if (command === null) return await next();

      const kinds = classifyCommands(command);
      if (kinds.length === 0) return await next();

      const sessionRoot = sessionRootOf(ctx, exec) ?? state.lastProjectRoot;
      const resolution = resolveGateScripts({
        explicit: {
          root: config.gates.root,
          commitScript: config.gates.commitScript,
          pushScript: config.gates.pushScript
        },
        sessionRoot,
        envDir: process.env.CLAUDE_PROJECT_DIR ?? null,
        cwd: process.cwd()
      });

      if (resolution.root === null) {
        logSkipOnce(`dsh-opencharly: git gate SKIPPED — ${resolution.reason}`);
        return await next();
      }

      const payload = gatePayload(command);
      for (const kind of kinds) {
        const script = resolution.scripts[kind];
        if (script === null || !resolution.available[kind]) {
          logSkipOnce(`dsh-opencharly: ${kind} gate SKIPPED — ${resolution.reason}`);
          continue;
        }

        const outcome = await runGate(script, payload, {
          timeoutMs: config.gates.timeoutMs,
          signal: exec.signal
        });

        if (outcome.code === 2) {
          const reason = outcome.stderr.trim().length > 0
            ? outcome.stderr.trim()
            : `${kind} gate blocked the command (${script} exited 2)`;
          return { kind: 'deny', reason };
        }
        if (outcome.code === 0) continue;

        // Anything else is an anomaly, not a verdict — say so, never pretend.
        const detail = outcome.error ?? String(outcome.stderr ?? '').trim();
        const note = `dsh-opencharly: ${kind} gate gave no verdict (${script}): ${
          outcome.aborted ? 'caller cancelled' : detail.length > 0 ? detail : `exit code ${outcome.code}`
        }`;
        log.warn(note);
        if (config.gates.onGateError === 'deny') {
          return { kind: 'deny', reason: note };
        }
      }
      return await next();
    } catch (error) {
      // A gate listener must never break dispatch. Report and delegate.
      log.warn(`dsh-opencharly: git gate errored (${message(error)}) — delegating without a verdict`);
      return await next();
    }
  });
}

/**
 * Resolve the numeric order for the SOUL section.
 * @param ctx - plugin context.
 * @param config - normalized configuration.
 * @returns the order, defaulting to `0` (the deployment persona prefix slot).
 */
function soulOrder(ctx, config) {
  if (config.soul.order !== null) return config.soul.order;
  try {
    const order = ctx.systemPrompt.getSectionOrder(config.soul.orderName);
    if (typeof order === 'number' && Number.isFinite(order)) return order;
  } catch {
    /* the named slot is unknown to this host; fall through to the persona prefix */
  }
  return 0;
}

/**
 * Seam 2 — the SOUL identity.
 *
 * Registers one system-prompt section. `text` is a PROVIDER, re-evaluated at every
 * assembly, so an edited `SOUL.md` takes effect on the next request without a
 * restart; `interpolate: false` preserves the identity literally, because
 * `renderPrompt` interpolates `{{…}}` in a static string
 * (`dsh-system-prompt/lib/index.js:113-115`) and an identity document is not a
 * template.
 *
 * @param ctx - plugin context.
 * @param config - normalized configuration.
 * @param state - mutable plugin state.
 * @param log - the plugin logger.
 * @returns the effect disposer from `ctx.systemPrompt.section`.
 */
function registerSoulSeam(ctx, config, state, log) {
  if (!config.soul.enabled) {
    log.info('dsh-opencharly: SOUL injection DISABLED by config');
    return () => {};
  }
  state.soulNotesLogged = new Set();
  state.soulInjectedFor = new Set();

  const order = soulOrder(ctx, config);

  return ctx.systemPrompt.section({
    name: config.soul.sectionName,
    order,
    interpolate: false,
    text: () => {
      try {
        const root = resolveProjectRoot({
          explicitRoot: config.projectRoot,
          sessionRoot: state.lastProjectRoot,
          envDir: process.env.CLAUDE_PROJECT_DIR ?? null,
          cwd: process.cwd()
        });
        if (root === null) return soulSectionText('', { warnOnMissing: config.soul.warnOnMissing });

        if (config.soul.requireUmbrellaMarker && !defaultGateProbe(join(root, config.soul.umbrellaMarker))) {
          // Not an OpenCharly umbrella checkout. Say so ONCE per root, then stay
          // silent: a profile serves every project on the machine, and the charly
          // identity does not belong in an unrelated one.
          const note = `dsh-opencharly: SOUL not injected — ${root} is not an OpenCharly umbrella checkout (no ${config.soul.umbrellaMarker})`;
          if (!state.soulNotesLogged.has(note)) {
            state.soulNotesLogged.add(note);
            log.info(note);
          }
          return '';
        }

        const text = readSoul(join(root, config.soul.path), { maxBytes: config.soul.maxBytes });
        const where = join(root, config.soul.path);
        if (text.trim().length === 0) {
          const note = `dsh-opencharly: SOUL is ABSENT at ${where} — the charly identity is not injected`;
          if (!state.soulNotesLogged.has(note)) {
            state.soulNotesLogged.add(note);
            log.warn(note);
          }
        } else if (!state.soulInjectedFor.has(where)) {
          state.soulInjectedFor.add(where);
          log.info(`dsh-opencharly: injecting ${config.soul.sectionName} from ${where}`);
        }
        return soulSectionText(text, { warnOnMissing: config.soul.warnOnMissing });
      } catch (error) {
        log.warn(`dsh-opencharly: SOUL provider failed (${message(error)}) — no identity this assembly`);
        return '';
      }
    }
  });
}

/**
 * Seam 3 — the session-start watch auto-arm.
 *
 * `session/created` is a synchronous, vetoing emit
 * (`dsh-session/lib/types/index.d.ts:33-44`), so this listener MUST NOT throw: an
 * unarmable watch is a VISIBLE SKIP, never a session that fails to start and never a
 * silent no-op.
 *
 * @param ctx - plugin context.
 * @param config - normalized configuration.
 * @param state - mutable plugin state.
 * @param log - the plugin logger.
 * @param spawnWatcher - the watcher producer; injectable so tests never spawn.
 * @returns the effect disposer from `ctx.on`.
 */
function registerWatchSeam(ctx, config, state, log, spawnWatcher) {
  if (!config.watch.enabled) {
    log.info('dsh-opencharly: watch auto-arm DISABLED by config');
    return () => {};
  }
  state.watch = new Map();

  return ctx.on('session/created', (session) => {
    try {
      const header = session?.header;
      const root = resolveProjectRoot({
        explicitRoot: config.watch.root.length > 0 ? config.watch.root : config.projectRoot,
        sessionRoot: header?.cwd ?? state.lastProjectRoot,
        envDir: process.env.CLAUDE_PROJECT_DIR ?? null,
        cwd: process.cwd()
      });
      if (root !== null) state.lastProjectRoot = root;
      if (root === null) {
        log.warn('dsh-opencharly: watch NOT armed — no project root (config, session cwd, $CLAUDE_PROJECT_DIR and cwd are all empty)');
        return;
      }

      if (config.watch.skipSubagents && (header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0)) {
        log.debug(`dsh-opencharly: watch NOT armed for subagent session ${session?.id ?? '(unknown)'}`);
        return;
      }

      const standing = state.watch.get(root);
      if (standing !== undefined && !standing.settled) {
        log.info(`dsh-opencharly: watch already armed for ${root} as job ${standing.jobId}`);
        return;
      }

      const items = readWatchItemsFile(join(root, config.watch.itemsPath));
      if (items.length === 0) {
        log.info(`dsh-opencharly: watch INERT — ${config.watch.itemsPath} under ${root} is absent or comment-only`);
        return;
      }

      const scriptPath = isAbsolute(config.watch.scriptPath)
        ? config.watch.scriptPath
        : join(root, config.watch.scriptPath);
      if (!defaultGateProbe(scriptPath)) {
        log.warn(`dsh-opencharly: watch NOT armed — ${scriptPath} not found (is the marketplace pin stale?)`);
        return;
      }

      const jobs = ctx.reflect?.get('jobs', false);
      if (jobs === undefined || jobs === null || typeof jobs.start !== 'function') {
        log.warn('dsh-opencharly: watch NOT armed — no job controller serves unowned work; load @deepseek-ai/dsh-tool-jobs to make the watch a visible job');
        return;
      }

      const argv = buildWatcherArgv(items, {
        scriptPath,
        events: config.watch.events,
        intervalSec: config.watch.intervalSec,
        stallMin: config.watch.stallMin,
        workflow: config.watch.workflow,
        timeoutSec: config.watch.timeoutSec,
        autoRearm: config.watch.autoRearm
      });
      if (argv.length === 0) return;

      // Register BEFORE the start call: `session/created` is a synchronous emit, but a
      // re-entrant listener must never find the root unarmed and arm a second watcher.
      const record = { jobId: null, settled: false };
      state.watch.set(root, record);

      try {
        record.jobId = jobs.start({
          kind: config.watch.jobKind,
          label: `gh_watch ${items.length} item(s): ${items.slice(0, 3).join(' ')}${items.length > 3 ? ' …' : ''}`,
          run: (job) => {
            const hooks = spawnWatcher(argv, { cwd: root, job });
            // The watcher's own settlement is the wake. Marking it here is what makes a
            // LATER session in the same checkout re-arm instead of silently going unwatched.
            if (hooks !== null && typeof hooks?.done?.then === 'function') {
              hooks.done.then(
                () => {
                  record.settled = true;
                },
                () => {
                  record.settled = true;
                }
              );
            }
            return hooks;
          }
        });
      } catch (error) {
        state.watch.delete(root);
        log.warn(`dsh-opencharly: watch NOT armed — the job registry refused the start (${message(error)})`);
        return;
      }

      log.info(`dsh-opencharly: armed job ${record.jobId} watching ${items.length} item(s) from ${config.watch.itemsPath} under ${root}`);
    } catch (error) {
      log.warn(`dsh-opencharly: watch auto-arm errored (${message(error)}) — no watcher armed for this session`);
    }
  });
}

/**
 * Remember the project root of the session just entered.
 *
 * One tracker, one rule (R3): the SOUL provider runs at prompt-assembly time, long
 * after the `session/created` that named the session's cwd, and
 * `AssembleContext` (`dsh-system-prompt/lib/types/index.d.ts:37-45`) carries no cwd.
 * This is where the seams learn it. `session/created` fires before the first prompt
 * assembly and before any tool dispatch, so the root is known in time for both.
 *
 * @param ctx - plugin context.
 * @param config - normalized configuration.
 * @param state - mutable plugin state.
 * @returns the effect disposer from `ctx.on`.
 */
function registerSessionTracker(ctx, config, state) {
  return ctx.on('session/created', (session) => {
    try {
      const root = resolveProjectRoot({
        explicitRoot: config.projectRoot,
        sessionRoot: session?.header?.cwd ?? null,
        envDir: process.env.CLAUDE_PROJECT_DIR ?? null,
        cwd: process.cwd()
      });
      if (root !== null) state.lastProjectRoot = root;
    } catch {
      // A session we cannot place simply leaves the previous root in place.
    }
  });
}

/** Fresh per-application mutable state. */
function createState() {
  return {
    /** Last project root seen on a `session/created`; the root the seams fall back to. */
    lastProjectRoot: null,
    /** Roots whose skip note has already been logged, so a hot provider stays quiet. */
    soulNotesLogged: new Set(),
    soulInjectedFor: new Set(),
    gateSkipsLogged: new Set(),
    /** root → `{ jobId, settled }` for the standing watcher. */
    watch: new Map()
  };
}

/**
 * Apply the plugin: wire all three seams, each as its own `ctx.effect`, so disposing
 * the plugin fiber reverses every registration.
 *
 * @param ctx - plugin context; the injected services are ready at this point.
 * @param rawConfig - the profile row's `config:` value, unvalidated; see `lib/config.js`.
 * @param deps - optional `{ runGate, spawnWatcher }` overrides, so tests exercise the
 *   real registration paths without spawning a process or running a gate script.
 */
export function apply(ctx, rawConfig, deps = {}) {
  const config = normalizeConfig(rawConfig);
  const log = makeLogger(ctx);
  const state = createState();
  const runGate = typeof deps.runGate === 'function' ? deps.runGate : runGateScript;
  const spawnWatcher = typeof deps.spawnWatcher === 'function' ? deps.spawnWatcher : spawnWatcherProcess;

  ctx.effect(() => registerSessionTracker(ctx, config, state), 'dsh-opencharly.session-root');
  ctx.effect(() => registerGateSeam(ctx, config, state, log, runGate), 'dsh-opencharly.gates');
  ctx.effect(() => registerSoulSeam(ctx, config, state, log), 'dsh-opencharly.soul');
  ctx.effect(() => registerWatchSeam(ctx, config, state, log, spawnWatcher), 'dsh-opencharly.watch');
}
