# SimReady FET005 Grasp Physics Local Helper

## Upstream Skill

Source of truth:

```text
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-conform-fet-005-simulate-grasp-physics/SKILL.md
```

Use an authenticated local checkout at
`$SIMREADY_FOUNDATION_ROOT/skills/simready-foundation-conform-fet-005-simulate-grasp-physics/SKILL.md`
or
`$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/simready-foundation/skills/simready-foundation-conform-fet-005-simulate-grasp-physics/SKILL.md`
when browser access is unavailable.

Do not copy FET005 requirement summaries, visual policy, or repair policy into
this repo.

## Local Helper

This directory only keeps a legacy Skill Hub helper script for deterministic
grasp-line authoring and JSON reports. Prefer the upstream Foundation script when
it is available:

```bash
uv run --python 3.12 python "$SIMREADY_FOUNDATION_ROOT/skills/simready-foundation-conform-fet-005-simulate-grasp-physics/scripts/author_grasp_line.py" <usd-asset> \
  --output <staged-output-usd> \
  --point=-0.05,0,0 \
  --point=0.05,0,0 \
  --visual-evidence <render-or-screenshot> \
  --rationale "vision-reviewed graspable region" \
  --report <output-root>/author-grasp-line.json
```

Use the local helper only when the installed Skill Hub workflow needs its
existing report contract:

```bash
python3 scripts/author_grasp_line.py <usd-asset> \
  --output <staged-output-usd> \
  --point=-0.05,0,0 \
  --point=0.05,0,0 \
  --visual-evidence <render-or-screenshot> \
  --rationale "vision-reviewed graspable region" \
  --report <output-root>/author-grasp-line.json
```

Read the upstream Foundation skill before using either script. Treat the upstream
skill as authoritative when its instructions differ from this local wrapper.

## Next Step

After grasp-line authoring, rerun `simready-validate` with the same Foundation
checkout.
