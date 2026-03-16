---
name: fork-rebase
description: Rebase the oh-my-opencode sami octopus merge fork onto a new upstream dev tag. Use when the user asks to rebase, sync upstream, update to a new version, or resolve merge conflicts after a rebase. Contains hard-won patterns from repeated rebase sessions.
---

# Fork Rebase — oh-my-opencode

## The #1 Rule: Never Hardcode the Branch List

Sami's parents change every few releases (branches get upstreamed and dropped, new fixes get added). **Always derive the live parent set dynamically** — never trust a hardcoded list (including the examples in this skill) or the `jj bookmark list` output. The bookmark list contains stale/experimental branches that are NOT sami parents.

```bash
# THE authoritative parent set — re-run this every rebase:
jj log -r 'parents(sami)' --no-graph \
  -T 'change_id.shortest(8) ++ " [" ++ if(bookmarks,bookmarks,"(none)") ++ "] conflict=" ++ conflict ++ " :: " ++ description.first_line() ++ "\n"'
```

As of v4.11.0 there are **4 parents** (down from 14 in the v4.0 era — athena, leekjay, look-at, adaptive-thinking, skill-mcp-cdp, etc. were all upstreamed or dropped). Treat any inventory below as a snapshot, not gospel.

## Current Parents (v4.11.0 snapshot — re-derive before trusting)

| Branch | Purpose | Rebase risk |
|--------|---------|-------------|
| `ci` | `sami-build.yml` + `ci.yml` tweaks + **this fork-rebase skill lives here** | LOW–MED. Conflicts when upstream rewrites `ci.yml` or deletes scripts the branch carried. |
| `fix/tmux-applylayout-target-pane` | `isolation: "session"` default + `targetPaneId` on `applyLayout` + isolated-window deferral in tmux-subagent | **HIGH**. Upstream actively refactors `tmux-core` + the `shared/tmux` adapter shim. |
| `fix/anthropic-fable-mythos-adaptive-thinking` | Defer to adaptive thinking for Claude Fable/Mythos models (`model-core` + `agents/types.ts`) | MED. Upstream adds models / changes thinking config. |
| `fix/parent-wake-stale-unknown-finish` | Wake parent after stale unknown-finish turn (`background-agent/parent-wake-*`) | LOW–MED. Background-agent area. |

There are also ~9 other bookmarks (`feat/look-at-async`, `fix/skill-directory-param`, `fix/mcp-reload-survival`, etc.) on **older bases** that are NOT current sami parents. Leave them alone unless the maintainer says otherwise — they are not part of the live merge.

## Critical Environment Setup

Set these env vars before any `jj` command that may open an editor (`squash`, `describe`). Without them `jj squash` hangs waiting for nvim:

```bash
export JJ_EDITOR="true" EDITOR="true" VISUAL="true" GIT_EDITOR="true"
```

## Resolving Conflicts (the common case)

After a rebase, some parents and `sami` show `conflict=true`. **Resolve each conflicted PARENT branch in isolation; sami auto-resolves** once its parents are clean. Never edit a conflicted change directly — use child + squash so the change identity is preserved.

```bash
# For each conflicted parent <branch>:
jj new <branch> -m "wip: resolve <branch> conflicts"   # materializes ONLY that branch's clean 2-sided conflict
# ... resolve the file(s) (see conflict-patterns.md) ...
jj squash -u                                            # move resolution into <branch>, keep its description
jj log -r '<branch>' --no-graph -T 'conflict ++ "\n"'   # must be false
jj abandon @                                            # drop the empty leftover
```

Resolving a parent's conflict auto-rebases sami. After all parents are clean, verify:

```bash
jj log --no-graph -T 'conflict' -r sami                          # must be false
jj log --no-graph -r 'parents(sami)' -T '"P\n"' | wc -l          # must equal the parent count you derived
grep -rn "^<<<<<<<\|^>>>>>>>\|^%%%%%%%" packages/ script/ | grep -v node_modules   # must be empty
```

## Full Rebase (when moving onto a brand-new dev tag)

