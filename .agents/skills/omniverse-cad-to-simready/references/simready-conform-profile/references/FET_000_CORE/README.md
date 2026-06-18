# SimReady FET000 Core Local Helper

## Upstream Skill

Source of truth:

```text
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-conform-fet-000-core/SKILL.md
```

Use an authenticated local checkout at
`$SIMREADY_FOUNDATION_ROOT/skills/simready-foundation-conform-fet-000-core/SKILL.md`
or
`$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/simready-foundation/skills/simready-foundation-conform-fet-000-core/SKILL.md`
when browser access is unavailable.

Do not copy FET000 requirement summaries or repair policy into this repo.

## Local Helper

This directory only keeps a legacy Skill Hub helper script for deterministic
metadata updates and JSON reports:

```bash
python3 scripts/run.py <usd-asset> \
  --output-dir <output-root>/<asset-name>/simready_usd \
  --profile Prop-Robotics-Neutral \
  --profile-version 1.0.0 \
  --pipeline-step convert-to-usd \
  --report <output-root>/fet000-core.json
```

Read the upstream Foundation skill before using the helper. Treat the upstream
skill as authoritative when its instructions differ from this local wrapper.

## Next Step

After metadata updates, rerun `simready-validate` with the same Foundation
checkout and route any remaining feature failures through the upstream
`simready-foundation-conform-fet-*` skills.
