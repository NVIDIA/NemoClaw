# SimReady FET001 Minimal Local Helper

## Upstream Skill

Source of truth:

```text
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-conform-fet-001-minimal/SKILL.md
```

Use an authenticated local checkout at
`$SIMREADY_FOUNDATION_ROOT/skills/simready-foundation-conform-fet-001-minimal/SKILL.md`
or
`$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/simready-foundation/skills/simready-foundation-conform-fet-001-minimal/SKILL.md`
when browser access is unavailable.

Do not copy FET001 requirement summaries or repair policy into this repo.

## Local Helper

This directory only keeps a legacy Skill Hub helper script for deterministic
unit normalization and JSON reports:

```bash
python3 scripts/run.py <usd-asset> \
  --output-dir <output-root>/conform/minimal \
  --profile Prop-Robotics-Neutral \
  --profile-version 1.0.0 \
  --report <output-root>/fet001-minimal.json
```

Read the upstream Foundation skill before using the helper. Treat the upstream
skill as authoritative when its instructions differ from this local wrapper.

The local helper defaults to `rootLayer.Save()` for persistence. Some mixed
OpenUSD/usdex runtimes can abort the Python process inside
`usdex.core.saveLayer`, which prevents normal exception fallback. Use
`--save-backend usdex` or `FET001_SAVE_BACKEND=usdex` only after validating that
backend in the current runtime.

## Next Step

After minimal conformance, rerun `simready-validate` or route the next failing
feature through the upstream `simready-foundation-conform-fet-*` skills.
