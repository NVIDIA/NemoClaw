# SimReady Conform Profile

## When to Use

Use this router reference after USD conversion and property assignment, before
`simready-validate`. It chooses the SimReady feature-level conformance skill
that should repair a failing profile requirement.

This reference ships a narrow `scripts/run.py` router for deterministic Skill
Hub handoff and report generation. It should not be treated as the source of
truth for canonical FET instructions. The source of truth is the SimReady
Foundation repository:

```text
https://github.com/NVIDIA/simready-foundation/tree/main
```

Do not copy upstream FET skill instructions, requirement summaries, validators,
or repair policy into this repo. If browser or raw-file access is unavailable,
use a local checkout and read the upstream `SKILL.md` file directly.

## Prerequisites

- Python 3.12 and `uv` (per repo `README.md`).
- A required `.usd`, `.usda`, `.usdc`, or `.usdz` asset after conversion and
  property assignment.
- OpenUSD Python APIs (`pxr.Usd`, `pxr.UsdGeom`) for local helper scripts when
  they are used.
- A SimReady Foundation checkout at
  `${SIMREADY_FOUNDATION_ROOT:-$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/simready-foundation}`
  or `$HOME/.physical-ai-skill-hub/upstreams/simready-foundation`,
  checked out to branch `main`.

## Scope

This reference owns only Skill Hub routing, report handoff, and local helper
selection. Upstream SimReady Foundation owns feature-level conformance behavior.

## Upstream Skills

Resolve upstream skill files from:

```text
$SIMREADY_FOUNDATION_ROOT/skills/<skill-name>/SKILL.md
```

Use this mapping when routing validation failures:

| Requirement area | Upstream Foundation skill |
|---|---|
| Core metadata, sidecar JSON, asset naming, and package layout failures | `simready-foundation-conform-fet-000-core` |
| Minimal/base-neutral USD feature failures | `simready-foundation-conform-fet-001-minimal` |
| Rigid-body physics failures | `simready-foundation-conform-fet-003-rigid-body-physics` |
| Multibody physics failures | `simready-foundation-conform-fet-004-simulate-multi-body-physics` |
| Prop grasp vector failures for `GSP.001` | `simready-foundation-conform-fet-005-simulate-grasp-physics` |
| Material failures | `simready-foundation-conform-fet-006-materials` |
| Nonvisual material failures | `simready-foundation-conform-fet-007-nonvisual-materials` |
| Robot core profile failures | `simready-foundation-conform-fet-021-robot-core` |
| Robot material failures | `simready-foundation-conform-fet-023-robot-materials` |
| Base articulation failures | `simready-foundation-conform-fet-024-base-articulation` |

The matching branch URLs are:

```text
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-conform-fet-000-core/SKILL.md
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-conform-fet-001-minimal/SKILL.md
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-conform-fet-003-rigid-body-physics/SKILL.md
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-conform-fet-004-simulate-multi-body-physics/SKILL.md
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-conform-fet-005-simulate-grasp-physics/SKILL.md
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-conform-fet-006-materials/SKILL.md
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-conform-fet-007-nonvisual-materials/SKILL.md
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-conform-fet-021-robot-core/SKILL.md
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-conform-fet-023-robot-materials/SKILL.md
https://github.com/NVIDIA/simready-foundation/blob/main/skills/simready-foundation-conform-fet-024-base-articulation/SKILL.md
```

## Local Helper Policy

Some legacy reference-local scripts remain only as narrow report-producing
helpers for the Skill Hub workflow. They are not the FET skill source of truth.
Before running one, read the matching upstream Foundation skill and make sure the
helper still matches the selected profile requirement.

Do not add new copied FET docs to this repo. If a needed repair is fully covered
by an upstream Foundation script, run the upstream script from the Foundation checkout
instead of adding another local implementation here.

## Inputs

Collect:

| Input | Requirement |
|---|---|
| `usd_asset` | Required `.usd`, `.usda`, `.usdc`, or `.usdz` asset after conversion and property assignment. |
| `output_root` | Required or inferred directory for conformance outputs and reports. |
| `simready_profile` | Selected SimReady profile. Default to `Prop-Robotics-Neutral` for generic props unless the user names another profile. |
| `profile_version` | Selected profile version. Default to `1.0.0` unless the user names another version. |
| `validation_report` | Preferred JSON report from `simready-validate`, used to identify failing feature and requirement IDs. |
| `source_asset` | Optional provenance path for metadata. |
| `grasp_target_prim` | Optional prim path for grasp-vector placement. |
| `grasp_points` | Optional explicit grasp vector points. |

