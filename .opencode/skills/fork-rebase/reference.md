# Fork Rebase — Full Annotated Playbook

## Context

This fork uses an **octopus merge** pattern: `sami` combines N parent branches and has no code changes of its own. Rebasing means rebasing each parent independently onto the new upstream `dev`, then letting sami auto-rebuild (or rebuilding it explicitly).

The parent set is NOT fixed — derive it every time with `jj log -r 'parents(sami)'`. As of v4.11.0 there are 4 parents; earlier eras had up to 14 (athena, leekjay, look-at, adaptive-thinking, etc.) which have since been upstreamed or dropped. Do not assume any historical inventory still holds.

The fork is `sjawhar/oh-my-opencode` (GitHub). Push requires the user's credentials, not `legion-implementer[bot]` (403 otherwise). Source lives under `packages/omo-opencode/src/` (the package-layering refactor moved everything out of the old root `src/`).

## Phase 1: Preflight Snapshot

```bash
SNAP=.omo/notepads/rebase-pre-snapshot.txt
mkdir -p .omo/notepads .omo/evidence
{
  echo "## Sami Snapshot"
  jj log --limit 1 -r 'sami' --no-graph \
    -T 'change_id.shortest(8) ++ " " ++ commit_id.short() ++ " parents=" ++ parents.map(|p| p.change_id().shortest(8)).join(",")'
  echo ""
  echo "## Parents (change_id|commit_id|bookmarks|email|description)"
  jj log -r 'parents(sami)' --no-graph \
    -T 'change_id.shortest(8) ++ "|" ++ commit_id.short() ++ "|" ++ if(bookmarks, bookmarks, "(none)") ++ "|" ++ author.email() ++ "|" ++ description.first_line() ++ "\n"'
  echo ""
  echo "## Dev Reference"
  jj log --limit 1 -r 'dev' --no-graph -T 'change_id.shortest(8) ++ " " ++ commit_id.short()'
} > "$SNAP"
cat "$SNAP"
```

Record any external (non-maintainer) contributions you find in the parent list by author email, and verify their commit_id is unchanged at the end. As of v4.11.0 there are no external parents.

## Phase 2: Rebase Each Parent

```bash
TARGET=$(jj log -r 'dev' --no-graph -T 'commit_id.short()')
PARENTS=$(jj log -r 'parents(sami)' --no-graph -T 'if(bookmarks, bookmarks, change_id.shortest(8)) ++ "\n"')
for b in $PARENTS; do
  echo "--- $b ---"
  jj rebase -b "$b" -d "$TARGET"
  echo "  conflict: $(jj log --no-graph -T 'conflict' -r "$b")"
done
```

Resolve each conflicted branch immediately (child + squash) using [conflict-patterns.md](conflict-patterns.md). Typecheck per-branch only AFTER its markers are gone — never typecheck a conflicted tree (markers are syntax errors). For fast per-file feedback use `lsp_diagnostics` on the resolved files; for the authoritative check use `bun run typecheck` once at the end (it needs the workspace relinked — see Verification).

## Phase 3: Rebuild Sami (only if needed)

Sami auto-rebuilds as its parents move, so an explicit rebuild is rarely required. If parent topology got tangled (e.g. divergent changes), rebuild explicitly with commit IDs:

```bash
PARENTS=$(jj log -r 'parents(sami)' --no-graph -T 'if(bookmarks, bookmarks, change_id.shortest(8)) ++ "\n"')
NEW_PARENTS=""
for b in $PARENTS; do
  NEW_PARENTS="$NEW_PARENTS -d $(jj log -r "$b" --no-graph -T 'commit_id.short(12)')"
done
jj rebase -r sami $NEW_PARENTS
```

After rebuild, resolve any remaining cross-branch conflicts on sami directly via child + squash. (Cross-branch conflicts only appear when two parents touch the same lines; the v4.11.0 parents do not, so sami resolves cleanly once each parent is clean.)

## Multi-Sided Snapshot Conflict Resolver (Python)

If multiple parents modify the same snapshot file, jj produces multi-sided conflicts (`<<<<<<<<<<<` with 11+ chars). Take the first `+++++++++++` side (the rebased revision, most up-to-date):

```python
import re

path = 'packages/omo-opencode/src/cli/__snapshots__/model-fallback.test.ts.snap'
with open(path) as f:
    content = f.read()

def resolve_conflict(match):
    full = match.group(0)
    plus = re.search(r'\+{7,}[^\n]*\n(.*?)(?=%{7,}|>{7,})', full, re.DOTALL)
    return plus.group(1) if plus else ''

pattern = r'<{7,} conflict \d+ of \d+\n.*?>{7,} conflict \d+ of \d+ ends\n'
resolved = re.sub(pattern, resolve_conflict, content, flags=re.DOTALL)
with open(path, 'w') as f:
    f.write(resolved)
print(f"Remaining markers: {resolved.count('<<<<<<<')}")
```

After running, visually verify a few values (model names use dash notation: `claude-opus-4-7`, not `claude-opus-4.7`). Snapshots can also simply be regenerated: `bun test <file> --update-snapshots`, then squash the regenerated snapshot into whichever branch owns it.

## Verification Checklist

```bash
# 0. RELINK — a rebase advances the tree but leaves node_modules stale.
#    Skipping this produces a wall of phantom "Cannot find module '@oh-my-opencode/*'"
#    typecheck errors in files you never touched. ALWAYS run this first.
bun install --frozen-lockfile

# 1. Topology
jj log --no-graph -T 'conflict' -r sami                         # false
jj log --no-graph -r 'parents(sami)' -T '"P\n"' | wc -l         # == derived parent count
grep -rn "^<<<<<<<\|^>>>>>>>\|^%%%%%%%" packages/ script/ | grep -v node_modules   # empty

# 2. Typecheck
bun run typecheck                                               # exit 0

# 3. Clean build (rm dist first — drops stale .d.ts for deleted source files)
rm -rf dist && bun run build                                    # exit 0
#    The build rewrites packages/omo-codex/scripts/install-dist/install-local.mjs
#    with a version bump. Discard it: jj restore packages/omo-codex/scripts/install-dist/install-local.mjs

# 4. Tests — plain bun test IS the CI command (run-ci-tests.ts was deleted upstream)
bun test
#    ~9 pre-existing failures (context-window / dynamic-truncator / session-manager /
#    empty-message). Prove pre-existing by running the same file(s) on a clean dev child:
#      jj new dev && bun test <file.test.ts>  ; then  jj edit sami
```

## Push (release-aware — get approval)

Pushing feature branches triggers nothing (CI only runs on master/dev). **Pushing `sami` triggers `sami-build.yml`: 5 platform binaries + GitHub release + `npm publish` as `@sjawhar/oh-my-opencode`.** Treat a sami push as a release and confirm with the user first.

```bash
for b in $(jj log -r 'parents(sami)' --no-graph -T 'if(bookmarks,bookmarks,"") ++ "\n"' | grep .); do
  jj git push --bookmark "$b"
done
jj git push --bookmark sami      # <-- RELEASE. Only with explicit approval.
```
