# apply-restructure

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

## When to Use

Use this reference when you need to tool of restructure-decision and usd-edit-target-planner. Orchestrates USD reference rewriting for Phase 2f (monolithic -> prototypes) and Phase 5 (parent assemblies -> optimized children + stage-level cleanup). Two cognate modes under one skill since both reduce to 'write USD files + rewrite references'.

## Instructions

1. Confirm the target asset, artifact, or user intent and check the prerequisites listed below.
2. Read only the referenced files needed for the current phase, failure mode, or output contract.
3. Follow the workflow, rules, and safety gates in this reference before invoking downstream references or shell commands.
4. Return the result using the Output Format section and name any blocked prerequisite or unresolved user decision.

## Output Format

Return a concise status or report that names the input, selected runtime or evidence source, actions planned or performed, artifacts written, blockers, and the next validation or user-decision step. When a schema or template is referenced below, conform to that contract.

> **Invocation.** Tool of `restructure-decision` (Phase 2e gate, mode=`restructure`) and the `optimize-loop` (mode=`ref_remap`, after Phase 4 mesh ops produce optimized sub-assets). In Codex / generic shell agents, invoke by name. In Claude Code, also available as `/apply-restructure`.
>
> **Python invocation.** Examples below use `python3` (POSIX) and `py -3` (Windows PowerShell) for the cross-platform helper snippets. Body USD work uses the runtime chosen in Phase 0: when Kit is selected, run pxr/Sdf code under the Kit-bundled interpreter or `omni.kit.app`; when standalone is selected, the project-managed `usdpy` (or any compatible Pixar USD Python install).

## Purpose

Orchestrate USD reference rewriting in two cognate use cases that both reduce to "write USD files + rewrite references":

- **`mode=restructure`** (Phase 2f, after `restructure-decision` returns `extract-as-assets` or `decompose-for-selective-loading`): materialize the asset boundaries identified by `usd-structure-assessment` §2.7 and the dedupe candidates from `usd-hierarchy-dedupe-candidates`. Hierarchy dedupe is implemented as a USD rewrite from the candidate report: write shared prototypes, replace duplicate local subtrees with references, and then validate the new assembly root.
- **`mode=ref_remap`** (Phase 5, after Phase 4 mesh ops): given a map of `original_path -> optimized_path` for each sub-asset Phase 4 produced, compute the parent-assembly impact set, copy each parent to a new path, rewrite its references to point at the optimized children, then run stage-level cleanup ops.

Both modes share the same primitives (write USD, rewrite refs) so they live in one skill body.

## Prerequisites

- A USD asset path that opens cleanly under the active runtime (Phase 0 chosen).
- A writable `output_dir` distinct from the input stage's directory (no in-place overwrites by default).
- USD Python access (`pxr.Usd`, `pxr.Sdf`, and `pxr.UsdUtils`) from the active runtime. Scene Optimizer is optional for later stage-level cleanup ops, but is not required for hierarchy dedupe.
- For `mode=restructure`: a `restructure_plan` packet from `restructure-decision` (boundary cut points + optional dedupe candidates).
- For `mode=ref_remap`: an `optimized_targets` map (every `original_path` actually appears as a reference in the input stage; every `optimized_path` exists and opens cleanly).

## Pre-flight Checklist

Before executing restructure writes, re-read and confirm:

- [ ] `references/hierarchy-dedupe-rewrite-tool-spec.md` — exact rewrite
  semantics, reference patching, prototype extraction rules.
- [ ] User has explicitly approved the restructure plan from Phase 2e.
- [ ] Backup / non-destructive output path — restructure writes new layers,
  never overwrites the original stage in-place.
- [ ] `setup-preflight.json` runtime context — confirm USD Python environment
  is available for authoring.
- [ ] After restructure: run scoped re-validation to confirm no composition
  breaks.

## Limitations

- Cannot guarantee semantic identity for restructured stages - downstream visual or numerical comparison is the user's responsibility.
- Display-name-only grouping is not allowed for hierarchy dedupe. Candidate identity must come from `usd-hierarchy-dedupe-candidates` hashes and any accepted review findings.
- Deeply nested cyclic reference graphs are out of scope. The skill detects the cycle, flags it, and asks for a manual restructure plan rather than guessing.
- Stage-level cleanup (mode=`ref_remap` Step 4) is conservative: only lossless ops by default; bounded-loss residual ops require explicit user confirmation.

## Troubleshooting

- If the input plan from `restructure-decision` references prim paths that do not exist on the stage, return an error that names the missing paths and ask the user to refresh the SA report.
- If the hierarchy rewrite would collapse unrelated assemblies or drop local child overrides, stop and refresh the candidate report with stricter hash settings. See `references/hierarchy-dedupe-rewrite-tool-spec.md` and `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/instancing-readiness/references/instancing-tradeoffs.md` "Merge safety".
- If a parent-assembly copy fails reference rewriting (e.g. the original reference uses a relative path that resolves differently in the new location), capture the resolver context and surface to the user before continuing.
- If minimum USD validation fails on a written output, do NOT delete it; report the failure and let the user inspect the bad file.

