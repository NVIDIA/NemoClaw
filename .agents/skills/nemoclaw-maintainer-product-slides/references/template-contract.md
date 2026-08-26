<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Product Slide Template Contract

Treat the approved deck as a runtime template.
Preserve its native hierarchy and objects without committing private identifiers or assets.

## Contents

- [Repository boundary](#repository-boundary)
- [Default Google Slides source](#default-google-slides-source)
- [Runtime inspection](#runtime-inspection)
- [Semantic role map](#semantic-role-map)
- [Template fingerprint](#template-fingerprint)
- [Google Slides adapter](#google-slides-adapter)
- [PowerPoint adapter](#powerpoint-adapter)
- [Protected regions and editability](#protected-regions-and-editability)
- [Visual and structural validation](#visual-and-structural-validation)
- [Publication race check](#publication-race-check)

## Repository Boundary

Never commit:

- a private Google Slides URL or presentation ID;
- a runtime template revision ID or object ID;
- an exported template deck;
- private speaker notes or comments;
- confidential slide content;
- an internal font, logo, theme asset, or master image;
- a runtime role map, frame map, or raw template fingerprint input.

The public source record in
[`google-template.json`](google-template.json) is the approved exception for its URL, presentation ID, and slide object IDs.
Use synthetic template IDs, fonts, colors, shapes, notes, and data in tests.
Do not create an `assets/` directory unless a maintainer approves a redistributable public asset.
Keep the runtime role map, frame map, template audit, deviation log, semantic fingerprint input, template export, previews, and readbacks in the owner-only runtime directory defined in
[`runtime-inputs.md`](runtime-inputs.md#runtime-paths).

## Default Google Slides Source

Unless the user explicitly names an alternate template, use the public source defined in
[`google-template.json`](google-template.json).
Its title is `[Public] NemoClaw Product Slides Template`.
Its canonical URL is
[the approved public Google Slides source](https://docs.google.com/presentation/d/1wnVoqkjV_KTGwLkm6fFGnIGJ1-1YKfpOAg4HIqrXvBk/edit).

Read the complete source at the start of each run.
Hash its complete inspected projection and semantic fingerprint.
The projection includes every source slide in order and every inspected native object, style, link, and note.
Exclude only file ownership, permissions, file ID, and an absent or provider-generated revision value.
Confirm that the presentation ID and title match the checked-in record.
Confirm that source access meets the record's `requiredAccess` value.
Confirm every capability in `requiredCapabilities`.
Stop when an identity, access, or capability check fails.
Do not infer an alternate template from a prior run, nearby deck, or cached input.
An explicitly named alternate applies only to that run and must bind to its complete inspected state.

Create a new Google Slides copy for every run.
Never author in the default or alternate source template.

For a default PowerPoint run, export the exact inspected Google source to a fresh file in the owner-only runtime directory.
The export is read-only against the Google source.
Record the source presentation ID, projection hash, and semantic fingerprint before export.
Read the complete source again after export, and require both hashes to match.
Record and compare the source revision only when Google returns one.
Require the exported PowerPoint inspection to match that stable inspected source state.
Bind the exported file hash and semantic fingerprint to that same inspected deck state.
Do not keep a second default PowerPoint template or reuse an earlier export.

## Runtime Inspection

Read the complete template.
Render every source slide once.
For the default, resolve each role from the slide object IDs in `google-template.json`.
Require markitecture and weekly release to resolve to different source slides.
Derive the complete source slide count from the live read.
Preserve every source slide that the checked-in role records do not select.
If an alternate has an archive divider, reject every later slide as an exemplar.
Use the standard Presentations `inspect_template_deck.mjs` helper for this read-only inspection.
Store its complete output in the PowerPoint template workspace under `TMP_DIR`.

The Google source inspection owns `template-fingerprint-input.json` and the semantic template fingerprint.
The exported PowerPoint inspection separately owns its native hierarchy, role map, and frame map.
It does not replace the Google source as the semantic fingerprint authority.

Inspect:

- slide size and orientation;
- masters and layouts;
- theme colors and font roles;
- inherited and slide-local objects;
- mixed text and paragraph styles;
- tables, shapes, links, notes, and footers;
- protected title, footer, logo, and confidentiality regions;
- object roles and content budgets for the canonical roadmap, matrix, and weekly exemplars.

Choose exemplars by semantic role and evidence type.
Do not choose by object count or visual similarity alone.

After inspection, create these owner-only files directly under the template workspace:

- `template-audit.txt` for the reviewed source hierarchy, objects, placeholders, typography, protected regions, and insertion contract;
- `deviation-log.txt` for each intentional change from a duplicated source slide;
- `template-frame-map.json` for every preserved or managed output slide.

Do not run an authoring marker during read-only inspection.

The four base role families are:

- executive roadmap timeline;
- capability matrix native table;
- weekly executive scorecard surfaces;
- markitecture from the closest inspected blank or content layout.

## Semantic Role Map

Create the runtime role map outside Git.
Use backend-native IDs only in that runtime file.
Use the exact field and operation shapes in
[`runtime-inputs.md`](runtime-inputs.md#powerpoint-role-map).

A runtime role map uses zero-based source-slide indexes and structured target selectors.
The following fragment shows the required addressing contract; replace every synthetic selector and index with values from the current runtime inspection:

```json
{
  "schemaVersion": 1,
  "templateFingerprint": "reviewed semantic SHA-256",
  "templateSha256": "exact runtime template file SHA-256",
  "templateFrameMapSha256": "exact runtime template-frame-map.json SHA-256",
  "insertionIndex": 1,
  "roles": {
    "roadmap-executive": {
      "preArchive": true,
      "sourceSlideIndex": 1,
      "targetSlideIndex": 1,
      "protectedTextSha256": [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ],
      "forbiddenText": ["reviewed stale exemplar string"],
      "operations": [],
      "richTextOperations": [],
      "outcomeListOperations": []
    },
    "roadmap-capability": {
      "preArchive": true,
      "sourceSlideIndex": 2,
      "targetSlideIndex": 2,
      "forbiddenText": ["reviewed stale exemplar string"],
      "operations": [
        {
          "target": { "name": "synthetic-capability-milestone-1" },
          "valuePath": "columns.0.title"
        },
        {
          "target": { "name": "synthetic-capability-milestone-2" },
          "valuePath": "columns.1.title"
        },
        {
          "target": { "name": "synthetic-capability-milestone-3" },
          "valuePath": "columns.2.title"
        }
      ],
      "richTextOperations": [],
      "table": {
        "target": { "name": "synthetic-native-table-name" },
        "topRow": 0,
        "firstMilestoneColumn": 1,
        "milestoneColumnCount": 3,
        "areaLabelColumn": 0,
        "areaRows": {
          "Usability and Onboarding": 1,
          "Agent Features": 2,
          "Acceleration and Optimization": 3,
          "Integrations and Blueprints": 4
        }
      }
    },
    "markitecture": {
      "preArchive": true,
      "sourceSlideIndex": 3,
      "targetSlideIndex": 3,
      "forbiddenText": [],
      "title": {},
      "geometry": {}
    },
    "weekly-release": {
      "preArchive": true,
      "sourceSlideIndex": 4,
      "targetSlideIndex": 4,
      "forbiddenText": ["reviewed stale exemplar string"],
      "operations": [],
      "richTextOperations": [],
      "metricOperations": [],
      "milestoneRowOperations": [
        {
          "target": { "name": "synthetic-row-1-label" },
          "rowIndex": 0,
          "kind": "label",
          "placement": "left",
          "fillColor": "#76B900",
          "textStyle": { "color": "#FFFFFF", "bold": true },
          "paragraphStyle": { "bulletCharacter": "" }
        },
        {
          "target": { "name": "synthetic-row-1-updates" },
          "rowIndex": 0,
          "kind": "updates",
          "nativeBullets": true,
          "paragraphStyle": { "bulletCharacter": "•" }
        },
        {
          "target": { "name": "synthetic-row-1-risks" },
          "rowIndex": 0,
          "kind": "risks",
          "nativeBullets": true,
          "paragraphStyle": { "bulletCharacter": "•" }
        },
        {
          "target": { "name": "synthetic-row-2-label" },
          "rowIndex": 1,
          "kind": "label",
          "placement": "left",
          "fillColor": "#76B900",
          "textStyle": { "color": "#FFFFFF", "bold": true },
          "paragraphStyle": { "bulletCharacter": "" }
        },
        {
          "target": { "name": "synthetic-row-2-updates" },
          "rowIndex": 1,
          "kind": "updates",
          "nativeBullets": true,
          "paragraphStyle": { "bulletCharacter": "•" }
        },
        {
          "target": { "name": "synthetic-row-2-risks" },
          "rowIndex": 1,
          "kind": "risks",
          "nativeBullets": true,
          "paragraphStyle": { "bulletCharacter": "•" }
        },
        {
          "target": { "name": "synthetic-row-3-label" },
          "rowIndex": 2,
          "kind": "label",
          "placement": "left",
          "fillColor": "#76B900",
          "textStyle": { "color": "#FFFFFF", "bold": true },
          "paragraphStyle": { "bulletCharacter": "" }
        },
        {
          "target": { "name": "synthetic-row-3-updates" },
          "rowIndex": 2,
          "kind": "updates",
          "nativeBullets": true,
          "paragraphStyle": { "bulletCharacter": "•" }
        },
        {
          "target": { "name": "synthetic-row-3-risks" },
          "rowIndex": 2,
          "kind": "risks",
          "nativeBullets": true,
          "paragraphStyle": { "bulletCharacter": "•" }
        }
      ],
      "geometryOperations": [
        {
          "target": { "name": "synthetic-weekly-card" },
          "positionEmu": {
            "left": 1000000,
            "top": 2000000,
            "width": 3000000,
            "height": 2500000
          }
        }
      ]
    }
  }
}
```

This fragment is not a ready-to-render map.
Populate every executive and weekly operation, the markitecture title and geometry, and either an existing unclassified warning target or a complete native warning-shape specification.
For `weekly-release`, map exactly one distinct native target for `label`, `updates`, and `risks` at
each row index from `0` through `2`.
Do not declare `releaseBulletOperations` or `releaseOperations` for the lower scorecard rows.
Keep exactly three capability milestone-title operations.
Bind them in order to `columns.0.title` through `columns.2.title` and the three inspected top-row
`HOME_PLATE` shapes.
The capability table's `topRow` identifies the blank structural row under those shapes.
Each object target is a structured selector such as `{ "name": "<runtime object name>" }`; never use a bare object-ID string.
For the default, record `preArchive: true` after a selected role matches its checked-in slide object ID.
For an alternate with an archive divider, also require the selected role to precede that divider.

`sourceSlideIndex` and `targetSlideIndex` are zero-based.
The frame map uses one-based `sourceSlide` and `outputSlide` values.
Each base role key must equal its frame-map `narrativeRole`.
Each source index must identify the same source slide in both files.
For one roadmap page, each target index must identify the same output slide in both files.

The role map defines four reusable base contracts.
The frame map defines one entry for each managed slide instance.
Each roadmap entry must include the model's exact `instanceId`, such as
`roadmap-executive.1` or `roadmap-capability.2`.

Let `P` be the roadmap page count and `S` the complete inspected source slide count.
The output contains `S + (2 × (P - 1))` slides.
With one page, the output contains `S` slides and the managed instances occupy slides 2 through 5.
The frame map must preserve the checked-in title role at its inspected position.
Each additional page duplicates the resolved executive and capability role slides before markitecture.
Resolve markitecture and weekly release from their distinct checked-in slide object IDs.
The frame map shifts each later preserved source slide by two positions for each additional page.
It must preserve every unrelated source slide's relative order and content.
Set `omittedSourceSlides` to an empty array.

A role can include a runtime-only `protectedTextSha256` allowlist.
Each entry must be the lowercase SHA-256 of one approved slide-local template string after line-ending normalization.
Use the field only when inherited-layer comparison cannot classify that protected string.
Keep this allowlist outside Git with the runtime role map.
Do not put the protected wording in a checked-in file.
Do not allowlist model-managed or stale exemplar text.

Map every selected exemplar object to `keep`, `rewrite`, `replace`, `delete`, `add`, or
`rewrite-and-reposition`.
Default to `keep`.
Reject an unmapped placeholder or meaning-bearing object.

Authorize each role-map `geometryOperations` target with one matching frame-map `rewrite-and-reposition`
target.
If an object also changes content, authorize its `rewrite` separately.
Record the approved geometry change in the deviation log.

Keep backend IDs out of `slide-model.json`.
Record only the template fingerprint in the shared model.
Bind the runtime PowerPoint role map to the exact imported template file SHA-256.
Bind it to the exact `template-frame-map.json` bytes with `templateFrameMapSha256`.

A runtime template is approved for one run only when all of these conditions hold:

- the Google Slides source matches the stable complete projection and semantic fingerprint of the default or explicitly named alternate;
- the PowerPoint source is that exact state-bound export, unless the user explicitly names an alternate PowerPoint file;
- complete inspection proves each default role matches its checked-in slide object ID;
- for an alternate with an archive divider, complete inspection proves every selected exemplar precedes it;
- the retained semantic fingerprint input derives the model's `templateFingerprint`;
- the PowerPoint file bytes hash to the role map's `templateSha256`;
- the frame-map bytes hash to the role map's `templateFrameMapSha256`;
- the frame map preserves every unrelated source slide and contains the reviewed model-derived order;
- the reviewed role map binds every meaning-bearing exemplar object and every permitted protected string.

Approval applies only to that exact inspected source state or file hash.
It does not authorize a source-template write, a different export, or publication.

## Template Fingerprint

Create the fingerprint input from the complete Google source inspection.
Use that Google source projection as the semantic authority for both backends.
Keep the exported PowerPoint inspection and its frame map as separate native bindings.

Create one runtime JSON object with these seven required top-level fields:

- `slideSize`: exact keys `widthEmu`, `heightEmu`, and `orientation`;
- `masters`: entries with exact keys `semanticRole` and `objectKinds`;
- `layouts`: entries with exact keys `semanticRole`, `masterRole`, `objectKinds`,
  `placeholderStructure`, and `groupStructure`;
- `theme`: exact key `colorRoles`, whose entries contain exact keys `semanticRole` and `hex`;
- `fontRoles`: exact key `roles`, whose entries contain exact keys `semanticRole`, `family`,
  `sizePt`, `weight`, and `style`;
- `protectedRegions`: entries with exact keys `semanticRole`, `leftEmu`, `topEmu`,
  `widthEmu`, and `heightEmu`;
- `roles`: exactly the four base roles: `roadmap-executive`, `roadmap-capability`,
  `markitecture`, and `weekly-release`.

Each base role contains exactly `preArchiveIndex`, `masterRole`, `layoutRole`,
`requiredNativeObjectTypes`, `geometry`, `mixedStyleRunBoundaries`,
`placeholderStructure`, and `groupStructure`.

Nested entries use these exact keys:

- geometry: `semanticRole`, `kind`, `leftEmu`, `topEmu`, `widthEmu`, and `heightEmu`;
- mixed-style run boundary: `semanticRole` and `characterIndexes`;
- placeholder: `semanticRole`, `placeholderType`, and `index`;
- group: `semanticRole` and `children`.

Use integer English Metric Units (EMU) for slide size and geometry.
Use nonnegative integers for positions and indexes.
Use positive integers for widths and heights.
Use a positive finite number for `sizePt` and a positive integer for `weight`.
Use `landscape` or `portrait` for `orientation`.
Use lowercase six-digit colors such as `#55aa00`.

Sort every object-entry array by `semanticRole`.
Each `semanticRole` must be unique within its array.
Sort each string array by ascending UTF-16 code-unit order and remove duplicates.
Sort each `characterIndexes` array in ascending numeric order and remove duplicates.
Every `masterRole` must reference `masters[].semanticRole`.
Every `layoutRole` must reference `layouts[].semanticRole`.
A base role's master must equal its selected layout's `masterRole`.

The only permitted additional top-level fields are `revision`, `comments`, and
`unrelatedSlides`.
`semanticTemplateFingerprint` intentionally excludes those three fields.
The helper rejects every other extra field, including nested fields.

This complete synthetic object passes the checked-in helper:

```json
{
  "slideSize": {
    "widthEmu": 15240000,
    "heightEmu": 8572500,
    "orientation": "landscape"
  },
  "masters": [
    {
      "semanticRole": "master.primary",
      "objectKinds": ["image", "shape", "text"]
    }
  ],
  "layouts": [
    {
      "semanticRole": "layout.blank",
      "masterRole": "master.primary",
      "objectKinds": ["shape", "text"],
      "placeholderStructure": [],
      "groupStructure": []
    },
    {
      "semanticRole": "layout.matrix",
      "masterRole": "master.primary",
      "objectKinds": ["shape", "table", "text"],
      "placeholderStructure": [
        {
          "semanticRole": "placeholder.title",
          "placeholderType": "title",
          "index": 0
        }
      ],
      "groupStructure": []
    },
    {
      "semanticRole": "layout.timeline",
      "masterRole": "master.primary",
      "objectKinds": ["group", "line", "shape", "text"],
      "placeholderStructure": [
        {
          "semanticRole": "placeholder.title",
          "placeholderType": "title",
          "index": 0
        }
      ],
      "groupStructure": [
        {
          "semanticRole": "group.timeline",
          "children": ["object.anchor", "object.timeline"]
        }
      ]
    },
    {
      "semanticRole": "layout.weekly",
      "masterRole": "master.primary",
      "objectKinds": ["shape", "text"],
      "placeholderStructure": [
        {
          "semanticRole": "placeholder.title",
          "placeholderType": "title",
          "index": 0
        }
      ],
      "groupStructure": []
    }
  ],
  "theme": {
    "colorRoles": [
      { "semanticRole": "color.background", "hex": "#ffffff" },
      { "semanticRole": "color.emphasis", "hex": "#55aa00" },
      { "semanticRole": "color.foreground", "hex": "#111111" }
    ]
  },
  "fontRoles": {
    "roles": [
      {
        "semanticRole": "font.body",
        "family": "Synthetic Sans",
        "sizePt": 18,
        "weight": 400,
        "style": "normal"
      },
      {
        "semanticRole": "font.heading",
        "family": "Synthetic Sans",
        "sizePt": 28,
        "weight": 700,
        "style": "normal"
      }
    ]
  },
  "protectedRegions": [
    {
      "semanticRole": "region.footer",
      "leftEmu": 0,
      "topEmu": 8096250,
      "widthEmu": 15240000,
      "heightEmu": 476250
    },
    {
      "semanticRole": "region.logo",
      "leftEmu": 13906500,
      "topEmu": 190500,
      "widthEmu": 1143000,
      "heightEmu": 571500
    }
  ],
  "roles": {
    "roadmap-executive": {
      "preArchiveIndex": 1,
      "masterRole": "master.primary",
      "layoutRole": "layout.timeline",
      "requiredNativeObjectTypes": ["group", "line", "shape", "text"],
      "geometry": [
        {
          "semanticRole": "object.anchor",
          "kind": "shape",
          "leftEmu": 952500,
          "topEmu": 2857500,
          "widthEmu": 381000,
          "heightEmu": 381000
        },
        {
          "semanticRole": "object.timeline",
          "kind": "line",
          "leftEmu": 1143000,
          "topEmu": 3048000,
          "widthEmu": 12573000,
          "heightEmu": 9525
        }
      ],
      "mixedStyleRunBoundaries": [
        {
          "semanticRole": "text.outcome",
          "characterIndexes": [0, 12]
        }
      ],
      "placeholderStructure": [
        {
          "semanticRole": "placeholder.title",
          "placeholderType": "title",
          "index": 0
        }
      ],
      "groupStructure": [
        {
          "semanticRole": "group.timeline",
          "children": ["object.anchor", "object.timeline"]
        }
      ]
    },
    "roadmap-capability": {
      "preArchiveIndex": 2,
      "masterRole": "master.primary",
      "layoutRole": "layout.matrix",
      "requiredNativeObjectTypes": ["shape", "table", "text"],
      "geometry": [
        {
          "semanticRole": "object.matrix",
          "kind": "table",
          "leftEmu": 952500,
          "topEmu": 1714500,
          "widthEmu": 13335000,
          "heightEmu": 5715000
        },
        {
          "semanticRole": "object.matrix-milestone-1",
          "kind": "shape",
          "leftEmu": 3905250,
          "topEmu": 1809750,
          "widthEmu": 3429000,
          "heightEmu": 571500
        },
        {
          "semanticRole": "object.matrix-milestone-2",
          "kind": "shape",
          "leftEmu": 7334250,
          "topEmu": 1809750,
          "widthEmu": 3429000,
          "heightEmu": 571500
        },
        {
          "semanticRole": "object.matrix-milestone-3",
          "kind": "shape",
          "leftEmu": 10763250,
          "topEmu": 1809750,
          "widthEmu": 3429000,
          "heightEmu": 571500
        }
      ],
      "mixedStyleRunBoundaries": [],
      "placeholderStructure": [
        {
          "semanticRole": "placeholder.title",
          "placeholderType": "title",
          "index": 0
        }
      ],
      "groupStructure": []
    },
    "markitecture": {
      "preArchiveIndex": 3,
      "masterRole": "master.primary",
      "layoutRole": "layout.blank",
      "requiredNativeObjectTypes": ["connector", "shape", "text"],
      "geometry": [
        {
          "semanticRole": "object.gateway",
          "kind": "shape",
          "leftEmu": 6286500,
          "topEmu": 3048000,
          "widthEmu": 2286000,
          "heightEmu": 1143000
        }
      ],
      "mixedStyleRunBoundaries": [],
      "placeholderStructure": [],
      "groupStructure": []
    },
    "weekly-release": {
      "preArchiveIndex": 4,
      "masterRole": "master.primary",
      "layoutRole": "layout.weekly",
      "requiredNativeObjectTypes": ["shape", "text"],
      "geometry": [
        {
          "semanticRole": "object.scorecard",
          "kind": "shape",
          "leftEmu": 952500,
          "topEmu": 1905000,
          "widthEmu": 13335000,
          "heightEmu": 4762500
        }
      ],
      "mixedStyleRunBoundaries": [],
      "placeholderStructure": [
        {
          "semanticRole": "placeholder.title",
          "placeholderType": "title",
          "index": 0
        }
      ],
      "groupStructure": []
    }
  },
  "revision": "synthetic-revision-1",
  "unrelatedSlides": ["synthetic-title"],
  "comments": []
}
```

Run `scripts/derive-template-fingerprint.mts` with the exact retained input.
The helper calls the existing `semanticTemplateFingerprint` implementation.
It recursively sorts object keys, preserves validated array order, and normalizes line endings.
It serializes compact UTF-8 JSON with one final LF and returns the lowercase SHA-256.
Do not hash the complete deck bytes.

Classify drift:

- material: selected exemplar, slide size, inheritance, protected region, object role, object type, geometry, theme, or font role changed;
- non-material: only `revision`, `comments`, or `unrelatedSlides` changed.

Block publication on material drift.
Require a new inspection and explicit role-map review.

## Google Slides Adapter

Use the native Google Slides workflow.

1. Resolve the checked-in default unless the user explicitly names an alternate template.
2. Read the complete presentation without a partial fields selector.
3. Parse the design system and render all source slides.
4. Select the user-named destination folder. Otherwise, select the invoking user's My Drive.
5. Set `parent_folder` to that folder or the literal `root` for My Drive.
6. When possible, preflight the destination's folder type, non-trashed state, and ability to keep the copy `Restricted`.
7. Call Google Drive `copy_file` once with the source URL as `url` and that `parent_folder`.
8. Require the returned copy ID to differ from the source presentation ID.
9. Read the copy metadata and confirm its presentation type, expected parent, and non-trashed state.
10. Confirm `Restricted` General access and the expected My Drive or Shared Drive ownership.
11. Read the complete source again and require its projection hash and semantic fingerprint to match.
12. Require the fresh copy to match that stable inspected source state before authoring.
13. On a post-copy mismatch, stop authoring and report the exact copy ID and failed condition.
14. If rollback is authorized, move only that copy to trash and confirm its trashed state.
15. Otherwise, retain the copy and request user direction for its exact ID.
16. Keep its General access `Restricted`. Do not add sharing permissions during generation.
17. Record the copy's destination, owner, and General access.
18. Target every Slides mutation at the verified copy ID. Reject the source ID as a target.
19. Duplicate the inspected roadmap and matrix exemplars once for each roadmap page pair.
20. Edit native objects in place.
21. Duplicate the distinct inspected weekly exemplar once.
22. Create markitecture from its distinct checked-in role slide.
23. Preserve masters, layouts, groups, tables, shapes, links, notes, and footers.
24. Preserve mixed text runs and paragraph styles.
25. Remove stale exemplar content.
26. Establish managed order after all creation and duplication.
27. Read the final output structure once.
28. Run the output issue checker.
29. Export one PDF and render every delivered slide.

Never mutate the source template.
Never create Google Slides by importing PowerPoint.
Never rasterize editable narrative text.
Identify repeated roadmap slides by `instance_id=roadmap-executive.N` or
`instance_id=roadmap-capability.N` in managed notes.
Use `page=N/M` from the same notes to verify order and page count.
Do not use the base role alone as the refresh identity.
The invoking user owns a copy outside a Shared Drive.
A Shared Drive owns a copy created in that drive.
Retain it through review and the publication decision; move only its exact ID to trash after the user directs cleanup, then confirm that same ID is trashed or absent.
A later sharing change is a separate user-authorized action.

Require a native table for the capability matrix.
Render its visible title as `NemoClaw Feature Roadmap`.
Preserve the inspected table geometry, cell fills, and white dividers.
Keep all four cells in its top row blank.
Preserve the three inspected `HOME_PLATE` milestone shapes over that row and above the table in
z-order.
Render each used milestone title in its aligned shape.
Do not render a milestone label below the table.
Render body entries at the
inspected 48-point, medium-weight, black style, with one empty paragraph between multiple entries
in a cell. Append each Epic's issue number in parentheses and link only its `#NNNN` run.
For a closed Epic, prefix the bold capability label with a checkmark (`✓`) and one space.
Keep the issue number in regular text and link only its `#NNNN` run.
Keep roadmap timeline lines, stems, and anchors native.
For a closed executive Epic, render a checkmark (`✓`) and one space with the bold label and colon.
Render its context in regular gray `#5B5B5B` text with no hyperlink.
Derive both treatments from the native Epic `state` in the model.
Render no more than three milestones on one roadmap pair.
On the final partial pair, authorize `delete` for every unused executive milestone title, focus, and
outcome object and every unused capability `HOME_PLATE` shape.
Delete exactly those objects and clear every unused capability body cell.
Keep every capability top-row table cell blank.
Preserve native groups when the backend exposes them; use equivalent editable native containers when it does not.
Keep weekly metric cards, left milestone labels, Updates, and Risks / Blockers as editable shapes
and text.
For each weekly row, record `placement: "left"` and inspected `fillColor: "#76B900"` on the label
operation, with bold white text and no bullet. Record `nativeBullets: true` and the inspected native
bullet character on its Updates and Risks / Blockers operations.
Validate the label's fill and its relative left-of-both-columns relationship from inspected
artifact geometry; do not replace that relationship with hardcoded coordinates.
Create paragraph bullets through the native text API; do not type bullet glyphs into the text.
Render `None` as one native bullet when the model row has no documented risk.
Keep the latest stable release in its top card and keep all model-managed weekly row text unlinked.
Do not create release-driven body rows or additional weekly slides.

## PowerPoint Adapter

For the default, export the exact inspected Google Slides source into the owner-only runtime directory.
Use that fresh export as the runtime PowerPoint template.
The read-only export must bind to the same source presentation ID, projection hash, and semantic fingerprint.
Read the complete Google source before and after export.
Require both source hashes to match.
Record and compare the revision only when Google returns one.
Require the fresh export to match that stable inspected source state.
Set the role map's `templateSha256` to the exact exported bytes.
Set its `templateFingerprint` from the same Google source inspection.
Do not use a cached export or another checked-in or runtime default.

Use an alternate PowerPoint file only when the user explicitly names it.
The alternate must meet the approval conditions above.
Do not commit it.

Use the loader-provided:

- Node.js executable;
- Node.js packages;
- override binaries.

Set `RUNTIME_NODE`, `RUNTIME_NODE_MODULES`, and `RUNTIME_BIN_DIR` to those exact absolute paths.
Set `SKILL_DIR` to the Presentations skill directory.
Set `TMP_DIR` to the owner-only runtime directory.
Launch `build-pptx.mts` directly with `RUNTIME_NODE`.
Do not use a system Node.js executable or `tsx`.

Use the temporary plain-JavaScript `.mjs` module that the builder creates under `TMP_DIR`.
That module uses `@oai/artifact-tool`.
Do not install another presentation library.

Before authoring, run the standard read-only template inspection.
The builder then performs this sequence:

1. Require fresh artifact destinations and validate path isolation.
2. Read and validate the template, model, role map, frame map, inspection, audit, and deviation log.
3. Derive the actual source slide count from the exact PPTX bytes frozen into the authoring surface.
4. Require the inspection manifest to match that actual count and the exact template path.
5. Freeze the validated template, model, role-map, frame-map, and inspection bytes in the owner-only authoring surface.
6. Run the standard template-plan validator against the frozen frame map and inspection.
7. Record exactly one `edit` marker for one `pptx` output.
8. Run the standard starter-deck helper against the frozen template, frame map, and inspection.
9. Import `template-starter.pptx` with `PresentationFile.importPptx`.
10. Match each model slide by base role and exact roadmap `instanceId`.
11. Edit only the frame-map targets from the frozen model and role map.
12. Export through `PresentationFile.exportPptx`.
13. Export final layout evidence.
14. Compare the starter and final hierarchy, protected geometry, authorized edits, and source-object order.
15. After the strict identity-aware layout comparison passes, run the standard template-fidelity helper against the frozen frame map while the temporary `.mjs` still exists. For its overlay scan only, mirror final bounding boxes onto matching starter objects for exact `rewrite-and-reposition` targets; never normalize added or unplanned objects.
16. Recheck artifact path isolation against the original and frozen inputs.
17. Finalize supporting artifacts first and the PowerPoint file last.
18. Remove the temporary authoring directory after the fidelity check.

The builder prepends `RUNTIME_BIN_DIR` to every bundled child process `PATH`.
Do not run the marker, starter-deck helper, or fidelity helper separately.
Pass `--template-workspace` and `--template-frame-map` to every builder run.

All frozen authoring inputs use owner-only files.
Each workflow stage reads its applicable immutable bytes from the frozen authoring surface.
The inspection manifest cannot establish the slide count by itself.
The builder counts the sequential `ppt/slides/slide*.xml` parts in the exact frozen PPTX bytes and requires the manifest to agree.

Preview and publication both require fresh destinations.
The PowerPoint, readback, optional inspection, preview images, layout files, and montage must not exist before authoring.
Existing preview and layout directories may be empty.
The builder does not overwrite an artifact in either mode.

Finalization uses no-clobber hard links.
The builder links the readback, optional inspection, preview images, layout files, and montage before it links the PowerPoint file.
The PowerPoint file is the finalization marker.
If any link fails, the builder removes only same-inode artifacts that this invocation created.
It reports a cleanup failure instead of broadening the rollback target.

Preserve the master to layout to slide hierarchy.
Do not rebuild a theme-matched deck from colors and screenshots.
Do not use overlays to hide stale placeholders.
Do not use OOXML as the slide-authoring surface.
After export, the only permitted OOXML write restores the exact approved root `ppt/theme/theme*.xml` parts.
That restoration also preserves their required relationships and content-type declarations.
Do not write Notes Master, speaker-note, slide, table, text, geometry, or connector OOXML.
Create markitecture connectors with the native connector API.
Attach each connector to its actual `from` and `to` node shapes.
Set its arrowhead and dash style during native authoring.
On a final partial roadmap pair, use exact frame-map `delete` targets for unused executive objects
and unused capability top-row `HOME_PLATE` shapes.
Clear the unused capability body cells and keep every native-table top-row cell blank.
Apply every weekly `milestoneRowOperations` entry to its distinct inspected native target.
Clear label, Updates, and Risks / Blockers targets together for an unused row.
Keep weekly Updates and Risks / Blockers as native paragraph lists.
Derive each completed-Epic checkmark from the native Epic `state` in the model.
On the executive slide, keep `✓ displayTitle:` bold and use gray `#5B5B5B` for the regular
context.
On the capability slide, keep `✓ displayTitle` bold and link only the regular `#NNNN` run.

Reimport the theme-restored file, derive links and connector semantics from the final package,
rerender every managed slide instance, and rerun all structural, visual, and parity checks.
Read-only OOXML package inspection is allowed when the artifact runtime cannot expose a native property, such as an imported table-cell hyperlink.

For each frame-map rewrite, compare the starter and final effective style after removing only modeled content fields.
Preserve effective typography, the ordered run-style sequence in each paragraph, and native table styles.
Preserve the relative z-order of every retained source object.
Require every native markitecture connector to remain below every markitecture node.

## Protected Regions and Editability

Derive protected regions from the runtime template.
At minimum protect:

- the title zone;
- the inherited footer strip;
- confidentiality treatment;
- logos and master artwork;
- source-note and page-marker zones.

Do not cover, delete, or recreate protected objects.

All visible narrative text must remain native and editable.
Keep the capability matrix as a table.
Keep each capability milestone title in an editable native `HOME_PLATE` shape above that table.
Keep markitecture nodes and connectors independently editable.
Create markitecture node shapes before calling the native connector API so the connectors attach to those nodes.
Create connector labels after the connectors so labels remain visible.

Preserve the intrinsic aspect ratio of every image.
Do not replace an authentic brand asset with a generated or hand-drawn lookalike.

## Visual and Structural Validation

For both backends:

1. Confirm the four base roles and every model-derived managed slide instance.
2. Confirm title and unrelated slides remain unchanged.
3. Confirm managed ordering and idempotent refresh.
4. Confirm all expected text, links, notes, tables, and claims.
5. Confirm one aligned top-row `HOME_PLATE` shape for each used capability column.
6. Confirm no shape for an unused column, a blank table top row, white dividers, and no bottom
   milestone label.
7. Confirm every closed Epic has one completed checkmark and the required run styles.
8. Confirm every open Epic has no completed checkmark.
9. Confirm one `weekly-release` singleton titled
   `NemoClaw Weekly Executive Scorecard | <UTC reporting-window date range>`.
10. Confirm one to three explicitly selected weekly milestone rows in relative roadmap order, with
    each NVIDIA-green label at the left of its row.
11. Confirm every Epic from each explicitly selected weekly milestone appears exactly once in the
    corresponding Updates list.
12. Confirm Updates and Risks / Blockers use native bullets, with one `None` bullet when a row has
    no documented risk and no blank bullet paragraphs.
13. Confirm the number of releases does not change weekly row count, pagination, slide count, or
    order.
14. Confirm weekly notes contain matching report observation time, report hash, and
    `milestone_rows` records.
15. Confirm native editability through a disposable sentinel edit and readback.
16. Check every placeholder, including inherited empty placeholders.
17. Check font resolution and substitution.
18. Run overflow and clipping checks.
19. Render every delivered slide at full size.
20. Inspect each slide individually, then inspect the deck montage.

PowerPoint publication also requires `--reviewed-preview-pptx` and runtime validation evidence bound to the snapshot, model, semantic template fingerprint, exact template file hash, and the bytes of that reviewed preview.
It also requires `--parity-evidence`, the official repository root, and all five frozen source inputs listed in
[`runtime-inputs.md`](runtime-inputs.md#publish-powerpoint).
The repository root re-verifies the documentation evidence against immutable Git objects before rebuilding the model.
The evidence must record the resolved `previewPptxPath`, its `previewPptxSha256`, and the distinct resolved `outputPath`.
It must record no overflow, clipping, font substitution, or stale text and must affirm full-size review, native editability, and exact notes and links.
Reimport the exported file and build these inventories for each managed slide instance:

- `managedVisibleTextInventory` from model-managed slide-local objects and native table cells;
- `protectedVisibleTextInventory` from approved template-owned slide-local objects;
- `inheritedVisibleTextInventory` from inherited layout and master layers;
- `visibleTextInventory` from the complete text in all three scopes.
- `hyperlinkInventory` as `{ "text", "url" }` entries from linked native text runs and table cells.
- `connectorInventory` from native connector identity, endpoint geometry, arrowheads, and line treatment.
- `capabilityStructureInventory` from the native 5×4 table, four blank top-row cells, 49
  white solid 228600-EMU divider segments, ordered used top-row `HOME_PLATE` targets, zero unused
  top-row milestone targets, zero nonempty unused body cells, and zero bottom milestone targets.

Derive every inventory from the actual artifact.
Keep duplicate strings and normalize line endings before sorting each inventory.
Require the managed inventory to equal the exact model-derived inventory, including duplicate counts.
Require the complete inventory to equal the sorted concatenation of the three scoped inventories.
Require each protected inventory to match the exact per-role digest multiset in the reviewed runtime `protectedTextSha256` allowlist.
Require each inherited inventory to contain only `‹#›`, twice for each `roadmap-executive`
instance and once for each other managed instance.
Then require protected and inherited inventories to match across formats.
Block publication when actual slide-local text is neither model-managed nor approved template-owned text.

Derive the hyperlink inventory from the reimported artifact, not from the model.
Within one native text object, coalesce only adjacent runs with the same URL.
Normalize CRLF and CR to LF after coalescing and remove exactly one provider-implied terminal LF; preserve every other space and newline.
Sort by text and then URL, preserve duplicates, and do not coalesce across objects.
Require each format to match the independently model-derived hyperlink contract in
[`runtime-inputs.md`](runtime-inputs.md#google-slides-readback), then require the two artifact inventories to match each other.

For each markitecture connector, require exactly one native arrowhead and resolve its endpoint against the native node geometry.
Normalize a correctly directed relationship to `direction: "from-to"` only when the arrowhead points to the model's `to` node and the opposite endpoint resolves to its `from` node.
Read `lineStyle` as `solid` or `dashed` from the native connector.
Use an empty connector inventory for every other role.
Require both formats to match the model relationship and claim-ledger line style and then each other.
An absent, duplicate, arrowless, double-arrowed, reversed, or differently styled connector blocks publication.

Read `managedNotes` from the actual speaker-notes object.
Parse `sources` from the `[Sources]` records in those notes.
Stop parsing at the next bracketed notes section.
Require the actual notes and parsed source records to equal the corresponding model fields.
Do not populate these fields from the model before artifact readback.

Reject:

- clipping or off-slide content;
- unintended overlap;
- an empty inherited placeholder;
- unresolved sample text;
- missing footer or brand inheritance;
- flattened text or table content;
- a font substitution that changes fit;
- an unrecognized template object;
- a factual or notes mismatch.

Do not use pixel goldens as the primary contract.
Use semantic geometry and native-object assertions, then human full-size inspection.

A single-format output is preview-only.
Publication requires actual readbacks from both formats and a passing parity receipt.

## Publication Race Check

Every run creates a new preview copy without changing the source template.

Before target-deck publication:

1. Require explicit user approval for the exact target.
2. Bind approval to target ID, target revision, snapshot hash, model hash, and template fingerprint.
3. Read the target revision again immediately before the first write.
4. Stop when the revision differs.
5. Create a recovery copy of the exact target revision and record its ID.
6. Apply one bounded update sequence.
7. Read the final target structure and revision.
8. Report every write and partial-write result.

If a write succeeds only in part, stop without retrying or continuing.
Preserve the recovery copy and ask the user whether to restore it or retain the partial target for diagnosis.
Restoration is a new external write and requires the user's direction.

Never infer publication approval from preview approval.
Never update the source template with this workflow.
A source-template change is a separate task with its own safety and review contract.
