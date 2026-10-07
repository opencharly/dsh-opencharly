/**
 * dsh-opencharly — OpenCharly's native DeepSeek Harness plugin.
 *
 * Seams: a `tools/pre-execute` git gate that delegates to the repository's own
 * `.claude/hooks/{pre-commit,pre-push}-gate.sh`; a `systemPrompt` section carrying the
 * project-root `SOUL.md` identity; and a `session/created` listener that arms
 * `marketplace/scripts/gh_watch.sh` from `.dsh/watch.items` as a background job.
 *
 * @module dsh-opencharly
 */

import type { Context } from '@deepseek-ai/cordis';

/** Cordis plugin name; the profile entry's `id` is `dsh-opencharly`. */
export declare const name = 'dsh-opencharly';

/**
 * Required cordis services: `tools`, `sessions`, `systemPrompt`. The optional `jobs`
 * service is resolved lazily through `ctx.reflect.get('jobs', false)`.
 */
export declare const inject: string[];

/** The complete default configuration; every field is optional in the profile row. */
export interface OpenCharlyConfig {
  /** Root the other sections resolve relative paths against; empty = per session. */
  projectRoot?: string;
  gates?: {
    enabled?: boolean;
    root?: string;
    commitScript?: string;
    pushScript?: string;
    timeoutMs?: number;
    /** What to do when a gate script cannot answer. Default `'allow'` (visible skip). */
    onGateError?: 'allow' | 'deny';
  };
  soul?: {
    enabled?: boolean;
    path?: string;
    sectionName?: string;
    orderName?: string;
    order?: number | null;
    maxBytes?: number;
    requireUmbrellaMarker?: boolean;
    umbrellaMarker?: string;
    warnOnMissing?: boolean;
  };
  watch?: {
    enabled?: boolean;
    root?: string;
    itemsPath?: string;
    scriptPath?: string;
    events?: string;
    intervalSec?: number;
    stallMin?: number;
    workflow?: string;
    timeoutSec?: number;
    autoRearm?: boolean;
    skipSubagents?: boolean;
    jobKind?: string;
  };
}

/** The fully populated shape {@link normalizeConfig} returns. */
export interface NormalizedConfig {
  projectRoot: string;
  gates: Required<NonNullable<OpenCharlyConfig['gates']>>;
  soul: Required<NonNullable<OpenCharlyConfig['soul']>>;
  watch: Required<NonNullable<OpenCharlyConfig['watch']>>;
}

/** Injectable side-effecting seams, so tests never spawn a process. */
export interface OpenCharlyDeps {
  /** Runs one gate script; defaults to {@link runGateScript}. */
  runGate?: GateRunner;
  /** Produces the watcher job; defaults to {@link spawnWatcherProcess}. */
  spawnWatcher?: WatcherProducer;
}

/**
 * Apply the plugin: wire every seam as its own `ctx.effect`.
 *
 * @param ctx - plugin context; the injected services are ready at this point.
 * @param rawConfig - the profile row's `config:` value, unvalidated.
 * @param deps - optional seam overrides for tests.
 */
export declare function apply(ctx: Context, rawConfig?: unknown, deps?: OpenCharlyDeps): void;

/** The complete default configuration. Frozen. */
export declare const DEFAULT_CONFIG: Readonly<NormalizedConfig>;

/** Normalize one raw `config:` value into the full documented shape. Never throws. */
export declare function normalizeConfig(raw: unknown): NormalizedConfig;

/** Candidates for the project root, most authoritative first. */
export interface ProjectRootCandidates {
  explicitRoot?: string;
  sessionRoot?: string | null;
  envDir?: string | null;
  cwd?: string | null;
}

/** Pick the project root; `null` when every candidate is blank. */
export declare function resolveProjectRoot(options?: ProjectRootCandidates): string | null;

/** The gate kinds, in evaluation order. */
export declare const GATE_KINDS: readonly ['push', 'commit'];

/** Repo-relative path of each gate script. */
export declare const GATE_RELATIVE: Readonly<{ commit: string; push: string }>;

/** Split a shell command into shell words. Throws on an unbalanced quote. */
export declare function tokenize(command: string): string[];

/** One `git [global-opts] <subcommand> [args]` invocation, bounded to its segment. */
export interface GitInvocation {
  globals: string[];
  args: string[];
}

/** Every matching git invocation, in command order. Throws on an unbalanced quote. */
export declare function gitInvocations(command: string, subcommand: string): GitInvocation[];

/** The fail-closed loose predicate used when a command cannot be tokenized. */
export declare function mentionsSubcommand(command: string, subcommand: string): boolean;

