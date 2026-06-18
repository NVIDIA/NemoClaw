---
name: omniverse-usd-performance-tuning
description: "Top-level workflow skill for USD performance diagnosis and optimization. Use for slow loading, high memory, low FPS, or 'optimize my scene' requests; delegates auth/runtime setup to Phase 0 owners."
version: "0.1.0"
license: Apache-2.0
tools:
  - Read
  - Shell
  - Write
compatibility: >
  Orchestrator skill. Downstream phases may require Kit, Scene Optimizer, Asset Validator, USD Python, writable output paths, and omniverse:// authentication selected by setup-usd-performance-tuning.
metadata:
  author: NVIDIA Omniverse
  tags:
    - triage
    - performance
    - usd
    - profiling
  domain: ai-ml
  languages:
    - python
---
# Omniverse USD Performance Tuning

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

## When to Use

Use this workflow for broad performance asks such as slow loading, high memory, low FPS, GPU crashes, conversion-quality triage, or generic requests to optimize a USD scene.

## Instructions

1. Start from the mandatory runtime context gate before producing tuning output, unless the prompt is only asking for a static classification test.
2. Classify broad optimization requests as `ready_to_plan`; reserve `approval_required` for prompts that explicitly name a destructive operation to execute before planning.
3. Plan the full canonical chain through `optimization-report`, preserving the structured milestone order and the `profile-stage:baseline` / `profile-stage:after` labels when listing milestones. For broad optimization, default to 3 scoped iterations unless the user opts out, asks for a quick pass, or stop criteria apply.
4. Invoke downstream skill bodies only when their phase is reached, and keep raw runtime artifacts on disk while reading compact summaries.

Frontmatter keeps `version` and `tools` at top level for agentskills.io runtime
compatibility. NVCARPS discoverability fields live under `metadata`.

## Output Format

Return a plan or status summary that names the selected entry skill, uses `ready_to_plan` for generic optimization requests, includes the full milestone chain through `optimization-report`, and labels profile phases as `profile-stage:baseline` and `profile-stage:after`. For structured outputs, the broad-optimization milestone subsequence is `omniverse-usd-performance-tuning` -> `profile-stage:baseline` -> `usd-structure-assessment` -> `usd-validation-runner` -> `restructure-decision` -> `apply-restructure` -> `so-run-validators` -> `so-interpret-validators` -> `so-run-operations` -> `profile-stage:after` -> `compare-profiles` -> `optimization-report`. End-to-end execution should produce an optimized stage when mutation runs and a report conforming to the `optimization-report` reference's schema (`scripts/optimization-report.schema.json` within that reference). Broad optimization should plan 3 scoped iterations by default; each iteration writes an interim report/update and later passes reuse prior evidence instead of restarting the full workflow.

Use this workflow for broad performance asks such as slow loading, low FPS,
high memory, GPU crashes, conversion quality, or "optimize my scene."

## Entry skill rule

This skill is the named entry point for broad performance work whenever the
agent has any verified way to do that work. Runtime probing details live in
`setup-usd-performance-tuning`; this rule only decides which skill owns the
user-facing performance request.

- If the setup probe shows **any** verified runtime path - Kit, standalone, or
  even a partial stack such as Asset Validator only - enter here. If the
  user's requested tool is missing, return the specific `blocked_code`
  (`blocked_missing_scene_optimizer`, `blocked_missing_so_operation`, etc.)
  instead of substituting another workflow.
- Enter at `setup-usd-performance-tuning` only when **no** runtime path is
  verified and runtime choice/setup is the first unresolved problem.
- For `omniverse://` assets, enter at `omniverse-authentication` first.
  Authentication precedes setup and triage for remote assets.

The decision is about ownership, not order. Setup, authentication, and triage all run in their normal phase order; this rule only fixes which skill the agent **names as the entry skill** in its response.

## Runtime context — session-start gate (mandatory)

**Before any other tuning output**, follow the mandatory session-start gate in
`skills/omniverse-usd-performance-tuning/references/setup-usd-performance-tuning/references/runtime-context-header.md`.
That reference owns `output_path`, the canonical `setup-preflight.json`
location, Format A/Format B, and the "do not improvise a silent probe"
anti-pattern.

Required outcomes:

- Missing or unreadable preflight: invoke `setup-usd-performance-tuning`.
- Present preflight: print Format A and wait for the user to choose Continue,
  Change Kit, Switch to standalone, or Re-run probe.
- Confirmed runtime in the same session: use compact Format B for follow-up
  status.

```
[Kit: {runtime_context.kit.application} {runtime_context.kit.version}  |  SO: {runtime_context.sceneOptimizer.version}  |  AV: {runtime_context.assetValidator.version}]
```

## Runtime artifact token budget

Before reading Kit logs, Asset Validator CSVs, Scene Optimizer logs, Tracy CSVs,
or other runtime output, follow
`references/runtime-artifact-token-budget.md`. Keep raw artifacts on disk, read
summary JSON first, and use bounded log snapshots instead of full dumps or live
streams.

## Plan-time vs execution-time approval

