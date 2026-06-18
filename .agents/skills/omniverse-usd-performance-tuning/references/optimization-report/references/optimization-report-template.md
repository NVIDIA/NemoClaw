<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Optimization Report Template - Per-Phase Data Collection Checklist

> **Source:** Derived from `../scripts/optimization-report.schema.json` (canonical contract). This reference is the agent's "first read" - it tells you which fields you must populate by end-of-flow so each phase can collect against the final data contract.

---

## Why this exists

The `optimization-report` skill is the final-step producer that emits a JSON document conforming to `../scripts/optimization-report.schema.json` plus Markdown and static HTML summaries. To avoid the failure pattern "we got to the end and realized we never collected X", the agent should read this template **at the START of the flow** so every phase knows which baseline + after fields it owes the report.

This is a navigation aid, not a replacement for the `optimization-report` skill body or the schema itself.

## The contract (lifted from `../scripts/optimization-report.schema.json`)

Required top-level fields:

| Field | Type | Source phase | Notes |
|---|---|---|---|
| `asset_name` | string | Phase 0 | Set early; the basename of the input asset usually suffices. |
| `input_path` | string | Phase 0 | Optional in schema, but capture it for traceability. |
| `output_path` | string | Phase 5 | Path to the optimized stage root from Phase 5d (or `null` for diagnosis-only / structural-only path). |
| `timestamp` | string (ISO 8601) | Phase 6d | Set when the report writes. |
| `verdict` | enum: `improved \| neutral \| regressed \| mixed` | Phase 6c | From `compare-profiles`. Stays in this enum in every mode; use `neutral` when no metrics changed. Express degraded/no-op runs via `workflow_mode`, not new verdict values. |
| `workflow_mode` | enum: `full \| structural_only \| no_op` | Phase 6d | Optional (default `full`). `structural_only` when SO was unavailable and only USD-structural work ran; `no_op` when SA reported `already_optimized`. |
| `notes` | string | any phase | Optional. Caveats the verdict/score cannot capture: degraded-path reason, runtime/access blocker, or the next profile capture needed to graduate the verdict. |
| `optimization_score` | number 0-10 | Phase 6d | Stage Optimization Score. Compute deterministically as `round(sum(group.score * group.weight) / sum(group.weight), 1)` across scored stage/composition groups only. Exclude `score=null` and `weight=0` groups. Runtime metrics are not score inputs. |
| `score_scope` | enum: `stage_optimization` | Phase 6d | Makes the score scope explicit so readers do not confuse it with full runtime performance. |
| `score_label` | enum | Phase 6d | Human score band from `optimization_score`: `excellent >= 9.0`, `strong >= 7.5`, `moderate >= 5.5`, `neutral >= 4.5`, `mixed >= 2.5`, `regressed < 2.5`. |
| `reasoning` | string | Phase 6d | One to two paragraphs explaining why the agent chose this optimization approach for the asset, based on evidence and tradeoffs. |
| `measurement_context` | object | Phases 0, 1a, 6a | Context for stage/composition measurements: runtime, cache policy, sample count, stage-open method. |
| `runtime_profiling` | object | Phase 6d | Optional Omniperf/runtime-profiler handoff for RAM, VRAM, FPS, frame time, shader, renderer, and GPU metrics. |
| `metric_groups[]` | array | Phase 6d | Stage headline areas such as composition load, structure, instancing, storage footprint, and validation. |
| `artifacts` | object | Phase 6d | Paths to generated JSON, Markdown, and static HTML reports. |
| `metrics[]` | array | Phases 1a + 6a | Each metric: `name`, `before`, `after`, `change_pct`, `verdict`. |
| `operations[]` | array | Phases 4 + 5 | Each op: `order`, `name`, `method`, `result`. |
| `validators[]` | array | Phases 2c + 6b | Each validator entry: `name`, `issues`, `notes`; `issues` is the count of reported findings for that row. |

## Per-phase collection checklist

The agent should populate against this checklist as it moves through the flow.

### Phase 0 - Bring-up

Populate immediately after the runtime is chosen:

- [ ] `asset_name` (basename of input)
- [ ] `input_path`
- [ ] Record runtime choice (Kit or standalone) and install path in `notes` for traceability (not a schema field).
- [ ] Start `measurement_context` with runtime choice, cache state, sample count, stage-open method, and warmup policy when known.

### Phase 1 - Open and characterize

- [ ] `metrics[]` - **baseline** entries with `before` populated, `after` left null until Phase 6.
  - Suggested baseline metrics:
    - `stage_open_seconds` (Phase 1a profile)
    - `prim_count`, `mesh_count`, `material_count` (from SA Phase 1.1-1.4 - 1b)
    - `layer_count`, `total_size_bytes` (SA Phase 1.3 - 1b)
    - `instance_count`, `instance_ratio` (SA Phase 1.4 - 1b)
    - `reference_count`, `payload_count`, `time_sample_count`, `extent_coverage`, `instanceable_reference_count`, `prototype_count` when available.

Do not treat RAM, VRAM, FPS, or frame time as stage-score inputs. Those belong
in `runtime_profiling`, ideally via Omniperf dashboard/artifacts.

### Phase 2 - Composition / discovery / restructure decision

- [ ] `validators[]` - first entries (validator name + issue count from Phase 2c selected probes). One row per validator that ran.
- [ ] If user takes the "exit" branch at Phase 2e gate: skip to Phase 6d and write a diagnosis-only report (`output_path: null`, empty `operations[]`).

### Phase 3 - Stage-level instancing

