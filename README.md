# dsh-opencharly

OpenCharly's native **DeepSeek Harness** plugin — the git gates, the `SOUL.md`
identity, and the session-start watch auto-arm that a DSH session cannot wire from
repository config alone.

A DSH plugin is a host-profile *dependency*, not a repo file: [`AGENTS.md`](../AGENTS.md)
Part II rule 5 keeps harness config at the umbrella root, while a plugin is installed
into `$DSH_HOME` and pinned by commit from this repository — exactly as
`@perrylink/dsh-github`, `dsh-git-worktree` and `dsh-workspace-enhancement` are pinned
today in `~/.dsh/profiles/web/package.json`. That is the gap this plugin fills: the
opencode, pi and reasonix arms of the org all get their identity, their gates and their
watcher through files the umbrella owns, and DSH could not, because it has no
repository-level extension point at all.

## Install

```sh
dsh plugin --profile web add "github:opencharly/dsh-opencharly#<commit>"
```

`dsh plugin` forwards its arguments to `pnpm` in the profile directory
(`@deepseek-ai/dsh/lib/bin.js:115-122`), so the `<commit>` is any immutable ref of this
repository. Then add the bundle row to the profile's `dsh.profile.bundles` list —
`dsh-opencharly` — and restart the profile. Pin a **merged** commit, never a branch:
this plugin shells out to `marketplace/scripts/gh_watch.sh`, whose own pin is the
`marketplace` gitlink in the session's checkout, and a branch pin makes that pairing
undecidable.

## What it does — four seams

| Seam | DSH API | What it delegates to |
|---|---|---|
| **Git gates** | `tools/pre-execute` waterfall listener | `.claude/hooks/pre-commit-gate.sh`, `.claude/hooks/pre-push-gate.sh` in the **session's own checkout** |
| **SOUL injection** | `ctx.systemPrompt.section({ name, order, text, interpolate })` | `<project root>/SOUL.md`, re-read at every prompt assembly |
| **Watch auto-arm** | `session/created` listener + `ctx.jobs.start(spec)` | `marketplace/scripts/gh_watch.sh`, armed from `.dsh/watch.items` |
| **Goal re-arm** | `session/event` listener + `ctx.goals.resume(agent, revision)` | the `goals` service, on the **human turn** only (`user/message`) |

### 1. Git gates

A `git commit` or `git push` tool call is recognized and handed to the repository's
**existing** gate scripts. That is all this seam does.

The contract is the upstream `PreToolUse` one — the scripts read
`{"tool_input":{"command":"<the shell command>"}}` on **stdin**, exit **2** to BLOCK with
the reason on **stderr**, and exit 0 to allow. (`dsh-hooks-claude-code/lib/index.js:367-373`
builds exactly that `tool_input` payload for the same scripts; `:248-262` runs the hook
with it.) The scripts decide force-push, `--no-verify`, `core.hooksPath`, direct-to-`main`,
lint cleanliness and everything else.

**Why delegation and not a second implementation.** The gate scripts already exist and
are already the org's one answer for "is this git command landable". A plugin that
re-decided force-push would be a *second* policy implementation, and two policy
implementations that agree today are two that disagree the first time one is edited.
`AGENTS.md` R3 forbids that outright, and the gate scripts say the same thing about
themselves in `.claude/hooks/gitcmd.py:1-17`. So this plugin owns exactly two things the
scripts cannot: *noticing* the tool call (they only see it once a harness runs them),
and *carrying* the verdict back into DSH's pre-dispatch decision. Both are DSH-specific
and neither is policy.

The parser in `lib/gates.js` is a faithful port of `.claude/hooks/gitcmd.py` — same
`shlex`-style tokenizer with punctuation splitting, same shell-keyword and
`NAME=value` skipping, same `git`-global-option handling, and the same **fail-closed**
predicate when a command cannot be tokenized at all. It is a **discipline backstop, not
a security boundary**: it does not try to defeat deliberate obfuscation, exactly as the
Python original states. GitHub branch protection and the fresh `pr-validator` are the
authority.

### 2. SOUL injection

`SOUL.md` is the org's one identity document and sits beside the harness binding with no
harness-specific copy. This seam reads the project-root `SOUL.md` and contributes it as
one system-prompt section:

```
## Who you are — SOUL.md

<the file>
```

