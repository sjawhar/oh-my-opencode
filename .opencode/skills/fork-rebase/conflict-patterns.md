# Conflict Patterns — oh-my-opencode Fork Rebase

Conflicts arise where a fork branch intersects upstream's changes: file extractions into Core packages, schema changes, model renames, and deletions. Patterns below are ordered by how often they bite. All paths are under `packages/omo-opencode/src/` unless noted.

## Pattern 0: Phantom "Cannot find module" — it's a stale workspace, not a conflict

**Symptom:** after resolving conflicts, `bun run typecheck` erupts with dozens of `Cannot find module '@oh-my-opencode/<pkg>'` / `'<barrel>' has no exported member '<X>'` errors in files you never touched (skill-loader, skill-mcp, tui, etc.).

**Cause:** the rebase advanced the tree to a dev with new/renamed workspace packages (`tmux-core`, `skills-loader-core`, …) but `node_modules/@oh-my-opencode/` still points at the OLD package set.

**Fix:** `bun install --frozen-lockfile`. Confirm beforehand with `ls node_modules/@oh-my-opencode/` — if `tmux-core`/`skills-loader-core` are absent, it's stale. This is NOT a code problem; do not "fix" the imports.

## Pattern 1: Upstream extracted a function into a Core package (delete-the-local-copy vs keep-the-override)

**Example (v4.11.0):** `shared/tmux/tmux-utils/layout.ts`. Upstream moved `applyLayout` + `enforceMainPaneWidth` into `@oh-my-opencode/tmux-core` and made the adapter a thin re-export shim. The fork's `fix/tmux-applylayout-target-pane` branch carried a FULL local `applyLayout` with a `targetPaneId` enhancement.

**Decision procedure:**
1. Check whether upstream's Core version already has your feature: `grep -n "targetPaneId" packages/tmux-core/src/tmux-utils/layout.ts`.
2. **If upstream absorbed it** → accept upstream's shim, drop the fork's local copy. The branch's diff becomes a no-op for that file.
3. **If upstream did NOT** (the v4.11.0 case — core `LayoutDeps` had only `spawnCommand`, no `targetPaneId`) → **keep a local override in the adapter shim**, but adopt upstream's refactor for the parts you don't customize, and drop now-dead helpers.

**v4.11.0 resolution** (kept local `applyLayout` with `targetPaneId`, delegated `enforceMainPaneWidth` to core, dropped dead `clamp`/`calculateMainPaneWidth`/local `MainPaneWidthOptions`):
```typescript
import { enforceMainPaneWidth as enforceMainPaneWidthCore } from "@oh-my-opencode/tmux-core"
import type { MainPaneWidthOptions } from "@oh-my-opencode/tmux-core"
import type { TmuxLayout } from "../../../config/schema"

interface LayoutDeps { spawnCommand?: TmuxSpawnCommand; targetPaneId?: string }

export async function applyLayout(tmux, layout, mainPaneSize, deps?): Promise<void> {
  // ... local impl: const targetArgs = deps?.targetPaneId ? ["-t", deps.targetPaneId] : []
  //     applied to both `select-layout` and `set-window-option`
}
export async function enforceMainPaneWidth(...) { /* delegates to enforceMainPaneWidthCore */ }
export type { MainPaneWidthOptions }
```
**Why keep it local:** confines fork divergence to the adapter layer (the fork already owns that file) instead of editing a Core package upstream owns — that minimizes future conflict surface, and keeps the branch's own `layout.test.ts` (which imports `./layout` and asserts `-t %5`) meaningful.

**Verify:** the branch's call sites still resolve. `action-executor.ts` calls `applyLayout(tmux, layout, size, { targetPaneId: sourcePaneId })`; `bun test packages/omo-opencode/src/shared/tmux/tmux-utils/layout.test.ts`.

## Pattern 2: Schema object gained a `satisfies` annotation + the fork changed a default

**Example:** `config/schema/tmux.ts`. Upstream changed `})` → `}) satisfies z.ZodType<TmuxConfig>` AND set `isolation` default to `"inline"`. The fork's branch sets it to `"session"` (with an explanatory comment — that's the branch's whole point).

**Resolution — keep BOTH:** the fork's default + comment AND upstream's `satisfies` annotation:
```typescript
export const TmuxConfigSchema = z.object({
  // ... upstream fields ...
  // Fork default: full session isolation so agent panes spawn in a detached tmux
  // session and never split or reflow the user's current window.
  isolation: TmuxIsolationSchema.default("session"),
}) satisfies z.ZodType<TmuxConfig>
```
The `satisfies` is type-level only — it does not change the generated `assets/oh-my-opencode.schema.json`, so the schema diff after `bun run build:schema` should be empty if the default already matched.

## Pattern 3: Upstream deleted a file the fork carries (delete/modify conflict)

**Example (v4.11.0):** `script/run-ci-tests.ts`. Upstream deleted the isolation test runner (mock-pollution is now handled by `test-setup.ts` + `bunfig.toml`; CI runs plain `bun test`). The fork's `ci` branch still added it → "2-sided conflict including 1 deletion".

**Decision:** does anything in the ACTIVE pipeline still use it?
```bash
grep -rn "run-ci-tests" --include="*.yml" --include="*.json" --include="*.ts" . | grep -v node_modules
```
If the only hits are docs/comments/old plans (not `ci.yml`/`sami-build.yml`/`package.json` scripts) → **accept the deletion**: in the conflicted-branch child, `rm script/run-ci-tests.ts`, then `jj squash -u`. The fork's `ci.yml` already runs plain `bun test`, so the file was dead weight.

## Pattern 4: Model name drift (dash vs dot notation)

Upstream renames models from dot to dash notation. When a test/assert conflicts, **always take dash notation**: `claude-opus-4-7` (not `4.7`), `claude-sonnet-4-6`, `claude-haiku-4-5`.

## General Workflow

```bash
export JJ_EDITOR="true" EDITOR="true" VISUAL="true" GIT_EDITOR="true"
jj new <conflicted-branch> -m "wip: resolve <branch>"   # materialize the branch's own clean 2-sided conflict
# edit files (Read + Write/Edit). For multi-sided snapshots: Python resolver in reference.md.
# REPLACE, don't DUPLICATE — when one side is old and one is new, keep only new; scan for repeated blocks after.
lsp_diagnostics <resolved files>                        # fast per-file check
jj squash -u                                            # move resolution into the branch, keep its description
jj log --no-graph -T 'conflict' -r '<branch>'           # must be false
jj abandon @                                            # drop the empty leftover child
```

**Rules:**
- **Never edit a conflicted change directly** — use child + squash so jj preserves the change identity.
- **Never typecheck a conflicted tree** — markers are syntax errors. Resolve, then check.
- **Never hand-merge `bun.lock`** — delete and `bun install` to regenerate.
- **Resolving a parent auto-resolves sami** for that branch's lines. Verify sami separately for cross-branch conflicts (only when two parents touch the same lines).
- **jj conflict markers:** `+++++++` = a snapshot (full content of one side); `%%%%%%%` … `\\\\\\\` = a diff (changes from base to that side). For a semantic merge, preserve the diff side's intent on top of the snapshot.
