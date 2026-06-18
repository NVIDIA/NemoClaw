# Restructure Decision

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

## When to Use

Use to decide whether a monolithic USD stage should be restructured (asset-boundary materialization + hierarchy dedupe) before optimization, or optimized as-is. Asks the user; invokes apply-restructure when the user confirms.

## Instructions

1. Confirm the target asset, artifact, or user intent and check the prerequisites listed below.
2. Read only the referenced files needed for the current phase, failure mode, or output contract.
3. Follow the workflow, rules, and safety gates in this reference before invoking downstream references or shell commands.
4. Return the result using the Output Format section and name any blocked prerequisite or unresolved user decision.


## Pre-flight Checklist

Before presenting the restructure gate, re-read and confirm:

- [ ] SA report contract — `phase_recommendation`, `hierarchy_dedupe`,
   `asset_boundary_suggestions` fields.
- [ ] `setup-preflight.json` runtime header — know what runtime is available.
- [ ] Present all three options (restructure / optimize-as-is / exit) — do not
   pre-select on the user's behalf.
## Output Format

Return a concise status or report that names the input, selected runtime or evidence source, actions planned or performed, artifacts written, blockers, and the next validation or user-decision step. When a schema or template is referenced below, conform to that contract.

## Purpose

Phase 2e of the canonical optimization flow (see
`skills/omniverse-usd-performance-tuning/references/workflow.md`).
After `usd-structure-assessment` has classified the asset and
`usd-hierarchy-dedupe-candidates` has produced asset-boundary signal, this
skill is the user-confirm gate that decides whether to restructure the stage
before optimization.

This is a small decision-tier skill. It does not perform the rewrite - that's
the execution-tier `apply-restructure`, which uses `pxr`/`Sdf` USD authoring to
materialize boundaries and apply the hierarchy-dedupe rewrite described in
`skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/apply-restructure/references/hierarchy-dedupe-rewrite-tool-spec.md`.

## Prerequisites

- A completed `usd-structure-assessment` report including:
  - `phase_recommendation` (`structuring | optimization | already_optimized`).
  - `hierarchy_dedupe.recommended` and `hierarchy_dedupe.top_candidates` (when present).
  - The §2.7 asset-boundary identification output (when the stage is monolithic).
- Optional: `usd-hierarchy-dedupe-candidates` read-only candidate report when the stage is monolithic.
- Optional: Phase 2c `usd-validation-runner` findings corpus (informs the decision when validators flagged structural-only issues that restructure would help with).

## Examples

- "Should I restructure this CAD stage before running mesh ops?"
- "The factory.usd is monolithic with 12 repeated assemblies - what's next?"

## Inputs

The agent assembles a decision packet from prior phases:

| Input | From | Used to decide |
|---|---|---|
| SA classification | `usd-structure-assessment` Phase 2a | Monolithic vs composed; restructure recommended? |
| Asset-boundary candidates | `usd-structure-assessment` §2.7 + `usd-hierarchy-dedupe-candidates` | Where the cut points are if restructure is chosen |
| Validator findings | Phase 2c `usd-validation-runner` selected probes | Whether structural-only fixes would be wasted on a stage about to be restructured |
| Instancing assessment | Phase 2d (read from SA `instancing` field) | Estimated leverage from restructure |
| User constraints | session context | Time budget, mutation policy, output policy |

## Decision branches

Compute the recommended branch from the inputs, then **always present the choice to the user** - do not auto-proceed.

| SA classification | hierarchy_dedupe.recommended | Recommended | Branches offered |
|---|---|---|---|
| `monolithic-needs-restructure` | true | ask (see below) | deduplicate-internally / extract-as-assets / optimize-as-is / exit |
| `monolithic-needs-restructure` | false | decompose-for-selective-loading | decompose-for-selective-loading / optimize-as-is / exit |
| `monolithic-fine-as-is` | — | optimize-as-is | optimize-as-is / exit |
| `monolithic-fine-as-is` + `payload_count=0` + clear boundaries | — | ask | decompose-for-selective-loading / optimize-as-is / exit |
| `composed` (already structured) | — | continue (no Phase 2f) | continue (Phase 3) / exit |
| `phase_recommendation = already_optimized` | — | jump to Phase 6 | jump-to-verify / continue / exit |

#### When hierarchy_dedupe.recommended=true

Present exactly two restructure strategies (plus optimize-as-is and exit):

1. **Deduplicate hierarchies internally** — Scene Optimizer's
   `deduplicateHierarchies` creates internal references to shared prototypes
   within the same stage file. The referencing prims are marked
   `instanceable=true`. The stage remains monolithic (single file, no payloads).
   Fastest path; appropriate when selective loading is not needed.

2. **Extract duplicate hierarchies as payloaded, instanced assets** — The
   hierarchy-dedupe rewrite tool runs with `mode: external_prototype`, extracting
   each shared prototype as an external asset file. Each instance site references
   the prototype via a payload arc, making it independently loadable. This is
   the full restructure: the monolith becomes an assembly root + prototype
   assets. Appropriate when selective loading matters (large scenes,
   collaborative workflows, streaming).