The section's `text` is a **provider**, re-evaluated at every assembly, so editing
`SOUL.md` takes effect on the next request without a restart. `interpolate: false`
preserves the identity literally — `renderPrompt` interpolates `{{…}}` in a section
unless told not to (`dsh-system-prompt/lib/index.js:113-115`), and an identity document
is not a template.

When `SOUL.md` is **absent**, the section carries a visible content-loss warning rather
than an empty string, because a session that silently runs without the charly identity
is indistinguishable from one that has it.

The seam refuses to inject outside an OpenCharly umbrella checkout (the default
`requireUmbrellaMarker`, keyed on `.claude/hooks/pre-push-gate.sh`) — the same repo guard
the reasonix arm uses. One DSH profile serves every project on the machine, and the
charly identity does not belong in an unrelated one.

> **Not the mechanism used here, but worth knowing:** DSH also has an instruction-file
> path — `@deepseek-ai/dsh-agent-instructions` takes `instructionFileCandidates` plus a
> **required** `maxBytes`, and a non-`insert` id-targeted bundle patch replaces a row's
> `config` **wholesale** (`dsh-agent-instructions/lib/index.js:25-32`). That would inject
> `SOUL.md` as *workspace instructions* alongside `AGENTS.md`, which is a different thing
> from the deployment persona slot, and it needs a whole-row config replacement to add a
> candidate. This plugin contributes the identity as its own section instead, which is
> also what keeps the section's name (`charly:soul`) addressable for a later override.

### 3. Session-start watch auto-arm

On `session/created`, the plugin reads `.dsh/watch.items` from the session's checkout and
arms `gh_watch.sh` as a **background job**:

```
gh_watch.sh --events <events> --interval <n> --stallmin <n> --workflow <wf> [--timeout <n>] <--auto-rearm|--no-rearm> <item> …
```

The item grammar is the harness-portable one — `owner/repo#num`, `owner/repo/pull/num`,
`owner/repo/issues/num`, or a full GitHub URL; blank lines and `#` comments are ignored —
the SAME grammar `.pi/watch.items`, `.reasonix/watch.items` and `.dsh/watch.items` use.
The shipped `.dsh/watch.items` is comment-only, so the watcher is **inert by default**.

**Why a job and not a bespoke loop.** DSH notifies a session when a *background job*
finishes, so the watcher's own exit IS the wake — no turn-injection shim is needed, and
`gh_watch.sh` stays the one watcher implementation every harness shares. The plugin does
not poll, does not re-arm and does not interpret a wake. `--auto-rearm` (the default)
keeps the watch alive across DELTA fires (comment/verdict); a STATE fire
(merged/closed/stall) settles the job on purpose, and that settlement is the notification.

A standing watch is **not duplicated**: while a watcher for a checkout is live, a second
session in that same checkout is told so instead of racing it. Once the job settles (a
STATE fire, a crash, the peer-held lock), the next session in that checkout re-arms.

### 4. Goal re-arm on the human turn

DSH disarms a goal on every `agent/created` (`dsh-goal/lib/index.js:594-596`), and that is a
safety property rather than a nuisance: `agent/created` fires for a fresh **post-resume
process** too, so re-arming there would let a stale goal silently continue work no human
re-authorized. The cost was a magic word — a human had to say "resume" before a long-running
goal counted again.

This seam keys on the **human turn** instead. `session/event` carries the session's event
stream, and `user/message` is the only user-shaped event in it, so a post-resume process
emits none: a resumed process stays disarmed while a human turn re-arms. The safety
distinction survives and the magic word goes away.

| Step | Call | Why |
|---|---|---|
| read the agent | `ctx.reflect.get('agents', false).get(session.id)` | the session→agent seam |
| read the goal | `ctx.reflect.get('goals', false).get(agent)` | `undefined` when no goal is current |
| decide | `goal.phase === 'active'` | **`active` only** — see below |
| arm | `goals.resume(agent, goal.revision)` | the service's own documented transition |

**Why `resume` and not a phase write.** `resume` commits the activation edge `"armed"`
through the same guard the CLI uses (`dsh-goal/lib/index.js:686-698`), so this seam cannot
invent a state the rest of the system does not understand. That guard permits an
already-`active` goal — which is exactly the case here (phase `active`, activation
`disarmed`) — and it also permits `paused` and `blocked`, which this seam deliberately
**does not** re-arm: a human who paused or blocked a goal must not have it restarted by
their next sentence. Those phases get one line saying so, not a silent nothing.

