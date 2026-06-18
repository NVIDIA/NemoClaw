# SimReady Validate Profile

## When to Use

Use this reference after Content Agents assignment, post-assignment
`simready-conform-profile`, `validate-usd-minimum`, and `omni-asset-validate`
have run, and the user has selected, or needs help selecting, a SimReady
Foundation profile. This is a validation-only skill: it reports profile
conformance and blockers, but does not repair or stamp assets unless explicitly
requested. For end-to-end CAD-to-SimReady workflows where material/physics
assignment will run, do not run this reference before Content Agents. The only
pre-assignment validation gate should be `validate-usd-minimum`.

SimReady Foundation organizes validation in four layers:

- Requirements: atomic checks such as `UN.006` or `VG.MESH.001`
- Capabilities: grouped requirements such as `units` or `geometry`
- Features: use-case bundles such as `FET001_BASE_NEUTRAL`
- Profiles: named bundles of features such as robotics prop or robot-body profiles

## Dependency Check

Require:

- Prefer a ready `PHYSICAL_AI_PREFLIGHT_MANIFEST` from the `preflight`
  reference. This wrapper consumes the prepared SimReady Foundation root and
  `simready-validate` executable from that manifest before falling back to
  direct legacy discovery. When `PHYSICAL_AI_REQUIRE_PREFLIGHT=1` is set,
  missing profile-validation readiness blocks at the preflight guardrail.
- `simready.validate` / `simready-validate` from NVIDIA SimReady Foundation, or a source checkout with `requirements.txt` or `nv_core/validator_sample/requirements.txt`
- Upstream source: `https://github.com/NVIDIA/simready-foundation` on branch `main`
- Temporary aarch64 OpenUSD runtime fallback: NVIDIA OpenUSD Exchange SDK package `usd-exchange>=2.3.0` from `https://github.com/NVIDIA-Omniverse/usd-exchange`
- SimReady Foundation spec files: `capabilities/`, `features/`, and `profiles/profiles.toml`

Check installed reference dependencies with:

```bash
python3 scripts/check_dependencies.py --report dependency-check.json
```

If `--foundation-root`, `--foundation-spec-root`, `SIMREADY_FOUNDATION_ROOT`, and `SIMREADY_FOUNDATION_SPEC_ROOT` are not configured and no installed `simready.validate` specs are available, provide a checkout under `$HOME/.physical-ai-skill-hub/upstreams/simready-foundation` or `$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/simready-foundation`, checked out to `main`, and load `nv_core/sr_specs/docs` plus `nv_core/validator_sample` from that checkout.

If `simready-validate` is not on `PATH`, do not stop there. `scripts/run.py` must install the runtime from the Foundation checkout's root `requirements.txt` when present, otherwise from `nv_core/validator_sample/requirements.txt`, into a dedicated venv and use that executable. Override the venv with `PHYSICAL_AI_SIMREADY_VALIDATE_VENV`; otherwise the default is `$XDG_CACHE_HOME/physical-ai-skill-hub/simready-validate-venv` or `$HOME/.cache/physical-ai-skill-hub/simready-validate-venv`.

Until the upstream Foundation dependency metadata is fixed, Linux aarch64 hosts need one extra guardrail: PyPI `usd-core` is not available for this architecture, while `usd-exchange` ships the required OpenUSD Python modules and shared libraries for aarch64. If the normal Foundation `requirements.txt` install fails because `usd-core` cannot resolve, `scripts/run.py` must retry in the same dedicated venv by installing `usd-exchange>=2.3.0`, `omniverse-asset-validator`, `omniverse-usd-profiles`, the non-`simready-validate` Foundation requirements such as `numpy`, and then `simready-validate` itself with `--no-deps`. Do not report `BLOCKED` for the aarch64 `usd-core` resolver failure until this USD Exchange SDK fallback has also failed.

Do not fall back to local profile presets or direct `omni_asset_validate` feature/capability flags for validation. Report `BLOCKED` only when the executable is unavailable, no usable Foundation checkout/spec root exists for installation and validation, or both the normal Foundation install and the aarch64 USD Exchange SDK fallback fail.

## Target Selection

Supported formal profiles are loaded from SimReady Foundation `profiles.toml`. The default profile is:

```text
Prop-Robotics-Neutral@1.0.0
```

Use `--list-profiles` to expose selectable profile options before running validation:

```bash
simready-validate --list-profiles --foundation-root /path/to/simready-foundation
```

Recognize these common profile names:

| Profile | Use |
|---|---|
| `Prop-Robotics-Neutral` | Neutral robotics prop profile. |
| `Prop-Robotics-Physx` | Robotics prop with PhysX rigid-body simulation requirements. |
| `Prop-Robotics-Isaac` | Isaac Sim-oriented robotics prop profile. |
| `Robot-Body-Neutral` | Neutral robot body profile. |
| `Robot-Body-Runnable` | Runnable robot body profile with PhysX/articulation/drive requirements. |
| `Robot-Body-Isaac` | Isaac Sim robot body profile. |