Both strategies produce instanced prototypes. The difference is whether
prototypes live inside the stage (internal references, SO handles it) or as
separate files (external payloaded assets, `apply-restructure` handles it).

The boundary plan records:
- `goal: deduplicate_internally` → SO's `deduplicateHierarchies` in Phase 4
- `goal: extract_as_assets` → hands off to `apply-restructure` with `dedupe.mode: external_prototype`

Do NOT offer a "selective loading without instancing" option — extracting N
identical subtrees as N independent files without sharing a prototype is always
wrong when the hash confirms structural identity.

#### Selective loading (no dedupe candidates)

When `hierarchy_dedupe.recommended=false` but `usd-structure-assessment` reports
`payload_count: 0` and clear spatial, discipline, linked-model, category, or
building-wing boundaries, present a selective-loading choice:

- `decompose-for-selective-loading`: materialize the chosen boundary level as
  loadable sub-assets (payloads). Each boundary becomes its own file.
- `optimize-as-is`: keep the monolithic delivery package and proceed to
  validation / SO optimization.
- `exit`: write the diagnosis/report and stop.

If the user picks `decompose-for-selective-loading`, ask which candidate level
from `asset_boundary_suggestions.candidate_levels` should be used unless the
user already specified it. This path still hands off to `apply-restructure`;
the boundary plan should record `goal: selective_loading` so downstream mesh
ops know the split is for packaging and workflow, not for instancing.

#### Extract-as-assets authoring details

When the user picks `extract-as-assets`, the authoring recipe in
`restructure-mode.md` §"Instanced Asset Extraction" applies:

- Identical subtrees share one prototype file.
- Each instance site gets a lightweight placement prim (`instanceable=true`)
  inside its payload layer.
- Instancing is decided per dedupe group, not globally. Some extracted
  assets may be instanceable (their group passes the `instancing-readiness`
  gate) while others are extracted as unique payloads.
- The boundary plan records the per-group decision.

The `apply-restructure` skill handles the file extraction and assembly-root
rewrite. This skill (`restructure-decision`) only captures the user's choice.

#### User overrides the recommendation

When SA recommends `optimize-as-is` (or `already_optimized`) but the user
picks restructure anyway, confirm the user's goal before authoring. Restructure
does **not** improve geometry-level metrics — those land in Phase 4. What
restructure actually buys:

- **Selective loading via payloads** — split a 1 GB monolithic stage into
  per-floor / per-discipline payloads the user can load on demand.
- **Modular collaboration** — separate sub-assets so multiple authors can
  edit in parallel without conflict.
- **Per-asset Phase 4 targets** — Phase 4 mesh ops can run on shared
  prototypes once, with results propagating to all instance sites.

Ask the user which of those they want and capture it in the decision packet
so Phase 4 knows whether to target prototypes or the monolith. Do not assume
restructure-for-its-own-sake.

### deduplicate-internally

User accepts the dedupe candidates but wants the stage to stay monolithic.
Skip Phase 2f (`apply-restructure`). Record the choice and selected groups in
the optimization plan. Phase 4 includes `deduplicateHierarchies` in the SO op
chain (gated by `operationsAvailable`).

Continue to Phase 3 with the original monolithic stage.

### extract-as-assets

User accepts the boundary candidates and wants external payloaded assets.
Invoke `apply-restructure` with:

- `restructure_plan`: the boundary cut points + dedupe candidates + `dedupe.mode: external_prototype`.
- `output_dir`: where to write prototype USDs and the new assembly root.
- `dry_run`: false (writes are executed).

`apply-restructure` returns a manifest of new prototype paths + the new
assembly stage root path. Continue to Phase 3 with the restructured stage.

### decompose-for-selective-loading

User wants selective loading boundaries without hierarchy dedup (no dedupe
candidates exist in this branch). Invoke `apply-restructure` with:

- `restructure_plan`: the selected boundary level + `goal: selective_loading`.
- `output_dir`: where to write payload USDs and the assembly root.
- `dry_run`: false (writes are executed).

Continue to Phase 3 with the decomposed stage.

### optimize-as-is

User accepts the existing structure. Skip Phase 2f. Continue to Phase 3 (instancing) and Phase 4 (mesh ops) targeting the original stage.

### exit

User declines mutation. Skip to Phase 6d and write a diagnosis-only optimization report capturing the SA + validator findings.

### jump-to-verify

Used when SA's `phase_recommendation = already_optimized`. The agent runs Phase 6a/6b on the original stage to confirm and writes the report.

## How to ask

The Phase 2e prompt commits the user to a structural decision that downstream
phases cannot easily undo. The user must see exactly which Kit / Scene
Optimizer / Asset Validator versions authored the assessment and will execute
the restructure. **Prepend the full runtime context block** from
`skills/omniverse-usd-performance-tuning/references/setup-usd-performance-tuning/references/runtime-context-header.md` (Format A) before any of the analysis
or choice text below. Source: the `runtime_context` object in
`<output_path>/setup-preflight.json` (canonical location; see
`skills/omniverse-usd-performance-tuning/references/setup-usd-performance-tuning/references/runtime-context-header.md` *Where artifacts live*). If that
file is missing, invoke `setup-usd-performance-tuning` first.

