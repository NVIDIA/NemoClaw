---
name: omniverse-cad-to-simready
description: "Coordinate the end-to-end CAD/source-asset to SimReady workflow. Use for broad requests such as CAD to SimReady, source asset to simulation-ready USD, or prop packaging that require conversion, material/physics assignment, SimReady conformance, validation, and optional package creation; deploy or verify Content Agents services first when property assignment is enabled; route single-stage work through nested references."
version: "0.1.0"
license: Apache-2.0
tools:
  - Read
  - Shell
compatibility: >
  Orchestrator skill. Managed Content Agents deployment requires NVIDIA_API_KEY
  (build.nvidia.com), Docker + NVIDIA Container Toolkit + GPU, Python 3.12, and
  an upstream checkout of nvidia-omniverse/content-agents on branch
  main. Reused/provided endpoints may instead use explicit endpoint and
  usage-token environment variables. Linux/macOS only.
metadata:
  author: Omniverse
  tags:
    - physical-ai
    - simready
    - workflow
    - cad
    - conversion
  domain: ai-ml
  languages:
    - python
---

# CAD to SimReady

## When to Use

Use this workflow skill when the user wants an end-to-end pipeline from a
source asset to a SimReady asset or package. This skill coordinates existing
conversion, authoring, validation, conformance, rendering, and packaging
references directly. Do not replace the workflow with a single monolithic
runner command.

This skill is documentation-driven and does not ship `scripts/run.py`. It
should not depend on a repository checkout. When a stage needs deterministic
execution, run the portable script from that stage reference's installed
directory. `Shell` is declared because this workflow invokes installed stage
reference scripts directly; it still must not grow a monolithic runner.

## Prerequisites

- Prefer running the `preflight` reference first for deterministic setup. It
  installs or verifies local upstream checkouts, writes a
  `cad-to-simready-preflight.json` manifest, and exports
  `PHYSICAL_AI_PREFLIGHT_MANIFEST` plus `PHYSICAL_AI_REQUIRE_PREFLIGHT=1` for
  downstream references.
- Python 3.12 and `uv` (per repo `README.md`).
- NVIDIA_API_KEY from `https://build.nvidia.com` when local Content Agents
  deployment will run. Already-running endpoints may instead use explicit
  endpoint variables plus usage tokens such as `NGC_API_KEY`, `NVCF_API_KEY`,
  or `CONTENT_AGENTS_*_TOKEN`.
- Docker, NVIDIA Container Toolkit, and an NVIDIA GPU for Content Agents and
  OVRTX stages.
- Local upstream checkouts under
  `${PHYSICAL_AI_SKILL_HUB_UPSTREAM_ROOT:-$HOME/.physical-ai-skill-hub/upstreams}`
  when a downstream stage needs upstream scripts or specs.

## Minimum Viable Scope

Conversion-only is a valid workflow request. When the user asks only to convert
or smoke-test source asset conversion, set `property_assignment_intent=skip`,
do not deploy Content Agents, run `convert-to-usd`, then run
`validate-usd-minimum` on the generated USD if conversion succeeds.

Do not imply that `uv sync` installs every source converter runtime. URDF,
MuJoCo/MJCF, and the repo Python dependencies are handled by the project
environment, but NVIDIA-backed source conversion requires an installed and
validated `NVIDIA-Omniverse/usd-convert-cad` checkout. If that runtime is
missing or does not support the source, preserve the blocked conversion report
and its `install_hint` instead of attempting an unrequested local build or
substituting another converter.

## First Action

For any broad CAD/source-asset to SimReady request, assume
`property_assignment_intent=run` unless the user explicitly asks for
conversion-only, validation-only, or no material/physics assignment.

Before invoking converter, validation, Content Agents, OVRTX, packaging, or FET
helper scripts, run the `preflight` reference or verify an existing
`PHYSICAL_AI_PREFLIGHT_MANIFEST`. Treat preflight as the mandatory dependency
bootstrap step, not as workflow routing. If the user explicitly asks not to
deploy services or asks for conversion-only/validation-only, use
`--skip-content-agents`.
When `PHYSICAL_AI_REQUIRE_PREFLIGHT=1` is set and a required component is not
ready in the manifest, downstream references must block with the preflight
guardrail instead of rediscovering upstreams or services directly.