## Inputs

| Input | Required for | Notes |
|---|---|---|
| `mode` | always | `restructure` (Phase 2f) or `ref_remap` (Phase 5) |
| `input_stage` | always | Path to the source USD stage |
| `output_dir` | always | Writable directory for new USDs |
| `restructure_plan` | mode=`restructure` | JSON packet from `restructure-decision`. Schema: `{"boundaries": [{"prim_path": "/Root/.../X", "asset_name": "X", "promote_to_reference": true}], "goal": "extract_as_assets | selective_loading", "material_policy": "inline_local_external | preserve_external | block_on_external", "dedupe": {"selected_groups": ["<candidate hash or id>"], "mode": "external_prototype"}, "user_confirmed_at": "<ISO 8601>"}`. |
| `optimized_targets` | mode=`ref_remap` | Map of `original_asset_path -> optimized_asset_path` from Phase 4 outputs. |
| `dry_run` | optional, default false | When true, compute the plan and write a manifest; do not write USD files. |
| `cleanup` | optional, mode=`ref_remap` only, default `["computeExtents", "pruneLeaves", "removePrims"]` | Stage-level cleanup ops to run as Step 4 (Phase 5c). Limited to lossless ops by default; pass an explicit list to override. |

## Outputs

| Output | Always | Notes |
|---|---|---|
| `new_assembly_root` | yes | Path to the new top-level USD that downstream phases use |
| `manifest` | yes | List of all files written, Phase 4 optimization targets, and provenance (which input prim or original ref each output corresponds to). Schema below. |
| `dry_run_report` | only when `dry_run=true` | Same shape as `manifest` but no files are written. |

Manifest schema:

```json
{
  "mode": "restructure | ref_remap",
  "input_stage": "<path>",
  "output_dir": "<path>",
  "new_assembly_root": "<path>",
  "outputs": [
    {
      "path": "<written file>",
      "kind": "prototype | shared_layer | loadable_subasset | parent_assembly | new_root",
      "provenance": "<source prim path or original asset path>",
      "size_bytes": 0,
      "validate_usd_minimum": "pass | fail | skipped",
      "notes": "<optional>"
    }
  ],
  "phase4_targets": [
    {
      "path": "<written file to optimize in Phase 4>",
      "target_class": "prototype | shared_layer | loadable_subasset | assembly_root",
      "mesh_count": 0,
      "dependency_group": "shared_first | dependent_after | independent",
      "source": "<boundary prim path, dedupe group id, or original asset path>",
      "weight_hints": {
        "size_bytes": 0,
        "mesh_count": null,
        "vertex_count": null,
        "material_count": null,
        "texture_count": null,
        "prototype_count": null,
        "instance_count": null
      },
      "notes": "<optional>"
    }
  ],
  "rewrite_steps": [
    { "step": "hierarchy_dedupe_rewrite", "result": "ok | skipped | failed", "summary_path": "<path>" }
  ],
  "material_rewrites": [
    { "source": "<source material path>", "prototype_target": "<inlined material path>", "result": "inlined | preserved_external | blocked" }
  ],
  "warnings": []
}
```

The strict contract for this file is `scripts/apply-restructure-manifest.schema.json`.
Every `phase4_targets[]` entry MUST carry a top-level `mesh_count` (integer >= 0):
the authoritative default-predicate count
(`len([p for p in Usd.PrimRange.Stage(stage, Usd.PrimDefaultPredicate) if p.IsA(UsdGeom.Mesh)])`)
measured with the target opened standalone, matching the Postcondition below.
`weight_hints.mesh_count` remains an optional, non-authoritative batching estimate.
The downstream Phase-4 completion gate (`optimization-report/scripts/validate_report.py
--manifest`) reconciles the final report's `target_coverage` against the UNION of
every iteration's `phase4_targets[]` and accepts a `skipped_zero_meshes` disposition
only when this `mesh_count` is `0`, so a retained-mesh target cannot be silently dropped.

## Preconditions

- `input_stage` opens cleanly (use `validate-usd-minimum` to confirm before starting).
- `output_dir` exists and is writable; reject if it equals the input stage's directory.
- For `mode=restructure`: `restructure-decision` returned `extract-as-assets` or `decompose-for-selective-loading`; `restructure_plan` is well-formed.
- For `mode=ref_remap`: every `optimized_targets` entry verified - both ends exist and open.

## Postconditions