For URDF or MuJoCo robot assets, prefer `Robot-Body-Runnable` unless the user names another profile. For generic CAD/mesh props, prefer the default `Prop-Robotics-Neutral`. Use `Prop-Robotics-Physx` when the user asks for PhysX-specific prop validation.

## Instructions

1. Confirm the asset is an existing USD asset path.
2. Confirm Content Agents and post-assignment conformance have already run when
   property assignment is in scope. If the request is explicitly
   validation-only or property assignment was skipped, record that exception.
3. Confirm earlier validation has passed, or state that minimum USD and generic Asset Validator checks should run first.
4. Select a formal SimReady Foundation profile from user intent and asset type.
5. Resolve the SimReady Foundation source checkout from `--foundation-root` or `SIMREADY_FOUNDATION_ROOT`; alternatively resolve specs from `--foundation-spec-root` or `SIMREADY_FOUNDATION_SPEC_ROOT`. If no path is configured, use `$PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT/simready-foundation` or `$HOME/.physical-ai-skill-hub/upstreams/simready-foundation`, checked out to `main`.
6. Run this reference's portable `scripts/run.py`, which installs `simready-validate` from the Foundation checkout when the CLI is missing on `PATH`, uses the temporary USD Exchange SDK runtime fallback on Linux aarch64 when PyPI `usd-core` cannot resolve, then uses Foundation `simready-validate`/`validator_sample` behavior to load Foundation `capabilities`, `features`, and `profiles/profiles.toml`.
7. Parse profile, feature, requirement, issue, warning, and error results from the Foundation validation runtime.
8. Inspect the asset topology with OpenUSD. Treat `RB.MB.001` as non-blocking when the asset has only one mesh component or one `GeomSubset` component, because there is no reusable multi-body component structure to promote. Preserve the ignored issue under `ignored_issues`, add a warning, and pass the profile if no other failures remain.
9. Fail when any selected profile feature fails or any issue has `ERROR` or `FAILURE` severity after applying the single-component `RB.MB.001` policy.
10. Report a structured SimReady profile validation result.

## CLI Pattern

Prefer the installed reference-local script for runtime checks:

```bash
python3 scripts/run.py asset.usda \
  --profile Prop-Robotics-Neutral \
  --report report.json

SIMREADY_FOUNDATION_ROOT=/path/to/simready-foundation \
  python3 scripts/run.py asset.usda --profile Prop-Robotics-Neutral --report report.json

python3 scripts/run.py asset.usda \
  --profile Robot-Body-Runnable \
  --foundation-root /path/to/simready-foundation \
  --report report.json
```

Do not use `--fix`, `--stamp`, or profile adaptation unless the user explicitly asks for those operations.

When running from outside the reference directory, use the installed reference path:

```bash
python3 /path/to/skills/omniverse-cad-to-simready/references/simready-validate/scripts/run.py asset.usda --profile Prop-Robotics-Neutral --report report.json
```

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
- `profile_name`
- `profile_target`
- `command`
- `available_profiles`
- `profile_results`
- `feature_results`
- `requirement_counts`
- `issue_counts`
- `issues`
- `ignored_issues`
- `asset_topology`
- `validation_policy`
- `warnings`
- `errors`
- `next_step`

## Pass/Fail Policy

Fail when:

- required validator dependencies are missing
- the selected SimReady Foundation profile is unknown or not present in `profiles.toml`
- the Foundation validation runtime returns `FAIL` or `ERROR`
- any issue has severity `ERROR` or `FAILURE` after the single-component `RB.MB.001` policy is applied
- any selected feature reports failed requirements after the single-component `RB.MB.001` policy is applied

Warn when:

- the target is narrower than the user's stated use case
- profile stamping or adaptation is requested but not available in the runtime
- `RB.MB.001` is ignored as non-blocking because the USD has only one mesh component or one `GeomSubset` component

## Next Steps

Use this handoff:

| Result | Next step |
|---|---|
| Passes selected profile | Report validation result and preserve the JSON report. |
| Fails selected profile feature | Send issues to a post-assignment repair loop through `simready-conform-profile`, then rerun this reference on the newest authored USD. |
| SimReady Foundation runtime blocked | Provide a `simready-foundation` checkout on branch `main` with `--foundation-root` or `SIMREADY_FOUNDATION_ROOT`, then retry so `scripts/run.py` can install the compatible runtime from `requirements.txt`; on Linux aarch64, confirm the USD Exchange SDK fallback was attempted after any `usd-core` resolver failure. |