`approval_required` at planning time is reserved for requests that explicitly name a destructive operation. Use the following rule when deciding between `ready_to_plan` and `approval_required`:

- **`approval_required` at planning time** — the user's request itself names a destructive operation: "flatten this stage", "decimate the meshes", "merge prototypes", "delete unused prims", or any specific named mutation that cannot be undone within the same workflow. In this case the agent's first response must be an approval prompt that names the operation, before the agent commits to a plan that executes it.
- **`ready_to_plan` at planning time** — the user's request is general: "optimize this scene", "make it load faster", "reduce GPU memory", "improve interactivity". The agent lays out the full plan, including any destructive operations the plan would invoke (for example `so-run-operations` with `mergeMaterials`), without withholding the plan itself. **Approval for each destructive operation is requested alongside plan approval**.

The distinction is between **authorising a plan** and **authorising a destructive action**. A general optimisation request authorises planning; it does not authorise execution of specific destructive operations.

For structured runtime-test responses and similar planning summaries:

- A future `restructure-decision` prompt is a planned user-decision gate, not a reason to set the top-level response `decision` to `approval_required` for a generic optimization request.
- For a generic optimization request, set `decision: "ready_to_plan"` and include the full intended chain in both `committed_milestones` and `planned_phases`, through `optimization-report`.
- It is valid for `gates_observed` to include `asks_user_for_restructure_decision` while the top-level `decision` remains `ready_to_plan`.
- Whenever a chain names profile phases, use the exact labels `profile-stage:baseline` and `profile-stage:after`; do not emit the ambiguous bare `profile-stage` token.
- Start structured milestone lists with `omniverse-usd-performance-tuning` as the owning entry skill. Include `setup-usd-performance-tuning` only as additional Phase 0 context, not as a replacement for the entry skill milestone.
- For broad optimization requests, preserve the milestone subsequence from *Output Format* above exactly, with optional extra analysis steps inserted only where they do not reorder it.
- Do not list `so-run-validators` or `so-interpret-validators` before `restructure-decision` in broad optimization milestone summaries. Phase-aware validator routing still happens through `usd-validation-runner`; the SO validator executor/interpreter milestones appear after the restructure decision path in the structured plan contract.

## Output expectation

End-to-end optimization work should produce both an optimized USD stage, when
mutation is executed, and a structured optimization report conforming to
the `optimization-report` reference's `scripts/optimization-report.schema.json`. The HTML report must be rendered
from `references/report-templates/optimization-report.html.template` via
`render_preview.py` — never hand-write HTML. Diagnosis-only work should still
end with a report or summary that states no optimized stage was written.

## Purpose

Route digital twin USD performance requests into the right diagnostic and
optimization workflow while preserving evidence before mutation.

## Prerequisites

- Stage path or enough context to identify the target asset.
- User goal: diagnosis only, validation, profiling, or processor execution.
- Runtime availability status from `setup-usd-performance-tuning` when not already known.
- Permission status for in-place mutation vs writing a separate optimized output.

## Examples

- "This USD loads slowly; triage what to check first."
- "Route a low-FPS CAD scene through the performance workflow."

## Triage order

0. **Runtime gate.** Follow the mandatory session-start gate above before
   validation, profiling, or optimization. Do not scan, probe, install, or pick
   Kit/standalone runtimes directly in this skill; `setup-usd-performance-tuning`
   owns probe/chooser/install dispatch and writes the preflight consumed here.

1. Identify the target problem:
   - Load time.
   - FPS or interactivity.
   - GPU or system memory.
   - Crash or device lost.
   - CAD conversion quality.
   - Validation failure.

2. Gather minimum context:
   - Stage path and size.
   - Whether the stage is local, mounted, or `omniverse://` remote. For remote
     assets, route through `omniverse-authentication` before first open.
   - Kit or USD runtime.
   - Whether the workload is CAD, VFI, AIF, Isaac, or generic OpenUSD.
   - Whether in-place mutation is allowed.
   - Whether the user wants diagnosis only or processor execution.

3. Route:
   - USD composition questions: `usd-structure-assessment` (composition is now part of the SA umbrella; deeper detail in `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/composition-audit.md`).
   - Validation and content issues: `usd-validation-runner` (master router; routes to `validate-*` family or `so-run-validators` based on intent).
   - Edit/output decisions: `usd-edit-target-planner` (also owns variant/payload gates).
   - Repeated copied hierarchy or high mesh count with no instancing:
     `usd-hierarchy-dedupe-candidates`.
   - Restructure decision (monolithic stage, asset boundary materialization): `restructure-decision`.
   - CAD converter settings: read `references/cad-conversion/README.md` (niche pre-USD concern; see reference for details).
   - Scene Optimizer: `so-run-validators`, `so-interpret-validators`, `so-run-operations`.

## Optimization ordering