```bash
# 0. Fetch + identify target
jj git fetch
TARGET=$(jj log -r 'dev' --no-graph -T 'commit_id.short()')

# 1. Snapshot the current parents BEFORE touching anything
PARENTS=$(jj log -r 'parents(sami)' --no-graph -T 'if(bookmarks, bookmarks, change_id.shortest(8)) ++ "\n"')
echo "$PARENTS" > /tmp/sami-parents.txt

# 2. Rebase each parent onto new dev
for b in $PARENTS; do
  echo "--- $b ---"; jj rebase -b "$b" -d "$TARGET"
  echo "  conflict: $(jj log --no-graph -T 'conflict' -r "$b")"
done

# 3. Resolve each conflicted branch (child + squash, above)

# 4. Sami auto-rebuilds as parents move. If you ever need to rebuild it explicitly:
NEW_PARENTS=""
for b in $PARENTS; do
  NEW_PARENTS="$NEW_PARENTS -d $(jj log -r "$b" --no-graph -T 'commit_id.short(12)')"
done
jj rebase -r sami $NEW_PARENTS
```

See [reference.md](reference.md) for the full annotated playbook and [conflict-patterns.md](conflict-patterns.md) for specific resolutions.

## Verification (MANDATORY before declaring done)

```bash
# 0. RELINK THE WORKSPACE — the single most common post-rebase trap (see gotcha below)
bun install --frozen-lockfile

# 1. Topology
jj log --no-graph -T 'conflict' -r sami        # false
jj log -r 'parents(sami)' --no-graph -T '"P\n"' | wc -l   # == derived parent count

# 2. Typecheck (tsgo across all workspace packages)
bun run typecheck                              # exit 0

# 3. Clean build (rm dist first to drop stale .d.ts for deleted files)
rm -rf dist && bun run build                   # exit 0

# 4. Tests — plain `bun test` IS the CI command now (no run-ci-tests.ts anymore)
bun test
```

To prove a test failure is pre-existing and not your regression, run the failing file(s) on a clean `dev` child and compare names:

```bash
jj new dev -m "wip: dev baseline" && bun test <failing-file.test.ts>   # then: jj edit sami
```

## Key Gotchas

### Stale node_modules after rebase — RELINK FIRST
A rebase advances the working tree (new/renamed workspace packages like `tmux-core`, `skills-loader-core`) but does **not** re-link `node_modules`. If `bun run typecheck` shows a wall of `Cannot find module '@oh-my-opencode/<pkg>'` / `has no exported member` errors across files you never touched, the install is stale. Confirm + fix:
```bash
ls node_modules/@oh-my-opencode/        # missing tmux-core / skills-loader-core / etc. == stale
bun install --frozen-lockfile           # relinks the current workspace package set
```
This is almost always the cause of "the rebase broke everything" — it didn't; the workspace just needs relinking.

### `bun run build` rewrites a generated artifact — restore it
The build regenerates `packages/omo-codex/scripts/install-dist/install-local.mjs` and bakes the current `version` into it (e.g. `4.10.0` → `4.11.0`). That version diff is build noise, not a merge resolution, and version is owned by the publish workflow. Keep sami clean:
```bash
jj restore packages/omo-codex/scripts/install-dist/install-local.mjs
```

### Tests run via plain `bun test` — `run-ci-tests.ts` is GONE
Upstream deleted `script/run-ci-tests.ts`; mock-pollution isolation is now handled by `test-setup.ts` preloaded via `bunfig.toml`, and CI (`ci.yml`) runs plain `bun test`. If a rebased `ci` branch still carries `run-ci-tests.ts`, accept upstream's deletion (`rm` it during conflict resolution). The full `bun test` suite shows ~9 pre-existing failures (context-window / dynamic-truncator / session-manager / empty-message areas) that ALSO fail on clean dev — `mock.module()` cross-file pollution, count varies with how many files run. Not regressions.

### Pushing `sami` triggers a RELEASE — get approval first
`.github/workflows/sami-build.yml` fires on push to `sami` and runs the full release pipeline: build 5 platform binaries, create a GitHub release, AND `npm publish --access public --tag sami` (as `@sjawhar/oh-my-opencode`). Pushing feature branches alone triggers nothing (CI only runs on master/dev). **Never push sami without explicit user approval** — it is a publish.

### Octopus merge resolutions are NOT WIP
When parents genuinely overlap, sami's working copy carries the cross-branch merge resolutions. Do NOT `jj restore` them — they re-emerge when sami rebuilds. (With today's 4 non-overlapping parents, sami's working copy is usually empty.)

### Never hand-merge lockfiles
`bun.lock` is generated. On conflict, delete and `bun install` to regenerate — never resolve markers by hand.

## Credentials
The fork is `sjawhar/oh-my-opencode` (GitHub). Pushes require the user's own credentials, not `legion-implementer[bot]` (403 otherwise).