Present the recommended branch with the evidence behind it, then list the alternatives. Example:

```
─── Runtime context ───────────────────────────────────────────────────────
Kit application:    USD Composer 110.1.0
  path:             D:\build\chk\usd_composer-fat\110.1.0+main.…\kit
  build:            110.1.0+main.10181.f4b28ef2.gl.windows-x86_64.release
Scene Optimizer:    omni.scene.optimizer.core 110.0.4
Asset Validator:    omniverse-asset-validator 1.x.y via kit-extension
───────────────────────────────────────────────────────────────────────────

The asset analysis shows:
  - 1 monolithic root layer, 0 references, 0 prototypes.
  - 4 repeated assembly patterns detected (suggesting 4 candidate prototypes
    saving an estimated 47% of prims).
  - 8 of the 12 Tier 2 validator failures will be invalidated by restructuring
    (geometry that's about to be replaced).

Recommended: extract as payloaded, instanced assets. This will:
  - Materialize 4 prototype USDs to <output_dir>/prototypes/
  - Rewrite the root assembly to reference them
  - Run subsequent mesh ops on the prototypes (changes propagate)

Alternatives:
  - optimize-as-is: skip restructure, run mesh ops on the monolith. Faster
    to start but fewer downstream wins.
  - exit: write a diagnosis-only report and stop.

Which would you like?
```

## Output

Record the user's choice in the optimization plan and emit it for downstream phases:

```json
{
  "phase": "2e",
  "choice": "deduplicate-internally | extract-as-assets | decompose-for-selective-loading | optimize-as-is | exit | jump-to-verify",
  "recommended": "deduplicate-internally",
  "reasoning": "monolithic with 4 repeated patterns; restructure recommended",
  "boundary_plan_ref": "<path to plan packet for apply-restructure>",
  "user_confirmed_at": "<ISO 8601 timestamp>"
}
```

## Rules

- Always present the choice; do not auto-proceed even when SA's recommendation is high-confidence.
- **Headless / batch / non-interactive contexts:** If the agent cannot ask the
  user (e.g. running in a scripted pipeline or with no interactive session),
  **STOP and write the decision as a blocker** in the preflight or report
  artifact. Do NOT substitute a default choice like "optimize-as-is" on the
  user's behalf. The gate exists because restructure-vs-optimize-as-is has
  irreversible consequences that only the user can weigh. Write a
  `restructure_decision_pending` artifact and halt Phase 2e until a human
  confirms.
- Do not recommend restructure when SA's `phase_recommendation = already_optimized`.
- Always present the selective-loading choice when SA reports `payload_count: 0`
  and clear asset-boundary candidates, even if hierarchy dedupe is not
  recommended and the asset is otherwise ready for mesh optimization.
- If the user picks `deduplicate-internally`, skip Phase 2f (`apply-restructure`).
  The stage stays monolithic. Record the choice and continue to Phase 4 where
  SO's `deduplicateHierarchies` runs (gated by `operationsAvailable`).
- If the user picks `extract-as-assets`, hand off to `apply-restructure` with
  the boundary plan and `goal: extract_as_assets`; do not perform writes from
  this reference.
- If the user picks `decompose-for-selective-loading`, hand off to
  `apply-restructure` with the selected boundary level and
  `goal: selective_loading`; do not perform writes from this reference.
- If the user picks `exit`, immediately go to Phase 6d (`optimization-report`) - do not silently continue to Phase 3.

## Limitations

- Decision skill only; does not write USD files.
- Depends on SA's classification quality; if SA's `phase_recommendation` is missing, return to `usd-structure-assessment` rather than guessing.
- Asset-boundary candidates from SA §2.7 are suggestions, not enforcement; the user can override the cut points before invoking `apply-restructure`.

## Troubleshooting

- If SA reports no candidates and the user wants to restructure anyway, ask for explicit cut points (prim paths) before invoking `apply-restructure`.
- If validator findings (Phase 2c) say the asset has structural issues that would block restructure (e.g. unresolved references), surface them to the user before asking for a choice.
- If the USD Python runtime is unavailable in the active environment, `apply-restructure` cannot author the rewrite. In that case `extract-as-assets` and `decompose-for-selective-loading` are effectively unavailable; tell the user clearly and offer `deduplicate-internally`, `optimize-as-is`, or `exit` only.

## References

Read before deciding:

- `skills/omniverse-usd-performance-tuning/references/workflow.md` - the canonical 7-phase flow context for where this gate sits.
- `skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/instancing-readiness/references/instancing-tradeoffs.md` - merge safety and dedupe trade-offs that affect the restructure-vs-optimize-as-is call.
- `usd-structure-assessment/README.md` §2.7 (Asset boundary identification) - the source of boundary candidates.
- `usd-structure-assessment/references/usd-edit-target-planner/README.md` - downstream skill that places the restructure outputs into a coherent edit-target plan.