When `property_assignment_intent=run`, the first operational action after
confirming the source path and resolving intent is to verify or deploy Content
Agents services. Do this before asset-context inspection, converter dependency
checks, conversion, validation, conformance, rendering, packaging, or upstream
source builds.

Use healthy existing endpoints when available. If OVRTX, Material, or Physics
endpoints are missing or unhealthy, run `deploy-content-agents`
first and do not continue until the shared standalone OVRTX renderer plus
independent Material and Physics service containers are healthy and exported
through `CONTENT_AGENTS_*_BASE_URL`. Deploy the Texture Agent too when texture
generation is requested.

If required deployment authentication is missing, ask the user for
`NVIDIA_API_KEY` and wait. If a provided endpoint requires usage auth, ask for
the appropriate usage token instead. If deployment cannot produce healthy
services, report Content Agents readiness as blocked instead of proceeding to
conversion.

## Instructions

1. Confirm the source asset path exists, resolve `output_root`, and classify
   the request as end-to-end, conversion-only, validation-only, or packaging.
2. Resolve `property_assignment_intent` before running any asset inspection,
   converter probe, conversion, validation, conformance, rendering, or
   packaging step.
3. Run `preflight` for the selected workflow targets, unless a ready
   `PHYSICAL_AI_PREFLIGHT_MANIFEST` is already configured. Source the generated
   env file before running downstream scripts. Treat preflight as dependency
   setup only: it may use a provided `--source-asset`, `--source-format`, or
   `--conversion-tools` value to scope dependency checks, but `convert-to-usd`
   and the upstream converter references still decide actual conversion support.
4. Verify or deploy Content Agents services first when
   `property_assignment_intent=run`; block on missing authentication or
   unhealthy services instead of continuing.
5. Read `references/workflow.md` and `references/commands.md`, then run only
   the stage references needed for the current request.
6. Run `identify-asset-context` on the original source asset when web search is
   available or property assignment will run.
7. Route the source through `convert-to-usd`, or skip conversion for existing
   USD input and treat the source path as the current USD path.
8. Run `validate-usd-minimum` before expensive downstream work. Treat this as a
   viability gate only: record unit/profile issues such as `metersPerUnit !=
   1.0`, but do not run `simready-conform-profile`, FET001, or any other FET
   repair before Content Agents assignment when property assignment will run.
9. Run Content Agents material, physics, and optional texture assignment on the
   converted/minimum-valid USD when requested or required.
10. Run `simready-conform-profile` on the latest simulation USD path after
   property assignment and preserve every selected FET repair report.
11. Run validation gates in order: `omni-asset-validate`,
   `omni-asset-validate-geometry`, `omni-asset-validate-physics`, and
   `simready-validate`.
12. Rerun `simready-conform-profile` when `simready-validate` reports a
    repairable requirement, then rerun profile validation on the newest authored
    USD.
13. Run `ovrtx-render-service` when preview, thumbnail, or inspection images
    are requested. When package outputs are requested, run
    `assemble-package-source` next to create the clean `deliverable/` package
    source from the final USD and thumbnail, then run `nv-core-package-sample`
    and `nv-core-package-sample-validation` on that deliverable folder only.
14. Emit the consolidated workflow report with the final USD path, all stage
    reports, validation findings, rerun reasons, and next work.

Use the `simready-conform-profile` reference only after property assignment
when `property_assignment_intent=run`. It routes feature repair to upstream
SimReady Foundation FET skills such
as `simready-foundation-conform-fet-000-core`,
`simready-foundation-conform-fet-001-minimal`,
`simready-foundation-conform-fet-004-simulate-multi-body-physics`, and
`simready-foundation-conform-fet-005-simulate-grasp-physics` from branch
`main`.

