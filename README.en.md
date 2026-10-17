# dsh-agent-notes

**English** | [中文](README.md)

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Turn "why we changed it this way and what we gave up" into **mechanically checked** decision notes inside a repository, delivered as a DeepSeek Harness plugin.

> The method is distilled from [czm15053/write-notes-like-deepseek](https://github.com/czm15053/write-notes-like-deepseek), which in turn distills the `.agents/notes/` practice of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
> This plugin packages that method as a native DSH plugin: a skill, session switches, real gates, and upstream merging.

## What it solves

Code can express *how the system currently runs*; it cannot express **why it must run that way, and what was given up**. So every new session will:
"optimize away" an awkward-looking block that was deliberately written that way to avoid a deadlock; punch through global structure to satisfy a local need; and re-propose a design already proven to run out of memory three months ago.

This plugin makes the rules **hard to walk around**: same repository as the code, same change, mechanically checked, old decisions sealed with a tamper-evident hash.

## Install

```sh
# From a local directory (during development)
dsh plugin add --profile <your-profile> /path/to/dsh-agent-notes

# Or from GitHub
dsh plugin add --profile <your-profile> github:iuuuuuuuu/dsh-agent-notes
```

> **`plugin add` writes the dependency but does NOT enable the plugin.** Verified
> behavior: it records the package name in `profiles/<profile>/package.json`
> `dependencies`, but leaves `dsh.profile.bundles` untouched — and DSH loads
> plugins **layer by layer from `bundles`** (each layer reads that package's own
> `cordis.patch.yml`). So after `add` alone the plugin is installed but never
> runs, and `--dump-config` won't show it.
>
> Add the package name to `bundles` yourself:
>
> ```jsonc
> // $DSH_HOME/profiles/<your-profile>/package.json
> "dsh": {
>   "profile": {
>     "bundles": [
>       "@deepseek-ai/dsh-base",
>       "@deepseek-ai/dsh-web-app",
>       "dsh-agent-notes"        // ← add this line
>     ]
>   }
> }
> ```
>
> Then **restart DSH**. To confirm it actually loaded, `dsh --profile <your-profile> --dump-config`
> should contain `# == dsh-agent-notes` and `- id: agent-notes`. Present in
> dependencies but absent from `bundles` produces **no startup error** while the
> plugin silently does nothing — the easiest step to get wrong.

## Usage

```
/agent-notes                 Show switch and note-tree status
/agent-notes on              Enable for this session (persisted across reloads)
/agent-notes on --global     Change the global default (all sessions without an override)
/agent-notes reset           Clear this session's override, returning to the global default
/agent-notes init            Scaffold .agents/notes in the current repository
/agent-notes gate            Run the real gates (also: gate tree / gate format / gate archived)
```

### Off by default

After installing, **both new and existing sessions start with the policy off** —
turn it on when you need it (click the chip, or `/agent-notes on`). Installing the
plugin therefore never silently changes the behavior of sessions you already have.

To enable it everywhere, either:

```
/agent-notes on --global        # change the global default at runtime, persisted
```

or set `enabled: true` in the plugin config (only for the profile that carries it).

A session override wins over the global default: once you turn a session off, later
global changes won't affect it.

### Status indicator in the UI

You don't have to type a command to see whether the policy is on for the current
session: a green chip "● Agent notes" sits **left of the composer tool row**, next
to the permission selector ("Full access" / "Workspace write"), and **clicking it
toggles**. It greys out while off.

It reads the **session projection** (`agentNotes`), so it stays correct across
reloads, reconnects, and session switches. Clicking submits the official slash
command (`/agent-notes on|off`), so it is exactly equivalent to typing it, and
costs zero tokens.

> Design note: the projection only folds the host's own `command/run` events —
> **this plugin never writes to the session log**. It cannot: it has zero
> `@deepseek-ai` dependencies, so `appendPluginRecord` is unreachable; and the
> fallback `session.append('plugin:…')` was measured to write a crippled record
> (`ignorable=undefined`, unreadable by `pluginRecordOf`) that looks successful
> while polluting the log. Riding the command event sidesteps that entirely.

### Notes board: a "Notes" tab next to Conversation / Trajectory

A **"Notes"** tab appears beside Conversation / Trajectory. It hosts the upstream
board UI itself (four views: architecture baseline, evolution timeline, rejected-
alternatives vault, decision directory) — **no hand-rolled UI**:

> The tab iframes the vendored upstream asset
> `skills/agent-notes/assets/agent-notes-board.html`; the host only injects the
> **current session repository's** notes into the `window.__INLINE_DATA__` slot the
> board already provides.
>
> Why: the upstream board is a mature 76K UI (cross-reference in-degree, causal
> chains, multi-dimensional filters). Redrawing it by hand would look worse and drift
> from upstream forever. Through an iframe, **visuals and interaction follow upstream
> updates**, and this plugin only maintains the data adapter (`buildInlineData`).

It reads **live disk content**, not a snapshot: the host registers read-only HTTP
routes (`/agent-notes/ui`, `/agent-notes/board`, `/agent-notes/note`,
`/agent-notes/health`) and re-reads on every activation.

> Why not the session projection: a projection's `view` must be a **synchronous pure
> function** over the folded session log — it cannot touch the filesystem (verified in
> source: `view: state => wire.view(state)`).
>
> Security boundary: fixed route paths only, reads confined to `notesRoot` with `..`
> rejected, and a session whose notes root cannot be resolved gets **409** — never a
> guessed path, never the process working directory.

**Two injection hazards are covered by regression tests:**

1. A note body containing `</script>` or `<!--` truncates the injected script block
   (blank page, count stuck at 0). Every `<` in the JSON is emitted as `<`.
2. Calling `String.replace` with a string replacement lets `$&` and `` $` `` in the
   data expand as back-references, splicing raw HTML into the page. The replacement
   must be a **function**.

Once enabled, the model also gains:
- an **`agent-notes` skill** — the full method, class rules, templates, and archival policy, loaded on demand;
- an **`agent_notes_gate` tool** — runs the verify scripts and returns their **process exit code**, not a claim of compliance;
- an **`agent_notes_status` tool** — current switch and note-tree overview;
- a **session-scoped policy section** — injected only into sessions where the switch is on, leaving the global system prompt untouched.

### Which repository the tools act on

`agent_notes_gate` and `agent_notes_status` default to **the current session's
repository root** (from the session header's `cwd`, walking up to the directory
containing `.git`). Pass `cwd` explicitly to override.

**When the session has no working directory they fail loudly** — `passed: false`
with `reason: "NO_SESSION_CWD"` — instead of falling back to the process working
directory. That fallback is deliberately avoided: the DSH process cwd is **DSH's
own installation directory**, which usually also has `.agents/notes` (DSH's own
development notes). Falling back there would really run and really return green —
while testing a completely different repository. That is a fake green, so we
refuse to produce it.

> So: if your session was created without a workspace, pass an explicit `cwd`
> when running the gates.

### Zero notes is not a pass

The gates can only return green after verifying **at least one note**:

| Situation | Result |
|---|---|
| `.agents/notes` does not exist | `passed: false`, `reason: NO_NOTES_TREE` |
| Directory exists but has no notes | `passed: false`, `reason: NO_NOTES_YET` |
| Notes exist and all comply | `passed: true`, `noteCount` is the real count |
| Notes exist but violate rules | `passed: false`, `exitCode: 1` plus diagnostics |

The three underlying verify scripts all `exit 0` on an empty directory and print
`ok: 0 note(s) verified`. That is true in the sense of "the script found no fault",
but empty in the sense of "are my notes compliant" — **nothing verified is not the
same as verified**. The plugin therefore checks before spawning the script, so an
empty set can never be reported as a pass. The return value always carries
`noteCount` so you can tell the two apart.

## What a note looks like

The path *is* the state; there is no index file:

```
.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md
```

| lifecycle | meaning |
|---|---|
| `proposed/` | A proposal that has not shipped |
| `implemented/` | Shipped, kept current with the code |
| `rejected/` | Deliberately declined; kept only while it prevents a repeat mistake |
| `archived/` | Sealed with a SHA-256 digest, append-only |

The class set is closed (six): `feature`, `bug-fix`, `simplification`, `architecture`, `process`, `testing`.

## Gates: the exit code is the verdict

```sh
node skills/agent-notes/scripts/verify-agent-note-tree.ts       # layout / class / filename / relative links
node skills/agent-notes/scripts/verify-agent-note-format.ts     # header / required sections / alternatives / no proposal titles
node skills/agent-notes/scripts/verify-archived-agent-notes.ts  # archive seals are append-only
```

These gates are **proven to actually fail** by fault injection (see below). The plugin exposes the capability to the model, but **enforcement belongs in the host repository's CI**:

```yaml
# .github/workflows/verify-notes.yml (template: skills/agent-notes/templates/verify-notes.yml)
- run: node skills/agent-notes/scripts/verify-agent-note-*.ts
```

> ⚠️ **Copying those two lines gives you a permanently green gate.** All three scripts `exit 0`
> on an **empty set** and print `ok: 0 note(s) verified` — CI stays green when the notes tree
> does not exist at all. They answer "are the existing notes compliant?", never "are there any
> notes?". Either add your own "at least one note" precondition to CI, or reuse this repo's
> `tools/verify-notes.mjs`: the `lib/notes.js` it calls classifies an empty tree as
> `NO_NOTES_TREE` / `NO_NOTES_YET`, and that behaviour is held by regression tests and fault
> injection.

## Upstream merging

Bundled content comes from a pinned upstream commit and can be checked and merged:

```sh
npm run sync:latest                     # per-file compare against the upstream default branch
node tools/sync-upstream.mjs --auto      # resolve upstream HEAD and merge to it (CI; implies --yes)
node tools/sync-upstream.mjs --check    # compare against the pinned ref only, zero writes
node tools/sync-upstream.mjs            # show a per-file diff summary; needs --yes to write
node tools/sync-upstream.mjs --yes      # actually overwrite the bundled copy and record the manifest
node tools/sync-upstream.mjs --ref <branch|commit>   # use another ref
```

### The two checks answer different questions

| Command | Question it answers | Can it go red? |
|---|---|---|
| `--check` | Is the bundled copy byte-identical to **the pinned commit**? | **Almost always green** — the ref *is* the last synced commit |
| `--latest` | Does the bundled copy match **the upstream default branch**? | Yes: exit 1 once it lags |

`--check` on its own is an **always-green gate**: it exists, passes every time, and
verifies nothing. The real question is "has upstream published new commits", and the
only way to answer it is to compare the local manifest against the upstream branch
file by file. That is what `--latest` does, and `.github/workflows/verify.yml` runs it
on every push, every PR, and daily on a schedule.

Exit codes: `0` in sync, `1` lagging (genuinely red), `2` unable to check
(network/rate limit). **`2` also fails the job** — otherwise "could not check" would
be read as "no problem".

**Why the default ref is a commit rather than `main`**: jsDelivr's **manifest cache**
for branch names lags in practice — anchoring at `@main` returned a pre-refactor
directory layout, so path enumeration failed. Its **file reads** are accurate, though
(verified: the same file under `@main` and under the pinned commit is byte-identical),
so `--latest` compares file contents against the local manifest and never relies on
remote enumeration.

**Why not ask the GitHub API for HEAD**: unauthenticated requests hit
403 (rate limit exceeded) after 60/hour — a CI job running daily would inevitably
trip it.

After merging, always re-run:

```sh
node --test tools/*.test.mjs && node tools/fault-injection.mjs
```

### The in-project copy: hint only, never modified behind your back (`/agent-notes sync-skill`)

Besides the bundled one, **a project repo usually carries its own copy** at
`.agents/skills/agent-notes/` (git-tracked, used by that project's own CI gate). The
self-update above **only manages the bundled copy**.

Why it does not touch the project copy automatically: that copy is part of the project
repository. Rewriting it would

- dirty the user's `git status` out of nowhere;
- make local and CI run different versions of the verification scripts;
- inject unexpected changes into the project repo.

So the flow is **detect + hint + user confirmation**:

1. When the switch is on, the plugin compares the project copy against the bundled one;
   if it lags, a paragraph is appended to the injected policy that tells the model to
   **ask the user first**, not to act on its own;
2. On approval, run `/agent-notes sync-skill` — it prints a diff by default (preview);
   add `--yes` to actually write;
3. Files present only in the project are **never deleted** — they belong to the project.

#### CI needs no separate sync

The project CI chain is:

```
ci.yml → npm run verify-notes → tsx .agents/skills/agent-notes/scripts/*.ts
```

`ci.yml` only says `npm run verify-notes` — **no version or file list**. So syncing the
script directory updates exactly what CI executes; `ci.yml`, `package.json` and
`.github/` need no changes.

Those scripts have **zero external dependencies** — only `node:` builtins and mutual
imports — so a version bump cannot introduce a new npm package.

### The bundled copy updates itself (async, never blocks startup)

`skills/agent-notes` is a vendored copy. So that an installed plugin does not need a
manual sync, it pulls this repository's skill directory **in the background** on
`apply` (`lib/self-update.js`):

- **Never blocks startup**: `scheduleSkillUpdate()` is fire-and-forget; slow network
  cannot delay `apply`. The tradeoff is that the copy may still be stale for the
  instant right after startup.
- **Fails silently**: offline, CDN unreachable, or any single file missing → the whole
  batch is abandoned and **the existing copy is kept**. A slightly old skill is
  acceptable; an unusable one is not.
- **Atomic writes**: each file goes to `.tmp` then `rename`, so a mid-flight failure
  never leaves half a tree.
- **No rewrite when identical**: avoids touching mtime and firing a pointless hot swap
  on every startup.
- **Hot swap**: after actually writing new content it calls the host's
  `SkillProviderControl.invalidate()`, which drops cached catalogs and notifies
  consumers — the model sees the new text on its next load.

Why pull from **this** repository rather than the original upstream: this repo merges
from upstream, which adds a human review layer — if upstream breaks a rule, it can be
blocked here. The source constant is `UPDATE_SOURCE`.

To disable it, remove the `scheduleSkillUpdate(...)` call in `lib/index.js` (or gate it
behind a config flag).

### Upstream merges in automatically (no more manual runs)

`.github/workflows/upstream-sync.yml` runs daily (and on demand):

1. `git ls-remote` to resolve the upstream branch's real HEAD;
2. compare against the `ref` recorded in `tools/upstream-manifest.json` — **matching
   is not enough**; it also verifies each local file against its digest (the ref only
   records the last sync target, and local files may have been edited since). Any
   discrepancy still goes through the merge;
3. fetch and overwrite file by file, then update the manifest;
4. **run verify / notes:gate / test / fault-injection before committing**;
5. commit and push as `github-actions[bot]`.

So the full chain is:

```
original upstream --(GitHub Action, daily)--> this repo --(async on plugin startup)--> user machines
```

Neither hop needs anyone to remember. If either fails the job goes red — nothing is
skipped silently.

**Why `git ls-remote` instead of the GitHub API**: unauthenticated requests hit 403
after 60/hour, which a daily job would inevitably trip. The git protocol has no such
limit.

**Why resolve a commit instead of anchoring the branch name**: jsDelivr's manifest
cache for branch names lags; anchoring a commit yields that commit's real tree.

### When does the model see updated rules

`get()` in `lib/skill.js` **reads the disk on every call** — there is no cache. So
after the self-update writes new content and calls `invalidate()`, the host drops its
cached catalog and the model gets the new content on its next skill load — **DSH does
not need a restart**.

Caveat: skill content is not injected every turn — it loads on demand
(`SkillDefinition` semantics), so a session that already loaded it may still hold the
old body. To be certain, re-trigger a skill load, or restart the host.

## Self-check and tests

```sh
npm test                       # behavior tests (real subprocesses, real files)
npm run gate:fault-injection   # prove the gates can go red rather than being always-green
npm run verify                 # package self-check: manifest / patch / zero-dep / bilingual docs + badge / vendored-vs-upstream digests
npm run sync:latest            # has upstream drifted? (really goes red)
npm run sync:check             # bundled copy vs the pinned ref, byte for byte
npm run evidence               # live evidence against DSH's own real SkillRegistry
npm run check                  # runs the four above in sequence
```

`fault-injection` injects, for each gate, the exact defect it should catch (illegal class, bad filename, missing alternatives, a proposal title left in `implemented`, a tampered or deleted sealed archive, …), asserts a non-zero exit, then removes the defect and asserts a return to zero. **If any gate fails to react, the script itself exits non-zero** — and I verified that by injecting a deliberately failing assertion into the script.

> `npm run evidence` and the integration tests need to locate a DSH installation. They auto-detect `$DSH_HOME`, `~/.dsh`, and each profile's `node_modules`; for non-standard layouts such as a bundled desktop install, point at it explicitly:
>
> ```sh
> DSH_DIST=/path/to/dsh/lib/bin.js npm run evidence
> ```
>
> When detection fails, `evidence` **fails loudly (exit code 2)** rather than pretending to pass; the integration tests degrade to a same-contract harness and state which mode they used in their output.

## Design constraint (why zero dependencies)

This plugin **imports no `@deepseek-ai/*` package**. That is measured, not stylistic: a profile's `node_modules` resolves `@deepseek-ai` only to `cosmokit`/`schemastery`, so a plugin cannot reach the DSH type packages at runtime. Therefore:

- host APIs are used **structurally** (`ctx.skills` / `ctx.tools` / `ctx.commands` / `ctx.systemPrompt` / `ctx.agents`), and a missing capability degrades to off instead of crashing;
- only Node built-ins are used;
- tools are registered as **plain objects** (DSH accepts a raw `ToolDefinition`; that is how MCP-sourced tools arrive).

`tools/verify-plugin.mjs` enforces this: any `@deepseek-ai/*` import added under `lib/` turns the self-check red.

## Components

| File | Responsibility |
|---|---|
| `lib/index.js` | Assembly; mount/unmount of the session-scoped policy |
| `lib/state.js` | Global default + per-session override, both persisted (atomic writes) |
| `lib/notes.js` | Note-tree discovery, real gate execution, scaffolding |
| `lib/skill.js` | The `agent-notes` skill provider (strips frontmatter) |
| `lib/policy.js` | The injected policy text |
| `lib/commands.js` | The `/agent-notes` command |
| `lib/tools.js` | The `agent_notes_gate` / `agent_notes_status` tools |
| `skills/agent-notes/` | Vendored upstream content (SKILL.md, references, templates, scripts, assets) |
| `tools/` | Upstream merge, self-check, fault injection, tests |

## Known limitations

- The **board template references external Google Fonts**, so offline use falls back to system fonts; functionality is unaffected.
- Upstream syncing depends on jsDelivr reachability; when unreachable, `sync` fails loudly rather than skipping silently.
- DSH is in developer preview. No `peerDependencies` are declared (this plugin depends on no DSH package), but host API changes may require follow-up.
- Session switches persist **by session id**; after a session is deleted its override remains in the state file, and there is currently no GC.
- Host-repository CI wiring is left to you; the plugin does not modify repositories.

## License

MIT. Vendored upstream content remains under its authors' copyright; see the notes inside `skills/agent-notes/` and the upstream repository.

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
