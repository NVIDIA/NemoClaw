# Locating and Fetching Upstream Skills

The canonical NuRec router (named `nurec-index`) and its five sibling
skills live in `https://github.com/NVIDIA/nurec-skills` under
`.agents/skills/` (the upstream repo also exposes the same tree under
`skills/`; `.agents/skills` is a symlink). Refer to a sibling skill by
its `name:` (e.g. `nre`) — that name is portable across agent runtimes
that implement the `agentskills.io` standard. The folder name always
matches the skill `name:` (e.g. the `ncore` skill lives at
`.agents/skills/ncore/`).

## Where to look on the local disk (try in order)

1. `.agents/skills/<name>/SKILL.md` (Cursor, Codex, NemoClaw)
2. `.claude/skills/<name>/SKILL.md` (Claude Code)
3. `.cursor/skills/<name>/SKILL.md` (project-scoped)
4. `~/.cursor/skills/<name>/SKILL.md` (personal skills)
5. The upstream clone described below.

## Clone or refresh the upstream

Use the shared upstream root unless the user has set a NuRec-specific
override:

```bash
UPSTREAM_ROOT="${NUREC_SKILLS_UPSTREAM_ROOT:-${PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT:-$HOME/.physical-ai-skill-hub/upstreams}}"
mkdir -p "$UPSTREAM_ROOT"
if [ -d "$UPSTREAM_ROOT/nurec-skills/.git" ]; then
  git -C "$UPSTREAM_ROOT/nurec-skills" fetch --tags
  git -C "$UPSTREAM_ROOT/nurec-skills" checkout main
  git -C "$UPSTREAM_ROOT/nurec-skills" pull --ff-only
else
  git clone --depth 1 https://github.com/NVIDIA/nurec-skills.git \
    "$UPSTREAM_ROOT/nurec-skills"
fi
test -f "$UPSTREAM_ROOT/nurec-skills/.agents/skills/SKILL.md"
```

Then read the upstream skill before running any mutating command:

```bash
# Router (table of contents):
cat "$UPSTREAM_ROOT/nurec-skills/.agents/skills/SKILL.md"

# Sibling skills (replace <folder> per the table above):
cat "$UPSTREAM_ROOT/nurec-skills/.agents/skills/<folder>/SKILL.md"
```

Skills that pin a specific upstream commit ship the actual file under
`.agents/skills/<folder>/_versions/<branch>/<commit>/SKILL.md` with a
top-level `<folder>/SKILL.md` symlink to the currently-selected
version. Follow the symlink; don't hand-pick a `_versions/` path
unless the user asked for a specific revision.

Companion files (`references/`, `scripts/`, `assets/`) live next to
**the sibling skill's** `SKILL.md`, not next to this router. Open the
sibling skill first and follow its References section.
