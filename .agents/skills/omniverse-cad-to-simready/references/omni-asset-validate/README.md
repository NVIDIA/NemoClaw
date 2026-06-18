# Validate Usd Asset Validator

## When to Use

Use this reference after `validate-usd-minimum` passes and the asset needs executable NVIDIA Asset Validator coverage. This is a validation-only skill: it reports issues and recommended next steps, but does not apply fixes unless explicitly requested.

## Dependency Check

Require the installed reference dependency check:

```bash
python3 scripts/check_dependencies.py --report dependency-check.json
```

This reference wraps `nvidia_usd_validate` from `usd-validation-nvidia`.
When the CLI entrypoint is not on `PATH` but the Python package is importable,
the wrapper uses `python -m usd_validation_nvidia` instead of reporting a
missing dependency. Legacy `omni_asset_validate` and `python -m
omni.asset_validator` runtimes remain accepted as compatibility fallbacks.

If neither a supported CLI nor Python module is available, report
`blocked_missing_dependency`.

## Instructions

1. Confirm the input is a USD asset path or an asset directory.
2. Confirm `validate-usd-minimum` has passed, or run it first when basic USD viability is unknown.
3. Choose the Asset Validator scope: all default rules, one or more categories, or specific rules.
4. Run validation with `omni-asset-validate`.
5. Normalize issues by severity, rule, message, location, and suggested fix when available.
6. Fail the report on Asset Validator errors or failures.
7. Warn on Asset Validator warnings unless the active workflow profile promotes them to failures.
8. Hand off passing geometry-oriented assets to `omni-asset-validate-geometry`, physics-oriented assets to `omni-asset-validate-physics`, or selected profile assets to `simready-validate`.

## CLI Pattern

Prefer the installed reference script for runtime checks:

```bash
python3 scripts/run.py asset.usda --report asset-validator-report.json
python3 scripts/run.py --category Geometry asset.usda --report geometry-report.json
python3 scripts/run.py --no-init-rules --rule StageMetadataChecker asset.usda
```

Do not use `--fix` unless the user explicitly asks for auto-repair behavior.

When running from outside the reference directory, use the installed reference path:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/omni-asset-validate/scripts/run.py asset.usda --report asset-validator-report.json
```

Use `--timeout SECONDS` for large CAD-derived USD assets. If Asset Validator
exceeds the timeout, the wrapper emits a structured report with
`status: TIMEOUT` instead of a Python traceback.

## Categories

Common categories include:

- `Basic`
- `Geometry`
- `Layer`
- `Layout`
- `Material`
- `Physics`
- `Other`

## Output Format

Reports should include:

- `asset_path`
- `validator_skill`
- `validator_tool`
- `passed`
- `categories`
- `rules`
- `issue_counts`
- `issues`
- `warnings`
- `errors`
- `next_step`

Each `issues` entry should preserve the upstream rule name, severity, message,
location, requirement identifier, and fix suggestion when Asset Validator emits
them.

## Pass/Fail Policy

Fail when:

- the Asset Validator dependency is missing
- the asset cannot be opened by Asset Validator
- any issue has severity `ERROR` or `FAILURE`

Warn when:

- issues have severity `WARNING`
- the selected category or rule set is narrower than the requested validation goal
- auto-fix suggestions exist but were not applied

## Next Steps

Use this handoff:

| Asset intent | Next skill |
|---|---|
| General USD compliance passed | `omni-asset-validate-geometry` |
| Robot, articulation, or rigid body asset | `omni-asset-validate-physics` |
| Selected SimReady target profile | `simready-validate` |
