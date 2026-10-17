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

## Upstream merging

Bundled content comes from a pinned upstream commit and can be checked and merged:

```sh
node tools/sync-upstream.mjs --check    # report drift only, zero writes (non-zero exit on drift, CI-ready)
node tools/sync-upstream.mjs            # show a per-file diff summary; needs --yes to write
node tools/sync-upstream.mjs --yes      # actually overwrite the bundled copy and record the manifest
node tools/sync-upstream.mjs --ref <branch|commit>   # use another ref
```

**Why the default ref is a commit rather than `main`**: jsDelivr's manifest cache for branch names lags in practice — anchoring at `@main` returned a pre-refactor directory layout, so path matching failed. Pinning a commit yields that commit's real tree. This was learned the hard way, not assumed.

After merging, always re-run:

```sh
node --test tools/*.test.mjs && node tools/fault-injection.mjs
```

## Self-check and tests

```sh
npm test                       # behavior tests (real subprocesses, real files)
npm run gate:fault-injection   # prove the gates can go red rather than being always-green
npm run verify                 # package self-check: manifest / patch / zero-dep / bilingual docs + badge / vendored-vs-upstream digests
npm run sync:check             # whether upstream has moved
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
