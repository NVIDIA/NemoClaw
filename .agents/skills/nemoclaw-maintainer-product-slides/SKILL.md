---
name: nemoclaw-maintainer-product-slides
description: Generate or refresh the evidence-bound NemoClaw product-slide set in native Google Slides and PowerPoint. Use for paginated executive milestone roadmaps, roadmap capability matrices, editable NemoClaw markitecture, weekly executive scorecards, cross-format slide parity, or a preview or publication update to an approved product-slide template.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Generate NemoClaw Product Slides

Generate four base narrative roles from one frozen source bundle and one validated slide model.
The bundle keeps `snapshot.json` and the separately hashed `narrative-input.json` frozen together;
the weekly report is not embedded in the GitHub snapshot.
Repeat the two roadmap roles as alternating executive and capability page pairs when more than
three milestones are eligible.
Keep GitHub and the source template read-only.
Publication approval authorizes only the named target deck or output file; changing the source template is outside this workflow.
Treat this as a maintainer-owned reporting workflow.
Generated roadmap content does not establish a support commitment.

## Establish the Runtime Boundary

1. Work from a trusted NemoClaw checkout.
2. Follow the repository `AGENTS.md`, `WRITING.md`, controlled-word list, and documentation writing contract.
3. Collect only from `NVIDIA/NemoClaw` for this maintainer workflow.
4. Use authenticated, read-only GitHub access.
5. Unless the user explicitly names an alternate template, use the public Google Slides source in
   [`google-template.json`](references/google-template.json).