Both services are read through `ctx.reflect.get(name, false)`, the lazy read the watch seam
already uses for `jobs`: injecting `agents`/`goals` would make a profile without
`@deepseek-ai/dsh-goal` lose the git gates and the SOUL, which need nothing from them. A
profile without the goal registry simply gets no re-arm.

## Configuration

The row's `config:` block. **Every key is optional, and the whole row is replaced, never
deep-merged** — overriding one key means restating the block. Defaults live in
[`lib/config.js`](lib/config.js) (`DEFAULT_CONFIG`) and are applied by the plugin's own
defensive reader; a wrong-typed value falls back to its default rather than throwing.

```yaml
- insert:
    - id: dsh-opencharly
      name: dsh-opencharly
      config:
        projectRoot: ''            # root the seams resolve against; '' = per session

        gates:
          enabled: true
          root: ''                 # dir holding .claude/hooks/*-gate.sh
          commitScript: ''         # explicit absolute path; overrides root
          pushScript: ''
          timeoutMs: 15000
          onGateError: allow       # allow | deny — see "Fail-closed" below

        soul:
          enabled: true
          path: SOUL.md            # relative to the project root
          sectionName: charly:soul
          orderName: DEPLOYMENT_PERSONA_PREFIX
          order: null              # a raw number overrides orderName
          maxBytes: 0              # 0 = no cap
          requireUmbrellaMarker: true
          umbrellaMarker: .claude/hooks/pre-push-gate.sh
          warnOnMissing: true

        watch:
          enabled: true
          root: ''                 # overrides projectRoot for this seam
          itemsPath: .dsh/watch.items
          scriptPath: marketplace/scripts/gh_watch.sh
          events: comment,verdict,merged,closed,stall
          intervalSec: 60          # gh_watch.sh refuses anything under 60
          stallMin: 60
          workflow: charly/pr-validator
          timeoutSec: 0            # 0 omits --timeout (no deadline)
          autoRearm: true
          skipSubagents: true
          jobKind: opencharly-watch
        rearm:
          enabled: true             # re-arm an ACTIVE goal on the human turn
          phase: active             # the ONLY phase it re-arms; see seam 4
```

### Project-root resolution

One rule, used by all four seams, in this order: **explicit config → the session's own
cwd → `$CLAUDE_PROJECT_DIR` → the process cwd**. The session's cwd comes from
`session.header.cwd`, captured on `session/created` and, at tool-call time, from
`ctx.sessions.get(exec.agent.sessionId).header.cwd`.

## Security and fail-closed behaviour

- **No answerer fails closed — but this plugin never asks.** The `ask` decision runs only
  when an approval service returns `allowed-once`, and "missing approval support turns
  `ask` into denial" (`dsh-tools/lib/types/index.d.ts:36-46`). This seam therefore returns
  exactly two things: `next()` (allow) or `{ kind: 'deny', reason }`. It never emits `ask`,
  so installing it cannot silently start prompting, and it cannot be defeated by a
  deployment that answers no questions.
- **A gate that cannot run is a VISIBLE SKIP, never a fabricated block.** If the scripts
  are not found, `resolveGateScripts` reports which kinds are missing and why, the gate
  logs one line, and the call delegates. R7a: live or skip, never fake. Every skip is
  logged once per distinct reason so a hot tool path cannot flood the log.
- **`gates.onGateError`** decides what happens when a gate script exists but gives no
  verdict — a spawn failure, a timeout, or an exit code that is neither the allow `0` nor
  the block `2`. The default is `allow` (visible skip), because the scripts are a
  discipline backstop and must not brick every git call in a checkout whose gate is
  broken. Set it to `deny` to fail closed instead.
- **Anomalies are never silent.** A gate that spawns but errors, a watch whose job
  registry refuses the start, a `SOUL.md` that is absent, a checkout that is not an
  umbrella: each leaves a log line saying so.
- **The plugin never touches credentials, the network, or `git`/`gh` itself.** It runs
  exactly two kinds of child process: the repo's own gate scripts, and the org's own
  watcher.

## Limits

What this plugin does **not** do, and what has **not** been proven live:

