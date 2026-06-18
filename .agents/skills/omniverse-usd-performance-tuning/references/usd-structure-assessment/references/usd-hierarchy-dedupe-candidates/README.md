# USD Hierarchy Dedupe Candidates

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

## When to Use

Use when finding repeated USD subtrees that may become shared prototypes or references before mesh-level dedupe.

## Instructions

1. Confirm the target asset, artifact, or user intent and check the prerequisites listed below.
2. Read only the referenced files needed for the current phase, failure mode, or output contract.
3. Follow the workflow, rules, and safety gates in this reference before invoking downstream references or shell commands.
4. Return the result using the Output Format section and name any blocked prerequisite or unresolved user decision.

## Output Format

Return a concise status or report that names the input, selected runtime or evidence source, actions planned or performed, artifacts written, blockers, and the next validation or user-decision step. When a schema or template is referenced below, conform to that contract.

Use this after `usd-structure-assessment` and before unscoped
`deduplicateGeometry` when a stage appears monolithic or assembly repetition is
likely.

## Purpose

Produce a read-only candidate report for repeated subtrees that could be
rewritten as shared prototype/reference assets. This is hierarchy-level analysis,
not mesh-level deduplication, and it must not modify the stage.

## Prerequisites

- Run after `usd-structure-assessment` when possible.
- Know the scan root, or use the composed stage root when the user gives no
  narrower scope.
- Use a composition audit first if references, payloads, or edit targets are
  unclear.

## Limitations

- Candidate groups are advisory; no savings are achieved until a rewrite and
  after-profile confirm them.
- Subtree hashes can produce false positives or miss semantic differences; use
  stricter hash levels or scoped value checks before committing to a rewrite.
- This does not replace mesh-level dedupe inside unique prototypes.

## Troubleshooting

- If repeated content is likely but no groups appear, try `HASH_LEVEL=2` for a
  structural pass.
- If candidates are noisy, raise the hash level, increase filters, or collapse
  nested groups.
- If instanceability is blocked, inspect relationships and external targets
  before recommending `instanceable=true`.

## Examples

- "Find hierarchy dedupe candidates in this factory stage before mesh dedupe."
- "Check whether repeated conveyor modules should become shared references."

## When To Run

Run when any of these are true:

- High mesh count with few or zero instances.
- Repeated CAD/BIM assembly names, numeric suffixes, or copied modules,
  including patterns that appear only below depth 2 (for example under
  building/floor/discipline/category containers).
- Structure assessment reports a monolithic root layer with little composition.
- `deduplicateGeometry` would otherwise run over tens of thousands of meshes.
- The customer needs an explainable restructuring plan before optimization.

Skip when the stage is already strongly instanceable and repeated content is
clearly represented through references/payloads, and there is no deep repeated
name signal, prototype inflation, or mesh-dedupe evidence suggesting copied
hierarchies.

## Method

1. Open the composed stage read-only.
2. Traverse the selected `ROOT` and compute bottom-up subtree hashes.
3. Build normalized sibling-name groups across multiple hierarchy depths,
   stripping numeric suffixes, copy suffixes, and generated export IDs. A clean
   root-level scan is not sufficient for CAD/BIM trees where duplicated modules
   often live at depth 3+.
4. Build a candidate hash for each possible prototype root that excludes only
   the candidate root's own name and placement xform.
5. Group candidate roots by hash and normalized path pattern.
6. Rank groups by estimated prim savings:
   `subtree_prims * (copies - 1)`.
7. Collapse nested groups by default so parent candidates absorb redundant child
   candidates.
8. Optionally classify instanceability by checking whether relationships inside
   the subtree target internal content, consistent external content, or
   inconsistent external content.

Use `HASH_LEVEL=2` for a fast structural pass, `HASH_LEVEL=3` to include default
attribute values, and `HASH_LEVEL=4` when relationship targets and time samples
must distinguish candidates.

For a precise behavior spec, read
`references/instance-candidate-finder-spec.md` only when implementing or
debugging the analyzer. For the follow-on rewrite behavior, read
`skills/omniverse-usd-performance-tuning/references/usd-structure-assessment/references/apply-restructure/references/hierarchy-dedupe-rewrite-tool-spec.md`.

## Output

Report:

- Root scanned and hash level.
- Number of prims hashed.
- Maximum hierarchy depth scanned and whether top groups were discovered below
  depth 2.
- Duplicate group count after filters/collapse.
- Top groups with candidate hash, subtree prim count, copy count, estimated prim
  savings, and representative paths.
- Clean/blocked instanceability savings when that check is enabled.
- Caveats that the report is advisory and no stage edits were made.

## Handoff

For top candidates:

1. Confirm likely candidates with a stricter hash level or scoped value check.
2. Choose an edit target with `usd-edit-target-planner`.
3. Use `restructure-decision` and `apply-restructure` to rewrite repeated
   hierarchy as references/payloads to shared prototype assets.
4. Run `so-run-operations` on the new explicit prototypes or sub-assets.
5. Run mesh-level `deduplicateGeometry` only inside remaining unique prototypes
   or scoped sub-assets.

Do not claim savings as achieved until a rewrite is performed and after-profile
metrics confirm it.