/** Every gate this command calls for, de-duplicated, in {@link GATE_KINDS} order. */
export declare function classifyCommands(command: unknown): Array<'push' | 'commit'>;

/** The first gate this command calls for, or `null`. */
export declare function classifyCommand(command: unknown): 'push' | 'commit' | null;

/** The `bash` tool call's command string, or `null` for anything else. */
export declare function extractCommand(exec: unknown): string | null;

/** The gate scripts' stdin payload: `{ tool_input: { command } }`. */
export declare function gatePayload(command: string): { tool_input: { command: string } };

/** The gate script path for one kind, optionally resolved against a root. */
export declare function gateScriptFor(kind: string, root?: string): string | null;

/** Default availability probe: a readable regular file. Never throws. */
export declare function defaultGateProbe(path: string): boolean;

/** Resolution inputs for {@link resolveGateScripts}. */
export interface GateResolutionOptions {
  explicit?: { root?: string; commitScript?: string; pushScript?: string };
  sessionRoot?: string | null;
  envDir?: string | null;
  cwd?: string | null;
  probe?: (path: string) => boolean;
}

/** Which gate scripts resolved, from where, and what is missing. */
export interface GateResolution {
  root: string | null;
  source: 'config' | 'session' | 'env' | 'cwd' | null;
  scripts: { commit: string | null; push: string | null };
  available: { commit: boolean; push: boolean };
  missing: Array<'push' | 'commit'>;
  /** One line naming the skipped gate(s); `''` when nothing is missing. */
  reason: string;
}

/** Resolve the gate scripts for this session, and the reason for any skip. */
export declare function resolveGateScripts(options?: GateResolutionOptions): GateResolution;

/** The org's GitHub watch list, relative to the project root. */
export declare const WATCH_ITEMS_RELATIVE = '.dsh/watch.items';

/** The org's canonical watcher, relative to the project root. */
export declare const DEFAULT_WATCH_SCRIPT = 'marketplace/scripts/gh_watch.sh';

/** Normalize one `watch.items` line, or `null` when it is not a well-formed item. */
export declare function normalizeWatchItem(raw: unknown): string | null;

/** Split a `watch.items` file into its items; blank lines and `#` comments ignored. */
export declare function parseWatchItems(text: unknown): string[];

/** Options for {@link buildWatcherArgv}. */
export interface WatcherArgvOptions {
  scriptPath?: string;
  events?: string;
  intervalSec?: number;
  stallMin?: number;
  workflow?: string;
  timeoutSec?: number;
  autoRearm?: boolean;
}

/** The exact `gh_watch.sh` argument vector; `[]` when there is nothing to watch. */
export declare function buildWatcherArgv(items: unknown, opts?: WatcherArgvOptions): string[];

/** The header every harness's SOUL block carries. */
export declare const SOUL_HEADER = '## Who you are — SOUL.md';

/** The visible content-loss warning emitted when SOUL.md is absent. */
export declare const SOUL_MISSING_WARNING: string;

/** Read a SOUL file. Never throws; `''` when absent or unreadable. */
export declare function readSoul(path: unknown, options?: { maxBytes?: number }): string;

/** Render the prompt-section text for one SOUL reading. */
export declare function soulSectionText(text: unknown, options?: { warnOnMissing?: boolean }): string;

/** One gate script's verdict. */
export interface GateOutcome {
  /** The script's exit code, or `null` when it never reported one. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** A spawn failure, a timeout, or a cancellation; `null` on a real verdict. */
  error: string | null;
  aborted: boolean;
}

/** Runs one gate script against a payload. */
export type GateRunner = (
  script: string,
  payload: { tool_input: { command: string } },
  options?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<GateOutcome>;

/** Run one gate script and report its verdict. Exit 2 blocks; the reason is on stderr. */
export declare function runGateScript(
  script: string,
  payload: { tool_input: { command: string } },
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<GateOutcome>;

/** The producer face a watcher job appends through. */
export interface JobHandleLike {
  readonly id: string;
  append(text: string, options?: { channel?: 'stdout' | 'stderr' | 'log'; gapBefore?: true }): void;
  updateProgress(line: string): void;
}

/** The `JobHooks` shape `JobSpec.run` must return. */
export interface WatcherJobHooks {
  cancel(reason?: string): void;
  done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; result?: string }>;
}

/** Spawns the watcher and returns its job hooks. */
export type WatcherProducer = (
  argv: string[],
  options: { cwd: string; job: JobHandleLike }
) => WatcherJobHooks;

/** Spawn `gh_watch.sh` as a job producer; its exit settles the job and wakes the session. */
export declare function spawnWatcherProcess(
  argv: string[],
  options: { cwd: string; job: JobHandleLike }
): WatcherJobHooks;
