# Use USD Exchange

## What Is USD Exchange?

For the overview of USD Exchange and its features, read the upstream USD
Exchange README first:
`https://github.com/NVIDIA-Omniverse/usd-exchange/blob/main/README.md`.

For agent-facing authoring guidance, use the upstream USD Exchange skills:
`https://github.com/NVIDIA-Omniverse/usd-exchange/tree/main/.agents/skills`.

Do not infer a local explanation of USD Exchange from this Skill Hub reference.
This repository only records how the upstream USD Exchange SDK / usdex
authoring rules attach to Physical AI Skill Hub code.

## When to Use

Use this reference when changing repo code that authors or rewrites USD opinions. It is a Skill-Hub-side binding layer for OpenUSD Exchange SDK 2.3. Keep the upstream SDK skills as the source of authoring rules; this reference only records how those rules attach to this repository.

This is a repository-maintenance skill, not a public installed asset-processing runtime. It is documentation-driven and does not ship `scripts/run.py`.

Do not copy the upstream `usd-authoring` reference set into this repo. Use the tagged upstream `v2.3.0` agent skill and the final public package floor `usd-exchange>=2.3.0`.

## When To Apply

Apply when editing:

- `omniverse-cad-to-simready/references/simready-conform-profile/references/FET_000_CORE/scripts/run.py`
- `omniverse-cad-to-simready/references/simready-conform-profile/references/FET_001_MINIMAL/scripts/run.py`
- `omniverse-cad-to-simready/references/simready-conform-profile/references/FET_005_SIMULATE_GRASP_PHYSICS/scripts/author_grasp_line.py`
- `omniverse-cad-to-simready/references/ovrtx-render-service/scripts/run.py`
- new reference-local USD authoring scripts
- converter wrappers whose output is handed to `omni-asset-validate`

Stop when the task is limited to read-only USD validation, packaging manifests, subprocess wrappers around external converters, or non-usdex metadata surfaces that the SDK does not cover.

## Source Of Truth

- `https://github.com/NVIDIA-Omniverse/usd-exchange/blob/v2.3.0/AGENTS.md`
- `https://github.com/NVIDIA-Omniverse/usd-exchange/blob/v2.3.0/.agents/skills/usd-authoring/SKILL.md`

If those URLs are not available, do not substitute stale copied rules. Use an authenticated local checkout of `https://github.com/NVIDIA-Omniverse/usd-exchange` at tag `v2.3.0` and read the same paths from that checkout.

## Skill Hub Bindings

Use a module-level `AUTHORING_METADATA` constant in this form:

```text
physical-ai-skill-hub <entrypoint-or-skill-name> v<repo-version>
```

Pass that constant to every `usdex.core.createStage`, `configureStage`, `saveStage`, `saveLayer`, or `exportLayer` call introduced by this repo.

For developer verification inside this repository, run the portable skill tests:

```bash
uv run --python 3.12 pytest tests/test_portable_skill_scripts.py
```

Do not introduce package console entrypoints as the public installed-skill execution path.

## Validation Handoff

After authoring or conversion, route validation in this order:

1. `validate-usd-minimum`
2. `omni-asset-validate`
3. `omni-asset-validate-geometry` and `omni-asset-validate-physics` as applicable
4. `simready-validate` for SimReady assets

Use the installed `omniverse-cad-to-simready/references/omni-asset-validate/scripts/run.py` wrapper for hub-level validation. Reserve `usdex.test.TestCase.assertIsValidUsd` for unit tests that directly exercise SDK authoring behavior.

## Anti-Pattern Catalog

| Surface | Avoid | Use |
|---|---|---|
| `omniverse-cad-to-simready/references/simready-conform-profile/references/FET_005_SIMULATE_GRASP_PHYSICS/scripts/author_grasp_line.py` | `UsdGeom.BasisCurves.Define`, manual primvars, hand-rolled child-name scans | `usdex.core.defineLinearBasisCurves`, `Vec3fPrimvarData`, `FloatPrimvarData`, `NameCache.getPrimName` |
| `ovrtx-render-service` | `UsdGeom.Camera.Define`, per-attribute camera writes, direct xform op authoring | `usdex.core.defineCamera(stage, path, Gf.Camera)` |
| `omniverse-cad-to-simready/references/simready-conform-profile/references/FET_000_CORE/scripts/run.py` | direct `root_layer.Save()` after root-layer edits | `usdex.core.saveLayer(layer, AUTHORING_METADATA)` |
| new authoring modules | `Usd.Stage.CreateNew` plus manual stage setup | `usdex.core.createStage(..., authoringMetadata=AUTHORING_METADATA)` |
| new names | raw string literals passed as prim names | `NameCache` or `usdex.core.getValidPrimName` |

## Next Steps

- For grasp vector changes, use upstream `simready-foundation-conform-fet-005-simulate-grasp-physics` after this reference.
- For render auto-camera changes, use `ovrtx-render-service` after this reference.
- For conversion routing changes, use `convert-to-usd` and preserve the usdex backing note there.