6. The default source is `[Public] NemoClaw Product Slides Template` at
   [its canonical Google Slides URL](https://docs.google.com/presentation/d/1wnVoqkjV_KTGwLkm6fFGnIGJ1-1YKfpOAg4HIqrXvBk/edit).
7. Bind an explicitly named alternate Google Slides template to its complete inspected source state.
   Bind an alternate PowerPoint template to its exact runtime file.
8. For a default PowerPoint run, export the exact inspected Google source into the owner-only runtime directory.
9. Bind that read-only export to the same inspected Google source state. Do not use a second default template.
10. Keep private template URLs, IDs, object maps, exports, fonts, logos, notes, and comments outside Git.
11. Create a new Google Slides copy for every run. Never edit the default or alternate source template.
12. Default to `preview`. For a Google target write, require explicit approval and a fresh target revision read. For PowerPoint publication, require the exact reviewed preview and bound publication evidence.
13. Keep every runtime input and artifact in one owner-only directory until the user completes review and directs cleanup.
14. Before GitHub collection, verify the applicable prerequisites:
    - a POSIX runtime that exposes `process.geteuid`; stop on Windows or another non-POSIX host;
    - an active GitHub CLI login;
    - if Google Slides is requested, the Google Slides authoring skill and Drive connection;
    - if PowerPoint is requested, a successfully loaded bundled presentation runtime.
    If a prerequisite is missing, stop before collection and report the exact missing capability.

Load only the references required for the current stage. Read each selected reference completely
before acting:

- Before collection, read [runtime inputs and commands](references/runtime-inputs.md), the
  [source contract](references/source-contract.md), and the
  [milestone alias and presentation seed](references/roadmap-presentation.json).
- Before building or validating the model, read the
  [slide contract](references/slide-contract.md) and
  [slide-model schema](references/slide-model.schema.json).
- Before collecting markitecture evidence, read the
  [Markitecture claim ledger](references/markitecture-claims.json).
- Before either rendering workflow, read the
  [template contract](references/template-contract.md).

Do not preload references for a later stage.

## Build One Frozen Model

Run the stages in this order:

1. Collect GitHub evidence with `scripts/collect-github-snapshot.mts`.
2. Create the owner-only runtime presentation map from every Epic assigned to a selected native
   milestone and each open unmilestoned candidate the owner selects for presentation grouping.
3. Collect documentation evidence from the snapshot's recorded Git commit with `scripts/collect-doc-evidence.mts`.
4. Review and condense source-bound milestone updates and risks into a runtime narrative input.
5. Build `slide-model.json` with `scripts/build-slide-model.mts`.
6. Validate the model with `scripts/validate-slide-model.mts`.
7. Render both requested formats from that exact model.
8. Read both outputs back and run `scripts/compare-output-parity.mts`.

Use the runnable commands and runtime JSON contracts in
[`runtime-inputs.md`](references/runtime-inputs.md).

Never recollect one backend separately.
Never use stale cached GitHub data when the user did not supply `--snapshot`.
Bind every narrative edit to its source object and body hash.

Create `presentation-map.json` under the owner-only runtime directory after snapshot collection.
Give every Epic assigned to a selected native milestone and each selected unmilestoned candidate
exactly one entry with the snapshot's node ID, issue number, and body SHA-256. Use a reviewed
`displayTitle` of two to four words and a reviewed
`shortenedOutcome` of three to ten words. The body hash binds both summaries.
Do not use source prose as visible fallback text.

Render each open executive Epic as bold `displayTitle:` plus regular `shortenedOutcome`.
Render each closed executive Epic as bold `✓ displayTitle:` plus regular `shortenedOutcome` in
gray `#5B5B5B`.
The complete row, including any checkmark, the colon, and the space, must not exceed 90 characters.
Keep executive Epic text unlinked.
Render each open capability Epic as the same bold `displayTitle` followed by a space and
`(#NNNN)`.
Render each closed capability Epic as bold `✓ displayTitle` followed by a space and `(#NNNN)`.
Link only the `#NNNN` span.
Do not include a colon or the executive context in a capability cell.
Allow no more than three compact Epic entries in one capability cell.
Four entries block layout and publication; do not move or omit an Epic.

The base capability role has three inspected native `HOME_PLATE` milestone shapes.
Render its visible title as `NemoClaw Feature Roadmap`.
Keep them in the top row and align one shape with each native-table milestone column.
Bind them through capability `operations` to `columns.0.title` through `columns.2.title`.
Keep every cell in the native table's top row blank, including its first cell.
Preserve the white table dividers.
Do not render milestone focus or status on the capability slide.
Do not render a bottom milestone label.

Keep presentation wording separate from classification.
`roadmapArea` may be absent from a runtime entry.
In that case, show the same short label in the unclassified preview and block publication until a
reviewed area is present.
The checked-in `roadmap-presentation.json` may resolve milestone aliases during collection.
Its Epic entries are optional seeds for the owner-only runtime map.
After collection, keep every Epic assigned to a selected native milestone plus only the open
unmilestoned candidates the owner selects for presentation grouping. Review every field and bind
each entry to the current snapshot body hash.
Never pass the checked-in seed directly to model construction or publication.

Allow the public template to use approved GitHub-backed NemoClaw roadmap examples from the public
`NVIDIA/NemoClaw` repository.
They must demonstrate the same label, context, and linked-number pattern.
Do not include confidential or private content in the public template.
Generated copies must replace every exemplar label, context, issue number, and link from the frozen
model.

Use five releases when `--release-count` is absent.
Release collection supplies the latest-release top card and its evidence only.
The number of releases never changes weekly milestone rows, pagination, slide count, or order.
Use the exact live collection start time for `asOf`.
Require an explicit snapshot for offline reproduction.
Follow the complete offline procedure in
[`runtime-inputs.md`](references/runtime-inputs.md#replay-a-frozen-snapshot-offline); an offline replay does not claim current GitHub state.
Treat a one-format result as preview-only.
Publication requires actual Google Slides and PowerPoint readbacks plus a passing parity receipt.

Chunk eligible milestones in their resolved order, with at most three milestones in each roadmap page pair.
Every non-final pair must contain three milestones.
The final pair can contain one to three milestones.
Authorize deletion of each unused executive title, focus, and outcome object.
Authorize deletion of each unused capability top-row `HOME_PLATE` shape.
Delete only those exact frame-map targets.
Keep the capability native-table top row blank and clear each unused body cell.
Include every open or closed native GitHub Epic assigned to each eligible milestone.
Also include an open native Epic with no GitHub milestone when its owner-reviewed runtime entry has
`presentationMilestoneNodeId` that equals the node ID of one selected eligible milestone.
That field controls presentation grouping only and must not claim or change GitHub state.

Keep the internal singleton role `weekly-release` and render its audience-facing title as
`NemoClaw Weekly Executive Scorecard | <UTC reporting-window date range>`.
Create exactly one weekly scorecard. Its narrative `milestoneRows` explicitly select one to three
eligible roadmap milestones and preserve their relative roadmap order; they do not need to include
every milestone across paginated roadmap slides.
Retain every Epic, open or closed, from each explicitly selected weekly milestone exactly once in
that row's `Updates` list.
Keep each milestone label in its inspected NVIDIA-green left rail with bold white text.
Use native paragraph bullets for `Updates` and `Risks / Blockers`; do not type bullet glyphs.
Render exactly one native `None` bullet when the complete evidence records no risk for a row.
Bind every update and risk to the frozen report and record its observation time, canonical hash,
and ordered `milestone_rows` marker in the slide's managed notes.
More than three explicitly selected weekly rows block publication; do not paginate, collapse, or
reorder that weekly selection.

A roadmap milestone is eligible only when all these conditions are true:

- its native state is `OPEN`;
- `closedAt` is null;
- `dueOn` is present and valid;
- the `YYYY-MM-DD` portion of `dueOn` is on or after the `YYYY-MM-DD` portion of `asOf`.

The due-date boundary is inclusive. A milestone due on the `asOf` date remains eligible.
Explicit selection preserves requested order, but it does not override eligibility.
Automatic selection sorts eligible milestones by `dueOn`, then native milestone number.

Omit every closed milestone, past-due open milestone, and undated open milestone from both roadmap
roles. For each omitted past-due or undated open milestone, record a lifecycle finding with its
native number, title, and remaining open Epic numbers. Omit closed milestones without a lifecycle
finding.
Closed milestones do not remain on the roadmap after closure.

Block publication when an open milestone is past due or has no valid due date.
Use `MILESTONE_PAST_DUE` or `MILESTONE_DUE_DATE_MISSING` in the blocker receipt.
Block publication when an open native Epic has neither a GitHub milestone nor a reviewed
`presentationMilestoneNodeId`.
Use `EPIC_MILESTONE_MISSING` and omit that Epic from both roadmap roles.
Also block and omit it when `presentationMilestoneNodeId` does not equal the node ID of one
selected eligible milestone.
Require the maintainer to close a past-due milestone, move its remaining Epics to another eligible
milestone, set a due date on or after `asOf`, assign the unmilestoned Epic to an eligible native
milestone, or provide the reviewed presentation grouping as applicable.

Within each eligible milestone, keep both open and closed native Epics.
A closed Epic remains visible with the completed checkmark treatment until its milestone becomes
ineligible.

## Render Native Google Slides

Use the `google-drive:google-slides` skill.

1. Use the checked-in default unless the user explicitly names an alternate template.
2. Parse the initial complete source read and render each source slide once.
3. For the default, confirm its ID, title, `requiredAccess`, and every `requiredCapabilities` entry.
4. Hash the complete source projection and semantic fingerprint. Record the revision only when returned.
5. Resolve each default role by its checked-in slide object ID. Preserve every unrelated source slide.
6. Set `parent_folder` to the user-named folder or the literal `root` for My Drive.
7. When possible, preflight the destination's folder type, non-trashed state, and ability to keep the copy `Restricted`.
8. Call Google Drive `copy_file` once with the source URL as `url` and that `parent_folder`.
9. Require the returned copy ID to differ from the source presentation ID.
10. Read the copy metadata. Confirm its type, parent, ownership, `Restricted` access, and non-trashed state.
11. Read the complete source again after copying. Require both source hashes to match.
12. Require the fresh copy to match that stable inspected source state before authoring.
13. On a post-copy mismatch, stop authoring and report the exact copy ID and failed condition.
14. If rollback is authorized, move only that copy to trash and confirm. Otherwise, request user-directed cleanup.
15. Keep the copy's General access `Restricted`. Do not add sharing permissions during generation.
16. Treat a later sharing change as a separate user-authorized action.
17. The invoking user owns the copy unless its destination is a Shared Drive. The Shared Drive then owns it.
18. Target every Google Slides mutation at the verified copy ID. Reject the source ID as a mutation target.
19. Duplicate the inspected executive roadmap and matrix exemplars once for each roadmap page pair.
20. Create the markitecture slide from its distinct checked-in role slide.
21. Duplicate the distinct inspected weekly exemplar once.
22. Edit native text, tables, shapes, links, and notes in place.
23. Preserve masters, layouts, mixed text styles, footers, and protected regions.
24. Preserve the title slide and all unrelated slides.
25. Replace existing managed instances instead of appending duplicates.
26. Add the managed marker, instance marker, page marker, and source notes defined in the slide contract.
27. Read the output structure back and run the Google Slides output issue checker.
28. Export once to PDF and inspect every delivered slide at full size.

Do not import the PowerPoint output into Google Slides.
Do not rasterize editable narrative text.

## Render PowerPoint

Use the `presentations:Presentations` skill and its bundled workspace runtime.

1. Load the bundled presentation runtime.
2. Set its exact `RUNTIME_NODE`, `RUNTIME_NODE_MODULES`, and `RUNTIME_BIN_DIR` paths.
3. Set `SKILL_DIR` to the Presentations skill directory and `TMP_DIR` to the owner-only run directory.
4. For the default, export the exact inspected Google source to a fresh file under `TMP_DIR`.
5. Record the source ID, projection hash, and semantic fingerprint before export.
6. Read the complete source again after export. Require both source hashes to match.
7. Record and compare the source revision only when Google returns one.
8. Require the fresh export to match that stable inspected source state.
9. Do not use a cached, bundled, or earlier PowerPoint export as another default.
10. Use an alternate PowerPoint file only when the user explicitly names it for this run.
11. Inspect the complete source template with the standard read-only inspection helper.
12. Review every source slide, master, layout, placeholder, object role, and full-size render.
13. Create `template-audit.txt`, `deviation-log.txt`, and `template-frame-map.json` in an owner-only template workspace under `TMP_DIR`.
14. Create a runtime role map outside Git.
15. Bind the role map to the template SHA-256, semantic fingerprint, and exact frame-map SHA-256.
16. Run `scripts/build-pptx.mts` directly with `RUNTIME_NODE` and the required template workspace and frame map.
17. Preserve the master to layout to slide hierarchy and every unrelated source slide.
18. Keep all visible narrative text, tables, markitecture nodes, and markitecture connectors editable.
19. Render every delivered slide and inspect it at full size.
20. Reimport the exported file and derive every managed slide's visible-text inventories from its actual objects and inherited layers.
21. Read `managedNotes` from the actual speaker notes and parse `sources` from their `[Sources]` section.

The runtime role map defines four reusable base role contracts.
Its zero-based `targetSlideIndex` values `1` through `4` describe the one-page base layout.
The frame map binds every roadmap model slide to a repeated role entry with its exact `instanceId`.

With three eligible milestones, the four managed slide instances occupy slides 2 through 5.
The output count then equals the complete inspected source count.
Each additional roadmap page inserts one executive and capability pair before markitecture and weekly release.
Each inserted pair adds two output slides and shifts the preserved suffix slides by two positions.
The title and unrelated slides retain their relative source order.

The builder owns the complete authoring sequence.
It validates the inspected template plan before it starts authoring.
It derives the source slide count from the exact PPTX bytes frozen into the authoring surface.
It freezes the validated template, model, role map, frame map, and inspection bytes in the owner-only authoring surface.
It then records exactly one edit marker, prepares the standard starter deck, and runs one temporary plain-JavaScript `.mjs` authoring module.
After export, it writes final layout evidence and runs the standard fidelity check.
The strict identity-aware comparison runs first. For the standard helper's overlay scan only, the builder mirrors the final bounding box onto the matching starter object for exact `rewrite-and-reposition` targets; it does not normalize added or unplanned objects.
Do not run the marker or starter helper separately.

Preview and publication use the same fresh-destination rule.
Every requested output, readback, inspection, preview image, layout file, and montage file must be absent before authoring.
Existing preview and layout directories may be empty.
Immediately before artifact finalization, the builder rechecks path isolation against original and frozen inputs.
It hard-links supporting artifacts first and the PowerPoint file last.
If any link fails, it removes only the artifacts created by that invocation.

Rewrite fidelity preserves effective typography, ordered run styles, native table styles, and the relative order of retained source objects.
It also requires every markitecture connector to remain below every markitecture node.

For PowerPoint publication, pass `--reviewed-preview-pptx` with the exact reviewed preview file plus `--approval` and `--validation-evidence`.
The validation evidence must bind `previewPptxPath`, `previewPptxSha256`, and `outputPath` to those exact files.
Pass `--parity-evidence`, the five source inputs, and the official repository root named in the runtime-input reference.
The repository root must independently verify the recorded documentation Git objects before the exact model rebuild.

Use `@oai/artifact-tool` from the loader-provided Node.js packages.
Do not add it to NemoClaw dependencies.
Do not use a system Node.js executable, `tsx`, `python-pptx`, or OOXML as the slide-authoring surface.
The only permitted OOXML write restores the exact approved `ppt/theme/theme*.xml` parts and their required package declarations.
Do not write Notes Master or connector OOXML.
Create markitecture connectors with the native connector API and attach both endpoints to native node shapes.

## Compare and Gate Publication

Compare semantic readbacks by stable model content ID.
Require identical visible facts, ordering, wording, links, notes, and claim-ledger entries after line-ending normalization.
Require every managed slide instance in both backends to report these artifact-derived arrays:

- `managedVisibleTextInventory` for model-managed slide-local text;
- `protectedVisibleTextInventory` for approved template-owned slide-local text;
- `inheritedVisibleTextInventory` for inherited layout and master text;
- `visibleTextInventory` for the complete text from all three scopes.

Require every capability instance to report an artifact-derived `capabilityStructureInventory`.
It must prove one native 5×4 table, four blank top-row cells, 49 white solid 228600-EMU divider
segments, ordered unlinked `HOME_PLATE` milestone targets centered in their corresponding columns,
zero unused top-row milestone targets, empty unused body cells, and no bottom milestone target.

The managed inventory must equal the exact model-derived visible-text inventory after line-ending normalization, including duplicate strings.
Require each backend's protected inventory to match the exact per-role digest multiset in the reviewed runtime role map.
Require each backend's inherited inventory to contain only the inspected slide-number auto-text, twice on each executive instance and once on each other managed instance.
Then require both backends to report identical protected and inherited inventories.
Read `managedNotes` from the artifact and parse `sources` from the notes before comparing either field with the model.
Do not copy notes, sources, or text inventories from the model into a readback.
Block publication for any slide-local text that is neither model-managed nor approved template-owned text.
Do not compare backend object IDs or raw PPTX bytes.

Block publication when any condition in the source, slide, or template contract fails.
Report the failed condition and one specific remediation.
Do not guess, silently omit content, classify an Epic, or weaken a support claim.

## Report the Result

Report:

- repository commit, query time, snapshot hash, and model hash;
- eligible milestones, open-milestone lifecycle findings, stable tags, and source completeness;
- Google Slides preview-copy URL and PowerPoint path;
- Google Slides destination, owner, and General access;
- runtime exemplar slide IDs used;
- structural, visual, overflow, editability, and parity verdicts;
- source discrepancies and publication blockers;
- source-template, target-deck, GitHub, commit, push, PR, and publication status as separate facts.

Stop for user review before publishing to a target deck, pushing, or opening a PR.
Retain the local runtime directory and Google Slides preview copy until the user directs cleanup; remove only the named run artifacts and confirm their absence afterward.
Never write either source template with this skill.
