<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Product Slide Contract

Build four managed slide roles from one validated slide model.
Keep visible wording, facts, links, ordering, and source notes identical across backends.

## Contents

- [Managed roles](#managed-roles)
- [Executive roadmap](#executive-roadmap)
- [Capability matrix](#capability-matrix)
- [Markitecture](#markitecture)
- [Weekly Executive Scorecard](#weekly-executive-scorecard)
- [Managed notes](#managed-notes)
- [Refresh and ordering](#refresh-and-ordering)
- [Parity](#parity)
- [Density and publication](#density-and-publication)

## Managed Roles

Use this exact order:

1. one or more alternating `roadmap-executive` and `roadmap-capability` page pairs;
2. one `markitecture` slide;
3. one `weekly-release` slide.

Assign every audience-facing item a stable `contentId`.
Use the same `contentId`, text, URL, and source record in both backends.

Each roadmap slide must record a 1-based `pageIndex`, total `pageCount`, and stable `instanceId`.
Use `roadmap-executive.N` and `roadmap-capability.N` for page `N`.
Reject a missing, duplicate, unknown, or reordered roadmap page instance.

## Executive Roadmap

Show eligible native GitHub milestones as delivery windows.
Show every open or closed native Epic assigned to each eligible milestone as one reviewed
executive row.
Also show an open unmilestoned native Epic when its owner-reviewed runtime
`presentationMilestoneNodeId` equals that selected milestone's node ID.
Keep its native milestone null in the model and evidence.

For every milestone, include:

- native milestone identity and display title;
- optional display alias;
- concise focus label from the dominant reviewed roadmap area;
- ordered Epic presentation summaries and Epic URLs;
- native Epic state in the shared model;
- progress in the shared model only when measurable.
- normalized active milestone status and the exact native due date in the shared model.

The focus label uses the roadmap area with the most classified Epic entries.
Use `roadmapAreas` order to resolve a tie.
Use `Needs classification` when none of the displayed Epics has a reviewed area.

The visible roadmap rows retain the native exemplar's black bullet, hanging indent,
paragraph spacing, and 92% line spacing.
For an open Epic, render the two-to-four-word `displayTitle` and its colon in bold.
Render one space and the three-to-ten-word `shortenedOutcome` in regular text.
For a closed Epic, prefix the label with a checkmark (`✓`) and one space, then render
`✓ displayTitle:` in bold.
Render its `shortenedOutcome` in regular gray `#5B5B5B` text.
The complete row must not exceed 90 characters, including any checkmark, the colon, and the space.
Keep all roadmap text unlinked, as in the exemplar.
Retain issue and milestone URLs in the shared model and speaker notes.
Keep the two-line `NemoClaw:` plus focus treatment and the plain green milestone labels.
Keep native Epic state and progress in the model, source notes, and validation evidence.

Do not render a closed milestone, a past-due open milestone, or an undated open milestone.
Do not render an open unmilestoned Epic without a valid owner-reviewed presentation grouping.
Never label a presentation-grouped Epic as natively assigned to its presentation milestone.
Preview evidence must list each omitted past-due or invalid-due open milestone and its lifecycle
blocker. Closed milestone omissions have no lifecycle finding.
The source contract defines the publication result for these omissions.

Read both summaries from the owner-only runtime presentation map.
Require the mapped node ID and issue number to match the included Epic.
Require `boundBodySha256` to match the Epic body SHA-256 in the snapshot.
Block when either summary is missing or outside its word or complete-row limit.
Never use `## Outcome`, the cleaned Epic title, truncation, or an ellipsis as visible fallback text.

Do not show a roadmap Epic as a currently supported product capability.
Do not hardcode milestone titles or counts.
Derive the ordered columns from the eligible milestone evidence and the rows from the complete
native Epic set for each milestone. Never sample, cap, or slice that set. The validator must reject an
omitted or duplicate Epic even when the model hash has been recomputed.

The canonical runtime exemplar has capacity for three milestone columns.
Preserve milestone order and partition the complete selection into consecutive groups of three.
Create one executive and capability slide pair for each group.
The last pair can contain one, two, or three milestones.
Do not combine, sample, or omit milestones to keep one slide pair.

Prefer one line and permit two only when the runtime template remains legible.
Revise the reviewed body-bound runtime map when a valid row does not fit.
Do not remove an Epic to satisfy layout density.

## Capability Matrix

Use `NemoClaw Feature Roadmap` as the visible slide title.
Use milestones as columns and explicit presentation areas as rows.
The initial areas are:

- `Usability and Onboarding`
- `Agent Features`
- `Acceleration and Optimization`
- `Integrations and Blueprints`

Read the reviewable classification from the owner-only runtime presentation map.
Do not derive a category from title words, labels, prior slides, or model judgment.

Put every classified Epic in exactly one area and one milestone column.
When `roadmapArea` is absent, show the same mapped `displayTitle` in the unclassified preview.
Do not prefix or replace that label with `Needs classification:`.
Block publication while any included Epic remains unclassified.
Store the native issue number on every matrix item and require it to match the canonical issue URL.
For an open Epic, render the same two-to-four-word `displayTitle` used on the executive slide in
bold.
For a closed Epic, render `✓ displayTitle` in bold.
Follow either label with a space and `(#NNNN)`. Link only the `#NNNN` evidence span.
Do not add a colon, executive context, or other prose.

Use a native table.
Keep cell content to no more than three compact open or completed entries.
Four entries in one cell block layout and publication.
Do not move or omit an Epic to satisfy this limit.
Do not place executive context in a matrix cell.

Use the same milestone group and page metadata as the matching executive slide.
The last page can populate one, two, or three milestone columns.
Preserve all four native table columns.
Do not add placeholder milestones to unused template columns.
The base capability exemplar has three native `HOME_PLATE` shapes in the table's top row.
Render each milestone title in the shape aligned with its native-table column.
Keep the milestone title unlinked.
Keep all four native-table top-row cells blank as a structural underlay.
Preserve the white table dividers.
Do not render milestone focus or status on the capability slide.
Keep focus on the matching executive slide only.
Do not render a bottom milestone label.
On a final partial page, delete each unused top-row `HOME_PLATE` shape under exact frame-map
authorization and keep every unused body cell empty.

### Public Template Examples

The public executive and capability exemplars may use approved GitHub-backed roadmap entries from
the public `NVIDIA/NemoClaw` repository.
Use paired visible patterns such as:

- executive: `Guided Onboarding: Start agents in OpenShell sandboxes with fewer manual steps.`;
- capability: `Guided Onboarding (#NNNN)`;
- executive: `Agent Routing: Send sample work through a selected model path.`;
- capability: `Agent Routing (#NNNN)`.

Apply the executive and capability run styles defined above.
Use the template hyperlink style only on each exemplar `#NNNN` span.
Generated copies must replace every exemplar label, context, issue number, and link from the frozen
model.
Do not put confidential or private content, source notes, or private evidence records in the public
template.

## Markitecture

Create one new editable native-shape slide.
Use a sparse left-to-right flow:

1. Users and operators
2. NemoClaw host CLI and versioned blueprint
3. OpenShell gateway
4. OpenShell sandbox with the selected agent runtime and NemoClaw integration layer
5. Managed inference and approved integrations
6. Managed state and artifacts

Keep connectors behind nodes.
Keep labels concise.
Use native shapes and text.
Do not rasterize the diagram.
Give every connector one arrowhead pointing from its modeled `from` node to its `to` node.
Use the claim ledger's `lineStyle`: the rebuild, snapshot, and restore relationship is dashed and the other six current relationships are solid.

Every visible claim must match one entry in `markitecture-claims.json` and the collected documentation evidence.
Include the claim ledger in speaker notes.

Apply `platform-support.mdx` to every platform claim.
Do not show native Podman, Kubernetes, OpenShift, multi-tenant isolation, or another roadmap-only item as current support.

## Weekly Executive Scorecard

Keep `weekly-release` as the stable internal role.
Render the audience-facing title as
`NemoClaw Weekly Executive Scorecard | <UTC reporting-window date range>`.
Create exactly one singleton scorecard slide.

Show these top cards:

- stars total and the explicitly labeled seven-day metric;
- forks total and the explicitly labeled seven-day metric;
- merged pull requests total and seven-day merged count;
- VDR or UAT issues opened and closed in the seven-day window;
- latest stable release.

Use the metric mode from the source contract.
Never label retained additions as net change.
Release collection supplies top-card evidence only.
The number of releases never changes the row count, pagination, slide count, or order.

Below the cards, use narrative `milestoneRows` as an explicit one-to-three-row selection from the
eligible roadmap and preserve that selection's relative roadmap order. Roadmap pagination may
contain additional milestones.
Put each milestone label in its inspected NVIDIA-green left rail with bold white text and use the
column headings `UPDATES` and `RISKS / BLOCKERS`.
Retain every Epic, open or closed, from each explicitly selected weekly milestone exactly once in
its row's `Updates` list.
Use the reviewed short label in bold followed by concise, regular update context.
Bind each update to the Epic and frozen evidence that supports it.

Render only documented risks or blockers.
When the complete evidence records none for a row, render exactly one bullet containing `None`.
Use native paragraph bullets for every Updates and Risks / Blockers entry.
Do not type a bullet glyph or create a blank bullet paragraph.

Milestone rows are presentation groupings.
They do not create or imply a native GitHub milestone assignment.
More than three explicitly selected weekly rows block publication; do not paginate, collapse, or
reorder that weekly selection.

## Managed Notes

Start each managed slide's notes with:

```text
[NEMOCLAW-MANAGED-SLIDE v1]
role=<managed role>
```

For a roadmap slide, add these records immediately after the role:

```text
instance_id=<roadmap-executive.N or roadmap-capability.N>
page=<N>/<page count>
```

For `weekly-release`, add these records immediately after the role:

```text
snapshot_as_of=<ISO-8601 timestamp>
window_start=<ISO-8601 timestamp>
window_end=<ISO-8601 timestamp>
milestone_report_observed_at=<ISO-8601 timestamp>
milestone_report_sha256=<canonical report SHA-256>
milestone_rows=<ordered visible milestone titles separated by " | ">
```

Then add the bound hashes:

```text
model_sha256=<canonical model SHA-256>
snapshot_sha256=<canonical snapshot SHA-256>
```

Then add:

```text
[Sources]
<one stable source record per line>
```

For markitecture, also add:

```text
[Claims]
<claim ID, path, heading, commit SHA, and section SHA-256>
```

Generate notes from the model.
Do not let either backend author its own wording.
Do not include private template URLs, IDs, comments, or source notes.

## Refresh and Ordering

Preserve the title slide and every unrelated slide.
Use managed note markers to find existing managed slides.

On refresh:

1. Read all slide notes.
2. Identify each roadmap slide by its exact `instanceId`. Identify `markitecture` and `weekly-release` by their singleton role.
3. Reject duplicate managed slide identities, a missing roadmap `instanceId`, or an `instanceId` on a singleton role.
4. Update one compatible existing slide for each expected managed slide identity.
5. Reject an incompatible existing managed slide before writing output; when replacement is needed, regenerate from the exact user-named template revision or file whose pre-archive inspection, semantic fingerprint, file hash, complete role map, and protected-text review meet the approval conditions in `template-contract.md`.
6. Keep exactly one slide for each roadmap `instanceId`, one `markitecture` slide, and one `weekly-release` slide.
7. Put the alternating roadmap instances first in page order, followed by `markitecture` and `weekly-release`.
8. Preserve unrelated slide content and relative order. Google Slides also preserves those slide IDs. PowerPoint duplicates every mapped source slide through the validated template starter, so private PowerPoint slide IDs are not a cross-backend contract; its unchanged content, layout, master, and order are.

Do not append duplicate managed slides on repeated runs.

## Parity

Create a canonical semantic readback for each backend.
Compare:

- managed slide identity and order, including each roadmap `instanceId`, `pageIndex`, and `pageCount`;
- stable content IDs;
- visible text and metric values;
- milestone and Epic order;
- native milestone evidence and any separate owner-reviewed presentation grouping;
- links;
- source notes;
- claim-ledger records;
- native object kind for text, table, and diagram content;
- `visibleTextInventory` derived from actual editable objects, native table cells, and inherited layers;
- `hyperlinkInventory` derived from actual linked native text runs;
- `connectorInventory` derived from native arrowheads, endpoint geometry, and solid or dashed line treatment;
- `capabilityStructureInventory` derived from the native table dimensions, blank top row, physical
  divider grid, used milestone shape type/text/column alignment, unused top-row milestone-target
  count, nonempty unused-body-cell count, and bottom milestone-target count;
- template and model hashes.

Normalize line endings before comparison.
Compare each backend's actual visible-text inventory independently of the model-derived semantic projection.
Do not compare backend object IDs, archive bytes, or pixel identity.

Block publication on any factual, wording, order, link, note, or claim mismatch.

## Density and Publication

Use runtime template typography and preserve its hierarchy.
Shorten flexible wording before reducing type.
Do not reduce narrative text below 12 pt or below the runtime template's size for that role.

Block publication on:

- an omitted or duplicate included Epic;
- an unmilestoned open Epic without a valid owner-reviewed `presentationMilestoneNodeId`;
- a `presentationMilestoneNodeId` that does not resolve to the node ID of a selected eligible
  milestone;
- more than three selected weekly milestone rows;
- an omitted or duplicate weekly Updates Epic;
- a weekly update, risk, or blocker without frozen source evidence;
- a typed bullet glyph, a blank native bullet paragraph, or a missing required `None` bullet;
- a missing or mismatched weekly report timestamp, report hash, or `milestone_rows` note record;
- a missing or incorrect completed-Epic checkmark or context treatment;
- clipped or overflowing text;
- unexpected title wrapping;
- unresolved placeholder text;
- stale exemplar content;
- an empty native bullet paragraph;
- rasterized narrative text;
- an unrecognized native object;
- a font substitution that changes layout;
- a missing or duplicate managed slide identity, or a missing or duplicate singleton role;
- a parity mismatch.

Preview must show every blocker and the affected role.