If `simready-validate` reports a repairable requirement after the first
conformance pass, feed the structured requirement IDs back into
the `simready-conform-profile` reference before writing the final result. In
particular, `GSP.001` is owned by upstream
`simready-foundation-conform-fet-005-simulate-grasp-physics`; run that skill when a
vision-capable agent can inspect visual evidence or explicit grasp points were
provided, otherwise record the FET005 step as blocked by missing vision/points
instead of treating it as an optional preview task.
For `RB.MB.001`, route the failure to
upstream `simready-foundation-conform-fet-004-simulate-multi-body-physics`. Do not assume
multiple visual prims are multiple rigid bodies; inspect
`UsdPhysics.RigidBodyAPI` applications. When the Physics Agent report shows
composed topology optimization or the USD has existing component colliders/part
roots and the profile validator reports FET004/RB.MB.001, FET004 should promote
those existing components into rigid bodies without creating geometry. Do not
mark the gate not applicable until after confirming there are fewer than two
reusable body candidates.

## Output Format

Emit a consolidated workflow report in Markdown, and include JSON when the
workflow writes structured artifacts. The report must include:

- Overall status: `passed`, `blocked`, `failed`, or `needs_rerun`.
- Request summary: source asset path, detected source format, output root,
  selected SimReady profile/version, and property assignment intent.
- Ordered stage results: stage reference, input artifact, output USD or USDZ
  path, report path, status, blocker reason, and rerun reason when applicable.
- Content Agents readiness and property assignment results with service URLs,
  tokens, and credentials redacted.
- Conformance and validation findings grouped by gate, requirement ID, selected
  FET repair reference, repair-loop attempt, and final disposition.
- Final artifacts: final reported USD path, render preview path when requested,
  package root and package validation report when packaging ran, Markdown report
  path, JSON report path when present, and recommended next work.

## Detailed References

Read only the references needed for the current request:

- `references/preflight/README.md`: deterministic local setup, manifest/env
  contract, Linux and Windows wrappers, Content Agents deployment opt-out, and
  guardrail behavior.
- `references/workflow.md`: inputs, source routing, detailed workflow,
  validation policy, output report fields, approval points, and next steps.
- `references/commands.md`: concrete portable script command patterns for each
  stage.
- `references/assemble-package-source/README.md`: two-zone package source
  assembly, canonical root USD naming, thumbnail placement, and self-contained
  deliverable checks.

## Publishing Layout Notes

Use `skills/omniverse-cad-to-simready/` as the source of truth for this product
repo's skill. The `.agents/skills` symlink is a compatibility alias for local
agentskills.io-style discovery, and `.codex/skills` and `.claude/skills` are
agent-specific compatibility aliases.

Frontmatter keeps `version` and `tools` at top level for agentskills.io runtime
compatibility. NVCARPS discoverability fields live under `metadata`.

The nested `references/` tree is intentional. It keeps one public catalog skill
while retaining script-bearing atomic stage references, upstream handoff notes,
and router documentation under the workflow. Do not flatten those references or
promote nested README references to sibling `SKILL.md` files unless the repo's
publishing model changes.

## Limitations

- This workflow coordinates existing conversion, property assignment,
  conformance, validation, rendering, and packaging skills; it does not replace
  them with a single monolithic runner command.
- Stop at the first failing deployment, conversion, property-assignment, or
  conformance authoring gate unless the user explicitly asks for best-effort
  continuation.
- Upstream `simready-foundation-conform-fet-005-simulate-grasp-physics` needs visual
  review or explicit grasp points before it can author a meaningful grasp
  vector.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Downstream reference reports that cad-to-simready preflight has not prepared a component | `PHYSICAL_AI_REQUIRE_PREFLIGHT=1` is set, but the manifest is missing or the required runtime/service is not `ready` | Run `preflight/scripts/preflight.py`, source the generated env file, or explicitly disable service deployment with `--skip-content-agents` only when Content Agents are out of scope. |