- `new_assembly_root` opens cleanly and resolves all references (no unresolved asset paths).
- For `mode=restructure`: scenegraph instancing where the original had `instanceable=true` is preserved or improved.
- For `mode=ref_remap`: the new assembly root has the same composition shape as the input, but its reference targets are the optimized children.
- The manifest is emitted to `<output_dir>/apply-restructure-manifest.json` regardless of mode.
- For `mode=restructure`: every written prototype, shared layer, or loadable
  sub-asset that should receive Phase 4 mesh optimization appears in
  `phase4_targets[]`. Do not make downstream agents infer Phase 4 targets by
  scanning output folders or assuming every target lives under `prototypes/`.
- For `mode=restructure`: every payload, prototype, or loadable sub-asset in
  `phase4_targets[]` has Def-spec ancestors from root to mesh when opened
  standalone. Over-spec ancestors silently block SO default-predicate
  traversal (see `restructure-mode.md` §"Authoring Requirements"). Verify
  with a default-predicate mesh count > 0 before emitting the manifest entry.
- For `mode=restructure`: every extracted file has `defaultPrim` set to the
  root prim of the extracted sub-hierarchy. Validate with
  `Usd.Stage.Open(path).GetDefaultPrim().IsValid()`.
- For `mode=restructure`: the manifest documents what mesh content remains on
  the assembly root after extraction. If the assembly root has > 0 mesh prims,
  include it in `phase4_targets[]` with `target_class: "assembly_root"` so
  Phase 4 does not skip it. Downstream Phase 4 must process that entry through
  the per-target mesh op chain for its retained meshes; it is not limited to
  final stage-level cleanup operations.

---

## Workflow - mode=restructure (Phase 2f)

Use this when `restructure-decision` returns `extract-as-assets` for a monolithic stage
that should become references-to-prototypes. Follow
`references/restructure-mode.md` for internal-reference scanning, boundary
materialization, hierarchy-dedupe integration, authoring gotchas, output
validation, and the Datasmith/Revit example shape.

High-level steps:

1. Scan for internal references that escape candidate boundaries.
2. Validate input paths, boundary prim paths, and output directory.
3. Apply approved hierarchy-dedupe groups when present.
4. Materialize each accepted boundary, shared layer, loadable sub-asset, or
   dedupe group as USD output.
5. Validate every written output with the runner's minimum-openability check.
6. Emit `<output_dir>/apply-restructure-manifest.json` with `phase4_targets[]`
   for downstream adaptive batching.

---

## Workflow - mode=ref_remap (Phase 5)

Use this after Phase 4 mesh ops produce optimized sub-asset USDs at new paths.
Follow `references/ref-remap-mode.md` for impact-set construction, parent
assembly copying, reference rewriting, stage-level cleanup, instanceability
re-application, and output validation.

High-level steps:

1. Compute the parent-assembly impact set from `optimized_targets`.
2. Stop on cyclic reference graphs.
3. Copy impacted parent layers and rewrite references to optimized children.
4. Pick the new assembly root.
5. Run lossless stage-level cleanup through `so-run-operations`.
6. Validate written outputs and emit the manifest.

---

## Rules

- Never overwrite the input stage in place; always write to `output_dir`.
- Always write `.usdc` for data-heavy outputs; `.usda` is acceptable only for top-level assembly roots when human readability matters.
- After writing, validate every new USD with the `usd-validation-runner`
  minimum-openability check before declaring success. If it fails, do NOT
  delete the bad file - surface the failure.
- Generate a manifest entry for every output file, even when `dry_run=false`, so downstream phases (Phase 6 verify, optimization-report) can audit what was written.
- Do not include bounded-loss ops in the default `cleanup` chain (mode=`ref_remap` Step 4). Lossless only; user-overridable.
- If a step fails, do not auto-retry. Surface the failure (path + log + summary) and let the user decide.

## References

- `skills/omniverse-usd-performance-tuning/references/workflow.md` - canonical 7-phase flow context.
- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/instancing-readiness/references/instancing-tradeoffs.md` - merge safety policy (especially the "Do not recommend mesh merge when..." block).
- `references/hierarchy-dedupe-rewrite-tool-spec.md` - hierarchy dedupe rewrite behavior.
- `references/restructure-mode.md` - mode=`restructure` execution notes and internal-reference handling.
- `references/ref-remap-mode.md` - mode=`ref_remap` parent rewrite and stage cleanup notes.
- `skills/omniverse-usd-performance-tuning/references/so-run-operations/references/pipelines.md` - local handoff for Scene Optimizer operation chaining after hierarchy rewrite.
- `references/upstreams/usd-optimize.md` - upstream Scene Optimizer mechanics, invocation docs, and prebuilt package resolution.
- `usd-structure-assessment/README.md` §2.7 + "Tools for asset extraction" - boundary identification + USD API patterns this reference builds on.
- `usd-structure-assessment/references/usd-edit-target-planner/README.md` - per-asset optimization with reference remapping pattern (mode=`ref_remap` is a generalization of this).