- **The plugin has been COMPOSED into a real DSH profile, but never driven end to end.**
  `dsh --profile web --dump-config` against an **isolated `$DSH_HOME` copy** (the live
  profile untouched) resolves the bundle and applies its `cordis.patch.yml`, emitting the
  row `- id: dsh-opencharly / name: dsh-opencharly / config: {gates, soul, watch}`. So the
  package, the manifest and the row composition are proven LIVE. What is not yet proven is
  a session exercising the seams at runtime.
- **The scripts and the spawner ARE executed by the suite** (`test/runner.test.js`):
  `runGateScript` runs real fixture scripts for allow (exit 0), block (exit 2 with the
  reason on stderr), an anomalous exit, a missing script, a timeout and an abort,
  asserting the `{"tool_input":{"command":...}}` stdin payload; `spawnWatcherProcess` runs
  a real child and asserts the stdout/stderr channel tagging and the settle outcome. The
  WIRING tests still inject a runner and a spawner so that registration is isolated from
  execution — both layers are covered, but neither proves a live session's own behaviour.
- **A live block has never been observed.** Nobody has watched this plugin turn a
  `git push --force` into a `deny`. The scripts' own block behaviour is proven by the
  repo's `gate_test.py`, not by this suite.
- **The `session/created` + `ctx.jobs.start` pairing has not been observed live.** Each
  half is real and read from the shipped types (`dsh-session/lib/types/index.d.ts:33-44`,
  `dsh-jobs/lib/types/index.d.ts:71`, `dsh-jobs/lib/types/types.d.ts:117-149`), and
  `ctx.jobs.start` **is** used by an installed, loading plugin
  (`@perrylink/dsh-github/lib/ci/bot.js:115`), but no session-start auto-arm has ever been
  seen to fire. If the seam is absent, the plugin logs a visible skip and does nothing —
  it never pretends to watch.
- **`gh_watch.sh` is never run by the test suite** (it calls `gh`). Its argument grammar
  was read from the script's own parser (`marketplace/scripts/gh_watch.sh:114-127`) and
  mirrored from the working pi binding (`.pi/extensions/watch.ts:241-252`); that the vector
  is accepted is unproven here.
- **No schemastery `Config` export.** This package ships no runtime dependencies, so the
  row's `config:` is not schema-validated. `lib/config.js` defaults and type-checks by
  hand instead, and drops unknown keys.
- **Obfuscation is out of scope.** `bash -c 'git push'` and runtime-assembled commands
  are not detected — the same limit the gate scripts' own parser states, and the same
  reason the server-side branch protection exists.
- **The watcher is one per checkout, not one per session.** A second session in the same
  checkout is told the watch is already armed rather than racing `gh_watch.sh`'s
  single-instance lock.
- **The gate scripts are resolved from the session's own cwd, with no upward search.** A
  DSH session is meant to root at the umbrella (`AGENTS.md` Part II rule 2), and the gates
  live at that root. A session created inside a worktree resolves nothing there and falls
  through to `$CLAUDE_PROJECT_DIR` and then the process cwd; it does **not** walk up to the
  umbrella, because climbing out of a session's own checkout is exactly the implicit
  boundary crossing the rulebook forbids. Point `gates.root` at the checkout that owns the
  gates if a deployment needs otherwise.
- **A missing `SOUL.md` still starts the session.** The identity is reported as lost,
  never invented, and never substituted from elsewhere.

## Layout

```
lib/index.js       apply(ctx, config, deps) — wires the four seams as ctx.effect registrations
lib/gates.js       pure: extractCommand, classifyCommand(s), gateScriptFor, resolveGateScripts
lib/watch.js       pure: parseWatchItems, buildWatcherArgv
lib/soul.js        pure: readSoul, soulSectionText
lib/config.js      DEFAULT_CONFIG + normalizeConfig + resolveProjectRoot
lib/index.d.ts     types for the module, its config and its injectable seams
test/*.test.js     node:test — every pure helper, plus a three-seam wiring test
cordis.patch.yml   the profile bundle row
```

## Tests

```sh
node --test test/*.test.js
```

No build step and no dependencies: plain ESM, `node:test`, Node ≥ 22.

## License

MIT — see [LICENSE](LICENSE). History lives in [`CHANGELOG/`](CHANGELOG/README.md) and is
written at merge time.