| Workflow stops on `GSP.001` and reports the failure as unclassified | Visual evidence or explicit grasp points were not provided to FET005 | Run upstream `simready-foundation-conform-fet-005-simulate-grasp-physics` only after a vision-capable agent has reviewed the asset, or pass explicit grasp points. Otherwise report the FET005 step as `blocked`, not failed. |
| Validation fails after a meaningful USD artifact already exists | Workflow stopped at the first validation finding | Continue remaining diagnostic gates and mark the result `needs_rerun`. Do not stop at validation findings once a USD artifact has been produced. |
| Property-assignment stage fails with a missing service endpoint | Content Agents service was not deployed before conversion | Run `deploy-content-agents` first. Do not start asset inspection, conversion, validation, conformance, rendering, or packaging before Content Agents readiness when property assignment will run. |
| Material Agent reports that rendering produced `0 images` after unit or profile repair | A FET repair, commonly FET001 unit normalization, was applied before Material Agent and changed the USD layering/scene state consumed by the service | Rerun assignment from the converted/minimum-valid USD: Material Agent first, then Physics Agent, then run `simready-conform-profile` and FET repairs on the latest service-authored USD. |
| Material or Physics Agent local optimized path reports `Permission denied: '/app/.build-resources/scene_optimizer_core/python'` | Local Docker Scene Optimizer bundle permissions prevent the non-root service user from reading the packaged SO runtime | Repair the relevant local container with `docker exec --user root content-material-agent-service chmod -R a+rX /app/.build-resources/scene_optimizer_core` or `docker exec --user root content-physics-agent-service chmod -R a+rX /app/.build-resources/scene_optimizer_core`, then rerun the same optimized agent command. Do not treat the no-optimizer fallback as the root cause for instanced/prototype assets. |
| `RB.MB.001` fails even though the asset has many prims | The profile counts `UsdPhysics.RigidBodyAPI` prims, not visual or collider prims; Physics Agent may author one root rigid body | Route to upstream `simready-foundation-conform-fet-004-simulate-multi-body-physics`. First ensure Physics Agent used composed-topology optimization when applicable, then promote existing component colliders/part roots when the active profile reports FET004/RB.MB.001 and no geometry must be invented. |

## Hard Rules

- Prefer the preflight manifest for local upstream roots, converter
  executables, SimReady validation runtime, OVRTX endpoint, and Content Agents
  service URLs. When `PHYSICAL_AI_REQUIRE_PREFLIGHT=1` is set, do not bypass the
  manifest with direct upstream discovery.
- Do not run asset inspection, converter probes, local upstream builds,
  conversion, validation, conformance, rendering, or packaging before Content
  Agents readiness when property assignment will run.
- Use stage-specific installed reference scripts directly. Do not add or call a
  single `omniverse-cad-to-simready` runner command.
- For source conversion, delegate to the `convert-to-usd` reference; do not
  substitute another converter for CAD or mesh formats.
- For property assignment, use Content Agents references as separate atomic steps:
  material first, then physics, then texture only when requested.
- When property assignment will run, do not run `simready-conform-profile` or
  any FET helper before Content Agents. Validate minimum USD first, then run
  Content Agents on that converted/minimum-valid USD, then apply FET repairs to
  the latest service-authored USD.
- When property assignment will run, do not run `simready-validate` or any
  SimReady profile validation before Content Agents. The only validation gate
  allowed before service calls is `validate-usd-minimum`, which is a basic USD
  viability check.
- Stop at the first failing deployment, conversion, property-assignment, or
  conformance authoring gate unless the user explicitly asks for best-effort
  continuation.
- Do not stop at validation findings after a meaningful USD artifact exists.
  Continue remaining diagnostic gates and mark the result `needs_rerun`.
- Do not leave a `GSP.001` profile failure as an unclassified final finding.
  Route it to upstream `simready-foundation-conform-fet-005-simulate-grasp-physics`; if
  the current agent cannot inspect renders or no explicit grasp points are
  available, report a blocked FET005 repair with the visual evidence path or
  missing input reason.
- Preserve every stage report and pass the concrete output USD path from each
  report into the next stage.
