# Validate USD Geometry

## When to Use

Use this reference after `omni-asset-validate` passes and before physics or SimReady profile validation. This is a validation-only skill: it reports geometry issues and recommended next steps, but does not repair meshes.

## Dependency Check

Geometry validation depends on the same Asset Validator runtime as the broader
`omni-asset-validate` reference, but this wrapper always requests the
`Geometry` category. Verify the local wrapper before using it:

```bash
python3 scripts/check_dependencies.py --report dependency-check.json
```

The check accepts either the `omni_asset_validate` executable from
`omniverse-asset-validator` or the importable `omni.asset_validator` Python
module. When only the module is available, `scripts/run.py` invokes it through
the current Python executable with `--category Geometry`; when both runtimes are
missing, report `blocked_missing_dependency`.

## Geometry Checks

Run the NVIDIA Omniverse Asset Validator `Geometry` category. This covers rules such as normals, topology, extents, subdivision, primvars, manifold checks, winding checks, weld checks, zero-area faces, and unused mesh data where available in the installed validator.

## Instructions

1. Confirm the input is an existing USD asset path.
2. Confirm `validate-usd-minimum` and `omni-asset-validate` have passed, or report that they should run first.
3. Run `omni-asset-validate-geometry`, which invokes Asset Validator with `--category Geometry`.
4. Normalize issues by severity, rule, message, location, requirement, and suggestion.
5. Fail the report on `ERROR` or `FAILURE` issues.
6. Warn on geometry warnings or when no mesh-bearing geometry exists but the user's target requires visual mesh content.
7. Hand off passing assets to `omni-asset-validate-physics` or `simready-validate` depending on the workflow.

## CLI Pattern

```bash
python3 scripts/run.py asset.usda --report geometry-report.json
```

Do not use `--fix` unless the user explicitly asks for repair behavior.

When running from outside the reference directory, use the installed reference path:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/omni-asset-validate-geometry/scripts/run.py asset.usda --report geometry-report.json
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
- any geometry issue has severity `ERROR` or `FAILURE`

Warn when:

- geometry issue severity is `WARNING`
- the asset's intended target requires mesh-backed visuals but only primitive geometry is present
- the selected validation goal needs stricter formal SimReady profile checks such as `Prop-Robotics-Physx`

## Next Steps

Use this handoff:

| Asset intent | Next skill |
|---|---|
| Robot, articulation, or rigid body asset | `omni-asset-validate-physics` |
| Visual-only asset with selected SimReady target | `simready-validate` |
| Geometry validation failed | Future repair/retry skill |
