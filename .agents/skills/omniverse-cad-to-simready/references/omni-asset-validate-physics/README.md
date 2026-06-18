# Validate USD Physics

## When to Use

Use this reference after geometry validation when the asset is intended for simulation, robotics, rigid-body interaction, or articulation workflows. This is a validation-only skill: it reports physics issues and capability gaps, but does not author missing physics data.

## Dependency Check

Physics validation uses Asset Validator with a physics-specific category
selection, so confirm this reference's wrapper can locate the runtime before
running simulation checks:

```bash
python3 scripts/check_dependencies.py --report dependency-check.json
```

`scripts/run.py` prefers the `omni_asset_validate` CLI from
`omniverse-asset-validator`. If that executable is not on `PATH` but the
`omni.asset_validator` module can be imported, the wrapper falls back to
`python -m omni.asset_validator --category Physics`. If neither path is
available, report `blocked_missing_dependency`.

## Physics Checks

Run the NVIDIA Omniverse Asset Validator `Physics` category. This covers physics-oriented rules such as rigid body, collider, joint, articulation, and mass checks where those schemas are present in the asset and supported by the installed validator.

## Instructions

1. Confirm the input is an existing USD asset path.
2. Confirm `validate-usd-minimum`, `omni-asset-validate`, and `omni-asset-validate-geometry` have passed, or report that they should run first.
3. Run `omni-asset-validate-physics`, which invokes Asset Validator with `--category Physics`.
4. Normalize issues by severity, rule, message, location, requirement, and suggestion.
5. Fail the report on `ERROR` or `FAILURE` issues.
6. Warn when physics checks pass but the asset has no authored physics for a simulation target that requires it.
7. Hand off passing assets to `simready-validate`.

## CLI Pattern

```bash
python3 scripts/run.py asset.usda --report physics-report.json
```

Do not use `--fix` unless the user explicitly asks for repair behavior.

When running from outside the reference directory, use the installed reference path:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/omni-asset-validate-physics/scripts/run.py asset.usda --report physics-report.json
```

Use `--timeout SECONDS` for large CAD-derived USD assets. If Asset Validator
exceeds the timeout, the wrapper emits a structured report with
`status: TIMEOUT` instead of a Python traceback.

## Output Format

Reports should follow:

```text
scripts/report_schema.json
```

Include:

- `asset_path`
- `validator_skill`
- `validator_tool`
- `passed`
- `status`
- `command`
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
- Asset Validator cannot process the asset
- any physics issue has severity `ERROR` or `FAILURE`

Warn when:

- physics issue severity is `WARNING`
- the asset is intended for simulation but lacks authored physics schemas
- the selected SimReady target requires physics capabilities not validated by the current profile

## Next Steps

Use this handoff:

| Result | Next step |
|---|---|
| Physics validation passed | `simready-validate` |
| Physics validation passed but physics is missing for target intent | Future property assignment or repair skill |
| Physics validation failed | Future repair/retry skill |
