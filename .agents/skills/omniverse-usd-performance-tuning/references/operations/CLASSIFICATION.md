---
agent_context: usd-performance-workflow
agent_routes:
  - omniverse-usd-performance-tuning
agent_next:
  - README.md
  - EXECUTION.md
freshness: 2026-05-20
version: "0.1.0"
---
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Operation Classification Rubric

Every entry in `references/operations/_curation.json` has a `status` field assigned by this rubric. Every entry's `rationale` field must cite the specific clause below it satisfies, with the format `<status>: <clause>: <one-sentence justification>`.

This rubric is local routing policy only. Scene Optimizer operation mechanics
belong to upstream `usd-optimize`; use
[`usd-optimize` upstream handoff](../upstreams/usd-optimize.md) for the central
package and operation-guide resolution rule.

## status: canonical

The op is part of the standard 7-phase optimization flow described in
`skills/omniverse-usd-performance-tuning/references/workflow.md`. At
least one local workflow reference routes to it, or upstream `usd-optimize`
names it in a public pipeline that this workflow deliberately adopts. The
agent reaches for canonical ops by default.

Required evidence:

- **C1.** The op has at least one `"operation": "<key>"` reference in the catalog skill or nested workflow references OR in an adopted upstream `usd-optimize` named pipeline, **and**
- **C2.** The op is `loss_class: lossless` or `bounded-loss` (not `destructive`).

A `destructive` op is `specialty`, never `canonical`, regardless of how often it appears.

## status: specialty

The op is gated behind explicit user confirmation in `so-run-operations`'s destructive-op table, or has narrow workflow-specific applicability (e.g., `pythonScript` used by `so-create-proxy` for USD authoring glue).

Required evidence:

- **S1.** The op is `loss_class: destructive` and appears in the `so-run-operations` destructive-op confirmation table, **or**
- **S2.** The op is referenced in a skill body that handles a specific workflow (proxy creation, restructure orchestration, etc.) and the rationale names that workflow.

## status: analysis

The op is read-only and produces a report/finding; used by `so-run-validators` or `so-interpret-validators`. Never mutates the stage.

Required evidence:

- **A1.** The op is `loss_class: lossless`, **and**
- **A2.** The op produces a structured finding rather than a transformed stage (often a `find*`, `count*`, or `print*` op), **and**
- **A3.** The op is either currently wired into `so-run-validators`/`so-interpret-validators` OR is a clear candidate for that wiring (`wired_into` may be empty for future-candidate analysis ops).

## status: documentary

The op has a local routing stub for completeness but no local workflow route reaches for it. The agent is allowed to recommend it only when the user explicitly names the op or describes a use case it uniquely fits.

Required evidence:

- **D1.** The op has zero `"operation": "<key>"` references in skill bodies, **and**
- **D2.** The op is not in an adopted upstream `usd-optimize` pipeline for this workflow, **and**
- **D3.** The op is not in the tuning workflow's recommended-ops sections.

`documentary` ops MAY appear as a passing mention in the tuning workflow's
op-role index without being recommended for use — that doesn't disqualify them
from this tier.

## status: deprecated

The op exists upstream but this skill pack actively discourages its use. The agent should warn before recommending one.

Required evidence:

- **X1.** The op's upstream behavior is known to be replaced by a better-supported alternative documented in this repo, **and**
- **X2.** The rationale names the recommended replacement.

---

## How to cite a clause in `rationale`

Format: `<status>: <clause>: <one-sentence justification>`. Examples:

- `"canonical: C1+C2: invoked by so-run-operations destructive-op table; loss_class bounded-loss."`
- `"specialty: S1: destructive; appears in so-run-operations destructive-op confirmation table."`
- `"analysis: A1+A2: lossless finding-producer; candidate for so-interpret-validators wiring."`
- `"documentary: D1+D2+D3: no JSON references, no pipeline, no workflow recommendation."`

The schema at `scripts/operation-curation.schema.json` enforces that every entry's `rationale` starts with `<status>:` matching the entry's declared `status`. The coverage audit additionally verifies that `canonical`-status ops have a non-empty `wired_into`, and that each `wired_into` target file actually references the op.