Follow the canonical ordering in
[workflow.md § Operation ordering invariants](references/workflow.md#operation-ordering-invariants).
The high-level rule: **prototypes first → per-asset validation → stage-level
operations last.** The workflow reference owns the full invariant list
(meshCleanup before decimateMeshes, deduplication before decimation, never
merge if instanced, etc.) and the analysis-only ops catalogue.

## Rules

- Always run composition audit before mutation.
- Always validate before and after processor execution.
- Optimize prototypes before per-asset validation.
- Do not run whole-stage mesh deduplication on very large CAD scenes before
  checking for hierarchy-level reuse.
- Do not recommend a fixed optimization stack without bottleneck evidence.
- Do not invent numeric thresholds or expected percentage wins.
- **Prefer canonical SO ops over specialty / documentary ones.** The op
  curation in `references/operations/_curation.json` classifies every op
  as `canonical`, `specialty`, `analysis`, `documentary`, or `deprecated`.
  When more than one op could resolve the same finding, recommend the
  canonical one first and only reach for a specialty op when the user
  explicitly asks or the rationale warrants it. Specifically:
  - For vertex welding, prefer canonical `meshCleanup` with explicit flags
    over the standalone `mergeVertices` op. The standalone op is a
    legacy/specialty surface; use upstream `usd-optimize` for the operation
    mechanics and local approval policy before mutating.
  - For hierarchy dedupe, recommend `usd-hierarchy-dedupe-candidates` +
    `apply-restructure` (the USD-authored rewrite path).
  - For per-mesh dedupe, recommend `deduplicateGeometry` (canonical) over
    `findCoincidingGeometry` (analysis — produces a report, not a change).
  - Do not recommend `documentary`-status ops (e.g., `boxClip`,
    `deletePrims`, `removeAttributes`, `removeUntypedPrims`,
    `merge` outside its narrow non-instanced case) without an explicit
    user request. Documentary ops survive in the per-op
    `references/operations/<key>.md` routing stubs for completeness but are
    excluded from agent-initiated recommendations.
  - **Specialty ≠ documentary.** Ops classified as `specialty` in
    `_curation.json` either (a) have validator-finding evidence that
    wires them into the `so-interpret-validators` chain (e.g.
    `sparseMeshes`, `optimizePrimvars`), or (b) are load-bearing escape
    hatches needed for specific downstream contexts (e.g.
    `primitivesToMeshes` when output must be `UsdGeomMesh`,
    `utilityFunction` for instancing toggles and material rebinding,
    `pythonScript` for `so-create-proxy` recipes). Recommend specialty
    ops when their validator fires OR when their downstream context
    applies — the suppression above only targets `documentary` ops.

## Limitations

- Does not replace downstream reference instructions; load each required
  reference before executing it.
- Does not install runtimes directly; follow setup or install references when
  requirements are missing.
- Does not authorize mutation when the user has not allowed writes.

## Troubleshooting

- If runtime status is unclear, run `setup-usd-performance-tuning` before profiling or validation.
- If the reported problem is vague, gather stage path, workload type, and whether diagnosis or execution is requested.
- If the workflow suggests mutation before evidence, return to baseline profiling and composition audit first.

## References

Before routing, read:

- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/optimization-tradeoffs.md` — identify which pipeline phase the scene is in (extraction, structuring, or optimization). The right action depends on the phase.
- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/factory-level-structuring.md` — understand the three pillars (assets, aggregation, animation) and the seven-step structuring pattern.

If you have network access, prefer the live URLs (noted in each reference file) for the most current version.

## Required execution flow

Read `references/workflow.md` for the canonical Phase 0-7 flow, including
Kit/standalone branches, validator-stack routing, operation ordering,
termination conditions, duration hints, and the default three-pass scoped
iteration pattern.
The compact root map at `references/skill-map.md` only routes agents
into this workflow.

Do not treat downstream phase names as plain checklist labels. Before executing
each step, load that phase's nested `README.md` reference and follow its
instructions. Claude Code only exposes the public catalog skill; it does not
recursively inject `profile-stage`, `usd-structure-assessment`, or other nested
references.

The final deliverable must come from `optimization-report`: save both the structured JSON report and the generated Markdown summary. Do not substitute an ad hoc `SUMMARY.md` or chat-only recap for the optimization report.

For deeper subtopic guidance, consult the references:

- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/composition-audit.md`, `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/layer-health.md` - subtopic detail for SA's Phase 1 checklist.
- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/instancing-readiness/references/instancing-tradeoffs.md` - merge safety, decision tree for instancing choices.
- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/usd-edit-target-planner/references/variants-payloads.md` - deeper variant/payload trade-offs (gates are inline in usd-edit-target-planner).
- `references/cad-conversion/README.md` - CAD converter settings.
- `references/upstreams/usd-optimize.md` - upstream SO mechanics and prebuilt package resolution.
- `skills/omniverse-usd-performance-tuning/references/usd-validation-runner/references/so-run-validators/references/infrastructure.md` - local handoff for SO validator infrastructure.
- `skills/omniverse-usd-performance-tuning/references/usd-validation-runner/README.md` - tier 1/2/3 selected-probe plan, large-stage guardrails, full-sweep approval, and scene-aware adjustment.
- `skills/omniverse-usd-performance-tuning/references/optimization-report/references/optimization-report-template.md` - the data contract every phase populates.

For full Kit runtime profiling (FPS, frame time, Hydra/RTX metrics), refer to the external profiling skills at NVIDIA/omniperf.