- [ ] `operations[]` - record any instancing flips authored:
  - `order`: position in op chain
  - `name`: e.g. `set_instanceable_true`
  - `method`: e.g. `instancing-readiness gate + edit-target-planner`
  - `result`: e.g. `12 prims marked instanceable`

### Phase 4 - Per-sub-asset mesh ops

- [ ] `operations[]` - one entry per op per target. The `result` field is concise per-target outcome (e.g. `meshCleanup on prototype/A: 124 prims processed, 12% triangle reduction`).
- [ ] Record the Phase 4 batch manifest path in `notes` or the Markdown summary. The manifest should include target weights, chosen concurrency per batch, resource observations, output/log paths, failures, and any adjustment or remainder-script decision.
- [ ] If adaptive batch mode generated a remainder script, record it under `notes` with the script path and remaining target count.

### Phase 5 - Reference replacement and stage cleanup

- [ ] `output_path` - the optimized stage root produced by Phase 5d.
- [ ] `operations[]` - record stage-level cleanup ops (computeExtents, residual deduplicateGeometry, pruneLeaves, removePrims).

### Phase 6 - Verify and report

- [ ] `metrics[]` - fill `after`, `change_pct`, and per-metric `verdict` from Phase 6a profile-after.
- [ ] `validators[]` - second pass entries from Phase 6b re-validation. Compare against Phase 2c entries to surface dropped/persistent issues in the Markdown summary.
- [ ] `verdict` - top-level verdict from `compare-profiles` (Phase 6c).
- [ ] `timestamp` - written by `optimization-report`.
- [ ] `optimization_score`, `score_scope`, `score_label`, and `metric_groups[]` - computed from stage/composition metrics only.
- [ ] `reasoning` - one to two concise paragraphs explaining the chosen optimization strategy and tradeoffs.
- [ ] `runtime_profiling` - point to Omniperf/runtime-profiler artifacts if available, or mark as `not_run` with a recommendation.
- [ ] `artifacts` - include the JSON, Markdown, and HTML report paths.
- [ ] Generate HTML by running `python3 references/report-templates/render_preview.py --fixture <report.json> --output <report.html>` (mandatory — do NOT hand-write HTML, and never run it argless: that renders the committed design fixture, not your report). See `references/optimization-report/README.md § HTML Generation`.

Do not emit the final report as a normal completed optimization if Phase 6a or
Phase 6b artifacts are missing. Either run the missing phase, or record the
explicit waiver/blocker in `notes`, leave the affected comparison fields
unclaimed, and keep the verdict no stronger than the remaining evidence allows.

## Special cases

### Structural-only path (SO unavailable)

When SO is unavailable and the user declines setup:

- `output_path` may be `null` (no Phase 4 ops were applied, no Phase 5 ref-rewrite happened).
- `verdict` stays in its enum; if no metrics changed, use `neutral`. Set `workflow_mode: structural_only` and record the SO-unavailable reason in the top-level `notes` field.
- `operations[]` may be empty.
- `validators[]` should still contain the Phase 2c USD-stack findings.
- `runtime_profiling.status` should usually be `not_run` unless an external Omniperf/runtime-profiler artifact is attached.

### Quick-mode-only caveat (standalone runtime, no Kit)

When Phase 1a profile-stage and Phase 6a profile-after ran in quick mode
only (the standalone Scene Optimizer path has no Kit and no Tracy),
**explicitly call out** in the report what was measured vs unmeasured:

- The `metrics[]` array carries USD-level signal only: stage open
  (cold + warm), prim / layer / instance / prototype counts, attribute
  resolution, transform compute, total stage vertices (via SO
  `printStats`), `rtxMeshCount`, and any disk-size deltas. These are real
  and comparable.
- The renderer-side metrics that distinguish "the optimized stage is
  faster" from "the optimized stage looks structurally cleaner" — FPS,
  frame time, VRAM, Hydra sync, RTX render time, draw-call count, shader
  compile time — are **unmeasured** on this path. `rtxMeshCount`
  improvements are predictive, not proof.

Suggested top-level `notes` text for the report:

> Profiled on the standalone runtime (no Kit available). All metrics are
> USD-level (composition, traversal, disk size, SO Tier-1 analysis). FPS,
> frame time, VRAM, and real draw-call counts are unmeasured; render-time
> wins implied by `rtxMeshCount` and instance/prototype counts are
> plausible but not verified. To convert plausibility into a measurement,
> re-run Phase 1a + 6a in full mode under Kit / USD Composer / Isaac Sim.

Set `verdict` from the metrics that were actually measured. A run that
improves every quick-mode metric without regressions is `improved`, with
the caveat above attached.

### Iteration (Phase 7)

When the agent loops back from Phase 7:

- Default broad optimization to 3 scoped iterations unless the user opts out,
  requests a quick pass, or stop criteria apply.
- Write an interim report/update after each iteration before continuing.
- KEEP the `before` values from the FIRST baseline. Do NOT re-baseline.
- Append to `operations[]` with continued `order` numbering across iterations.
- Update `after` values from each new Phase 6a re-profile.
- Reuse prior validator evidence unless the next pass needs a narrower targeted
  or delta probe; expanded validation scope requires explicit approval.
- The final `verdict` reflects the cumulative comparison (first baseline vs latest after).

### Diagnosis-only

If the user's intent was diagnosis-only (no mutation):

- `output_path` is `null`.
- `operations[]` is empty.
- `validators[]` and baseline `metrics[]` are still populated.
- `verdict` should be `neutral` and the Markdown summary should clearly state "diagnosis-only - no optimized stage written."

## Schema reference

Full JSON Schema lives at `../scripts/optimization-report.schema.json`. The `optimization-report` skill is the producer; this template is the agent's pre-read so every phase collects the right data.