For `.usdz`, Core metadata repair may be sidecar-only, but feature repairs that
must author USD prims cannot rewrite a sealed package. Report that limitation
and ask for or produce an unpacked USD-family asset when prim-level repair is
required.

## Profile Policy

Default behavior for current profiles:

| Profile family | Conformance routing |
|---|---|
| `Prop-Robotics-*` | Route Core failures to `simready-foundation-conform-fet-000-core`; route `GSP.001` or FET005 failures to `simready-foundation-conform-fet-005-simulate-grasp-physics`; route material and physics failures to their matching upstream FET skills. |
| `Robot-Body-*` | Route Core failures to `simready-foundation-conform-fet-000-core`; route robot schema, robot material, articulation, and physics failures to the matching upstream robot or physics FET skills. Do not add prop grasp vectors unless the user explicitly asks or validation identifies a matching requirement. |
| Unknown or custom profile | Run profile validation or inspect the failing feature IDs before choosing upstream FET skills. |

Prefer explicit user intent over defaults. Do not guess destructive edits or
overwrite source files.

## Instructions

1. Confirm the USD asset exists.
2. Select the profile and profile version.
3. Read the relevant upstream Foundation skill before authoring any repair.
4. Route Core metadata, naming, and layout failures to
   `simready-foundation-conform-fet-000-core`.
5. Inspect the latest staged USD metadata before final profile validation. If
   `metersPerUnit` is present but not `1.0`, or validation reports `UN.007`,
   route to `simready-foundation-conform-fet-001-minimal` before later feature repairs.
6. Route the next failing feature to the matching upstream FET skill. For
   `GSP.001`, use `simready-foundation-conform-fet-005-simulate-grasp-physics` because it
   owns the visual/semantic grasp decision. For `RB.MB.001` or `FET004_BASE_*`,
   use `simready-foundation-conform-fet-004-simulate-multi-body-physics`; count actual
   `UsdPhysics.RigidBodyAPI` prims and inspect existing component colliders or
   part roots. If there are at least two reusable candidates, run the FET004
   flow instead of marking the profile gate not applicable. If there is only one
   mesh component or one `GeomSubset` component, let `simready-validate` report
   `RB.MB.001` as a non-blocking ignored issue.
7. Preserve every JSON report and summarize each authoring step as pass, fail,
   skipped, or blocked.
8. Stop at the first failed authoring step unless the user asks for best-effort
   continuation.
9. Hand off the latest authored USD path to `simready-validate`.

## Command Patterns

Resolve the Foundation checkout before following any FET skill:

```bash
export PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT="${PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT:-$HOME/.physical-ai-skill-hub/upstreams}"
export SIMREADY_FOUNDATION_ROOT="${SIMREADY_FOUNDATION_ROOT:-$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/simready-foundation}"
git -C "$SIMREADY_FOUNDATION_ROOT" checkout main
```

Read the upstream skill selected by this router:

```bash
sed -n '1,220p' "$SIMREADY_FOUNDATION_ROOT/skills/simready-foundation-conform-fet-005-simulate-grasp-physics/SKILL.md"
```

Run the local router when you already have a validation report, or before final
validation to apply deterministic Core and unit repairs:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/simready-conform-profile/scripts/run.py \
  /path/to/output_dir/physics/output_physics.usd \
  --output-dir /path/to/output_dir/conform/profile \
  --validation-report /path/to/output_dir/validation/simready-profile.json \
  --profile Prop-Robotics-Neutral \
  --profile-version 1.0.0 \
  --source-asset /path/to/source.step \
  --pipeline-step usd-convert-cad \
  --pipeline-step material-agent-client \
  --pipeline-step physics-agent-client \
  --report /path/to/output_dir/conform/profile/simready-conform-profile.json
