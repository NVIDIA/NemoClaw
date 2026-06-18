# Validate USD Minimum

## When to Use

Use this reference as the first validation gate after conversion. It answers whether a USD asset is structurally usable enough to proceed to geometry, physics, or SimReady profile validation.

This is not a full simulation-readiness check.

## Minimum Checks

Validate:

- the asset path exists
- the USD stage opens
- the stage has a valid `defaultPrim`
- `upAxis` is authored or discoverable
- `metersPerUnit` is authored or discoverable
- the stage has at least one prim
- the root/default prim is valid
- composition dependencies such as payloads and references are resolvable enough for the stage to open

## Instructions

1. Locate the USD asset path.
2. Run this installed reference's portable script from the skill directory or by absolute path.
3. Collect metadata: default prim, up-axis, meters-per-unit, prim count, root prim paths, and used layers.
4. Record failed checks as errors.
5. Record non-blocking concerns as warnings.
6. Emit a minimum USD validation report.
7. If the report passes, hand off to `omni-asset-validate` for executable NVIDIA Asset Validator coverage.

## CLI Pattern

Prefer the installed reference-local script:

```bash
python3 scripts/run.py asset.usda --report minimum-usd-report.json
```

When running from outside the reference directory, use the installed reference path:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/validate-usd-minimum/scripts/run.py asset.usda --report minimum-usd-report.json
```

Check dependencies with:

```bash
python3 scripts/check_dependencies.py --report dependency-check.json
```

## Report Contract

Reports should follow:

```text
scripts/report_schema.json
```

Include:

- `asset_path`
- `validator_skill`
- `validator_tool`
- `passed`
- `checks`
- `metadata`
- `warnings`
- `errors`
- `next_step`

## Pass/Fail Policy

Fail the report when:

- the file does not exist
- the stage cannot be opened
- the default prim is missing or invalid
- the stage has no prims
- `upAxis` or `metersPerUnit` cannot be discovered

Warn, but do not fail, when:

- the asset uses multiple layers
- the asset has no explicit generated conversion report
- the next validation profile is unknown

## Next Steps

Use this handoff:

| Asset intent | Next skill |
|---|---|
| Any converted USD asset | `omni-asset-validate` |
| Generic visual asset after Asset Validator passes | `omni-asset-validate-geometry` |
| Robot, articulation, or rigid body asset after Asset Validator passes | `omni-asset-validate-physics` |
| Selected SimReady target profile | `simready-validate` |