```

For `GSP.001`, pass at least two explicit `--grasp-point x,y,z` values selected
from visual evidence. Without explicit points, the router records FET005 as
blocked instead of authoring a placeholder grasp line.

Run upstream scripts from the Foundation checkout when the upstream skill provides
them. For example, after visual review has selected explicit grasp points:

```bash
uv run --python 3.12 python "$SIMREADY_FOUNDATION_ROOT/skills/simready-foundation-conform-fet-005-simulate-grasp-physics/scripts/author_grasp_line.py" \
  /path/to/output_dir/conform/metadata/asset.usda \
  --output /path/to/output_dir/conform/grasp/asset.usda \
  --name grasp_identifier_01 \
  --point=-0.05,0.0,0.0 \
  --point=0.05,0.0,0.0 \
  --rationale "vision-reviewed graspable region" \
  --report /path/to/output_dir/conform/grasp/author-grasp-line.json
```

Then validate:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/simready-validate/scripts/run.py /path/to/output_dir/conform/grasp/asset.usda \
  --profile Prop-Robotics-Neutral \
  --profile-version 1.0.0 \
  --foundation-root "$SIMREADY_FOUNDATION_ROOT" \
  --report /path/to/output_dir/validation/simready-profile.json
```

## Output Format

The workflow summary should include:

| Field | Meaning |
|---|---|
| `input_usd_path` | USD path received by this workflow. |
| `output_usd_path` | Latest authored USD path after conformance. |
| `simready_profile` | Selected profile name. |
| `profile_version` | Selected profile version. |
| `upstream_skill` | Upstream Foundation skill name and URL used for each repair. |
| `steps` | Ordered FET conformance step results. |
| `reports` | Paths to each selected feature repair JSON report. |
| `passed` | Whether all required conformance steps passed. |
| `next_step` | Usually `simready-validate`. |

## Limitations

- This reference does not predict material, physics, or texture properties.
- This reference does not perform final validation; run `simready-validate`
  after conformance authoring.
- For `.usdz`, Core metadata repair may be sidecar-only, but feature repairs
  that must author USD prims cannot rewrite a sealed package.
- Do not guess destructive edits or overwrite source files.
- Do not copy upstream SimReady Foundation FET skill docs into this repo.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Foundation skill file is missing | `SIMREADY_FOUNDATION_ROOT` points to the wrong checkout or branch | Check out `https://github.com/NVIDIA/simready-foundation` at `main`. |
| Sealed `.usdz` cannot be repaired in place | Feature repairs that author USD prims cannot rewrite a sealed package | Produce or request an unpacked USD-family asset before running prim-level repair. Core metadata repair may still proceed sidecar-only. |
| `GSP.001` failure reported as final without classification | Vision-capable inspection or explicit grasp points were not available | Route to upstream `simready-foundation-conform-fet-005-simulate-grasp-physics`. If neither vision nor explicit points are available, report the FET005 step as `blocked`. |
| `RB.MB.001` failure reported after Physics Agent | The USD has fewer than two `UsdPhysics.RigidBodyAPI` prims, even if it has many visual or collider prims | Route to upstream `simready-foundation-conform-fet-004-simulate-multi-body-physics` when there are at least two existing component colliders or part roots that represent source parts. If the asset has only one mesh component or one `GeomSubset` component, `simready-validate` treats `RB.MB.001` as non-blocking and preserves it under `ignored_issues`; do not invent geometry. |

## Pass/Fail Policy

Fail when:

- the input USD asset does not exist
- the selected upstream Foundation skill cannot be found
- the selected feature repair fails
- a required conformance step cannot run because the asset format is unsupported
- the output path would overwrite without explicit `--force`

Skip when:

- a profile family does not require a conformance action, such as prop grasp
  vectors on a robot body profile
- the user explicitly asks to defer a feature repair such as grasp vectors or
  metadata

Warn when:

- the Foundation checkout is not pinned to `main`
- profile-specific requirements are unknown and only Core metadata repair was
  authored
- a grasp placement needs visual evidence or user-approved explicit points
- `.usdz` input prevents in-package grasp vector authoring

## Next Steps

After conformance authoring passes, run `simready-validate` with the selected
profile and the same Foundation checkout. If validation still fails, use the failed
requirement IDs to decide whether to rerun the upstream FET skill with better
parameters or add a new upstream SimReady Foundation skill.
