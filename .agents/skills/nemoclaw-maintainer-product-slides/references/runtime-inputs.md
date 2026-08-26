<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Product Slide Runtime Inputs

Use this reference to run the checked-in scripts and create runtime-only inputs.
Run all commands from the root of a trusted NemoClaw checkout.
Keep the runtime directory outside Git.

## Contents

- [Runtime paths](#runtime-paths)
- [GitHub credential boundary](#github-credential-boundary)
- [Collect the GitHub snapshot](#collect-the-github-snapshot)
- [Create the presentation map](#create-the-presentation-map)
- [Approve a net-change baseline](#approve-a-net-change-baseline)
- [Collect documentation evidence](#collect-documentation-evidence)
- [Replay a frozen snapshot offline](#replay-a-frozen-snapshot-offline)
- [Create the narrative input](#create-the-narrative-input)
- [Build and validate the model](#build-and-validate-the-model)
- [Create the Google Slides preview](#create-the-google-slides-preview)
- [Prepare the PowerPoint template workspace](#prepare-the-powerpoint-template-workspace)
- [Create the PowerPoint preview](#create-the-powerpoint-preview)
- [Compare both readbacks](#compare-both-readbacks)
- [Publish PowerPoint](#publish-powerpoint)
- [PowerPoint role map](#powerpoint-role-map)
- [Google Slides readback](#google-slides-readback)
- [Parity receipt](#parity-receipt)
- [PowerPoint validation evidence](#powerpoint-validation-evidence)
- [PowerPoint approval](#powerpoint-approval)
- [Retain and clean up runtime artifacts](#retain-and-clean-up-runtime-artifacts)

## Runtime Paths

Define these paths for one run:

```bash
SLIDE_REPO="$(pwd -P)"
SLIDE_SKILL="$SLIDE_REPO/.agents/skills/nemoclaw-maintainer-product-slides"
umask 077
SLIDE_RUN="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-product-slides.XXXXXX")"
chmod 700 "$SLIDE_RUN"
SLIDE_RUN="$(cd "$SLIDE_RUN" && pwd -P)"
TMP_DIR="$SLIDE_RUN"
TEMPLATE_WORKSPACE="$TMP_DIR/pptx-template-workspace"
DEFAULT_PPTX_TEMPLATE="$SLIDE_RUN/google-source-template.pptx"
mkdir -p "$TEMPLATE_WORKSPACE"
chmod 700 "$TEMPLATE_WORKSPACE"
```

`SLIDE_RUN` must not be inside the checkout.
The account that creates `SLIDE_RUN` owns the directory and its contents.
Keep its mode at `0700`, and create runtime files with owner-only access.
Use absolute normalized paths in every publication receipt.

## GitHub Credential Boundary

Use an existing active GitHub CLI login for `github.com`:

```bash
gh auth status --hostname github.com --active
```

Do not use `--show-token`, `--with-token`, or a command-line token value.
Do not set `GH_TOKEN` or `GITHUB_TOKEN` for this procedure; use the GitHub CLI login selected by the status command.
The skill invokes `gh` for read-only requests and never reads, prints, copies, or persists credential bytes.
Do not put a token, `GH_TOKEN`, `GITHUB_TOKEN`, or GitHub CLI configuration in `SLIDE_RUN`, a snapshot, a receipt, or command output.

The GitHub CLI owns credential storage and lifetime.
It uses the system credential store when available and otherwise stores authentication in `hosts.yml` under `GH_CONFIG_DIR`, `$XDG_CONFIG_HOME/gh`, or `$HOME/.config/gh`, in that order.
An existing login remains after this workflow; the skill neither logs in nor logs out.
If no active login exists, stop and ask the user to authenticate outside this workflow with:

```bash
gh auth login --hostname github.com --web
```

If the user created a run-specific login and later directs its removal, use the exact account login with:

```bash
gh auth logout --hostname github.com --user "<exact GitHub login>"
gh auth status --hostname github.com
```

The second command must no longer list that login.
Local logout does not revoke the GitHub OAuth grant; tell the user when server-side revocation is also required.

## Collect the GitHub Snapshot

Select each milestone in the required display order.
The collector uses authenticated, read-only GitHub access.

```bash
node --import tsx "$SLIDE_SKILL/scripts/collect-github-snapshot.mts" \
  --repo NVIDIA/NemoClaw \
  --milestone "<first exact title or configured alias>" \
  --milestone "<next exact title or configured alias>" \
  --release-count 5 \
  --metric-mode retained_additions \
  --presentation-map "$SLIDE_SKILL/references/roadmap-presentation.json" \
  --output "$SLIDE_RUN/snapshot.json"
```

Repeat `--milestone` for every explicit selection.
Explicit selection preserves the requested order, but it does not override lifecycle eligibility.
`--release-count` controls release-evidence collection only.
It never changes weekly milestone rows, pagination, slide count, or order.

Omit every `--milestone` option to select milestones automatically.
Automatic selection includes a milestone only when all these conditions are true:

- `state` is `OPEN`;
- `closedAt` is null;
- `dueOn` is valid and non-null;
- `dueOn[0:10]` is greater than or equal to `asOf[0:10]`.

A milestone due on the `asOf` date remains eligible.
Automatic results use due-date and milestone-number order.
Explicit selection uses the same eligibility checks.

The collector omits every closed milestone without a lifecycle blocker.
It omits a past-due open milestone and records `MILESTONE_PAST_DUE`.
It omits an open milestone with no valid due date and records
`MILESTONE_DUE_DATE_MISSING`.
For each omitted past-due or invalid-due open milestone, the collector records a lifecycle finding
with its native number, title, and remaining open Epic numbers.
It omits closed milestones without a lifecycle finding.
Closed milestones have no retention interval.

The collector also creates the complete paginated `repository-open-issues` GraphQL receipt for
repository scope `{ "owner": "NVIDIA", "name": "NemoClaw" }` and `issues(states: OPEN)`.
Each retained issue contains `id`, `number`, `title`, `body`, `state`, `url`, `createdAt`, `closedAt`,
`issueType { id, name }`, and `milestone { id, number }`.
The collector uses this receipt to list the remaining open Epics in open-milestone lifecycle
findings.
It retains each open native Epic with no milestone as a presentation-grouping candidate.
Model construction includes that Epic only when its owner-reviewed runtime entry has
`presentationMilestoneNodeId` that equals the node ID of one selected eligible milestone.
Otherwise it records `EPIC_MILESTONE_MISSING` and omits the Epic from both roadmap roles.
An unknown or ineligible target also blocks publication and omits the Epic.

Preview remains available with these lifecycle blockers.
Publication stops until the maintainer completes the applicable remediation:

- `MILESTONE_PAST_DUE`: close the milestone or move every remaining Epic to another eligible
  milestone;
- `MILESTONE_DUE_DATE_MISSING`: set a valid due date on or after `asOf`;
- `EPIC_MILESTONE_MISSING`: assign the Epic to an eligible native milestone or add an
  owner-reviewed `presentationMilestoneNodeId` that equals the node ID of one selected eligible
  milestone.

Every eligible milestone contributes every open and closed native GitHub Epic assigned to it.
It also receives each reviewed open unmilestoned Epic whose `presentationMilestoneNodeId` targets
that milestone.
This runtime grouping does not claim or change a GitHub milestone.
The model chunks eligible milestones into ordered groups of three.
The collector reads only milestone aliases from the checked-in file passed with
`--presentation-map`.
It retains each candidate's complete body, native subissue, `## Work Tracking`, and progress
evidence so the owner can select a presentation grouping after collection.
Checked-in Epic entries are optional seeds only.
Never pass them directly to model construction.
After collection, the owner creates and reviews an owner-only runtime `presentation-map.json`.
The model builder validates `epicNodeId`, `issueNumber`, and `boundBodySha256`.
It uses `displayTitle` and `shortenedOutcome` for visible wording, `roadmapArea` for classification,
`displayOrder` for order, and optional `presentationMilestoneNodeId` for grouping.

For `net_change`, also pass both approved baseline files:

```bash
  --metric-mode net_change \
  --baseline-snapshot "/absolute/path/to/baseline-snapshot.json" \
  --baseline-approval "/absolute/path/to/baseline-approval.json"
```

Do not edit `snapshot.json`.
Recollect it when a source changes.

## Create the Presentation Map

After snapshot collection, create `presentation-map.json` under `SLIDE_RUN`.
This file is owner-only runtime input and must not enter Git.
Give it mode `0600`.

```json
{
  "schemaVersion": 1,
  "roadmapAreas": [
    "Usability and Onboarding",
    "Agent Features",
    "Acceleration and Optimization",
    "Integrations and Blueprints"
  ],
  "epics": [
    {
      "epicNodeId": "E_SYNTHETIC_101",
      "issueNumber": 101,
      "displayTitle": "Guided Onboarding",
      "shortenedOutcome": "Start agents in OpenShell sandboxes with fewer manual steps.",
      "boundBodySha256": "1111111111111111111111111111111111111111111111111111111111111111",
      "roadmapArea": "Usability and Onboarding",
      "displayOrder": 1
    },
    {
      "epicNodeId": "E_SYNTHETIC_102",
      "issueNumber": 102,
      "displayTitle": "Kubernetes In-Cluster",
      "shortenedOutcome": "Run agents inside OpenShell sandboxes in Kubernetes.",
      "boundBodySha256": "2222222222222222222222222222222222222222222222222222222222222222",
      "roadmapArea": "Usability and Onboarding",
      "presentationMilestoneNodeId": "MI_SYNTHETIC_Q3",
      "displayOrder": 2
    }
  ]
}
```

The example is synthetic and does not describe a current roadmap commitment.
Replace it with exactly one entry for every milestone-assigned included Epic and every
owner-selected open unmilestoned Epic, with no other Epic.
You may copy included Epic entries from the checked-in `roadmap-presentation.json` as a starting
point.
Never pass that checked-in seed directly to model construction or publication.
Prune every unselected row and review every retained summary, classification, and order value.
Copy `epicNodeId`, `issueNumber`, and `boundBodySha256` from the frozen snapshot.
The body hash binds both presentation summaries to the reviewed Epic body.
Use `presentationMilestoneNodeId` only when the snapshot records an open native Epic with a null
milestone.
Set it to the exact node ID of one selected eligible milestone after owner review.
It controls presentation grouping only and must not populate, claim, or change native milestone
evidence.
An absent, unknown, or ineligible target blocks publication and omits that unmilestoned Epic.

Use two to four words for `displayTitle`.
Use three to ten words for `shortenedOutcome`.
For an open Epic, the complete row is `displayTitle: shortenedOutcome`.
For a closed Epic, the complete row is `✓ displayTitle: shortenedOutcome`.
The applicable complete row must not exceed 90 characters.
Do not derive, truncate, or copy source prose when a reviewed summary is absent.
Recollect the snapshot before reviewing new wording when an Epic body hash changes.

Use the same `displayTitle` on the executive and capability slides.
Add `roadmapArea` only after classification review.
When it is absent, the preview shows that same short label in the unclassified warning.
Publication remains blocked until every included Epic has one approved roadmap area.
Use `displayOrder` to record the reviewed Epic order.

```bash
chmod 600 "$SLIDE_RUN/presentation-map.json"
```

## Approve a Net-Change Baseline

Use `net_change` only when a NemoClaw maintainer with authority for the metric baseline approves the exact completed baseline snapshot.
The approval is a runtime evidence record, not product approval or general publication approval.
The collector verifies that the baseline is complete, belongs to `NVIDIA/NemoClaw`, has valid source receipts, and has `asOf` exactly equal to the current window start.

The approval JSON must contain exactly these eight fields and no others:

```json
{
  "schemaVersion": 1,
  "kind": "nemoclaw-product-slides-baseline-approval",
  "repository": "NVIDIA/NemoClaw",
  "approved": true,
  "approvedBy": "synthetic-maintainer-login",
  "approvedAt": "2026-08-13T12:00:01.000Z",
  "snapshotSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "approvalSha256": "2434b17194fa97834d4434840345339563e2fb5328382eeb41f2ad865a45f685"
}
```

The synthetic hash is valid for the other seven synthetic values shown.
For a real approval:

- `approvedBy` is the exact GitHub login or other unambiguous identity of the approving NemoClaw maintainer;
- `approvedAt` is an ISO-8601 timestamp recorded at or after `baseline.collection.completedAt`;
- `snapshotSha256` equals the verified canonical hash inside the exact baseline snapshot;
- `approvalSha256` is the canonical SHA-256 of the approval object after removing only `approvalSha256`.

Calculate the hash with the same implementation used by the collector:

```bash
BASELINE_APPROVAL_HASH="$(
  node --import tsx --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { canonicalSha256, withoutTopLevelKey } from "./.agents/skills/nemoclaw-maintainer-product-slides/scripts/validate-slide-model.mts";
    const approval = JSON.parse(readFileSync(process.argv[1], "utf8"));
    console.log(canonicalSha256(withoutTopLevelKey(approval, "approvalSha256")));
  ' "$SLIDE_RUN/baseline-approval.json"
)"
printf '%s\n' "$BASELINE_APPROVAL_HASH"
```

Canonical JSON recursively sorts object keys, preserves array order, normalizes line endings inside strings, uses compact UTF-8 JSON, and ends with one LF.
Insert the printed lowercase hash as `approvalSha256`, then pass that exact file with `--baseline-approval`.
The collector checks that the approval was recorded after baseline collection; it cannot authenticate the authority represented by `approvedBy`, so the person running the workflow must confirm that authority.

## Collect Documentation Evidence

Bind documentation evidence to the commit recorded in `snapshot.json`:

```bash
FROZEN_COMMIT="$(jq -er '.repository.commitSha' "$SLIDE_RUN/snapshot.json")"

node --import tsx "$SLIDE_SKILL/scripts/collect-doc-evidence.mts" \
  --repo-root "$SLIDE_REPO" \
  --commit "$FROZEN_COMMIT" \
  --claims "$SLIDE_SKILL/references/markitecture-claims.json" \
  --output "$SLIDE_RUN/docs-evidence.json"
```

The trusted repository must contain the recorded commit as an immutable Git object reachable from its fetched `origin/main` reference.
The collector reads each source as `commitSha:path`; it does not read the working-tree copy.
Do not omit `--commit` or substitute documentation from another commit.

## Replay a Frozen Snapshot Offline

An offline replay starts only from a complete `snapshot.json` that the user names explicitly.
It does not run the GitHub collector, consult a cache, or claim current GitHub state.
Before disconnecting, retain the exact snapshot, owner-only runtime presentation map, separately
hashed narrative input, claim ledger, semantic template input, and prior required readbacks or
receipts. Freeze `narrative-input.json` alongside `snapshot.json`; do not represent the weekly
report as a field inside the GitHub snapshot.

The trusted local repository must already have the official `NVIDIA/NemoClaw` origin, the snapshot commit object, and a fetched `refs/remotes/origin/main` that contains that commit.
Verify those local prerequisites without network access:

```bash
OFFLINE_SNAPSHOT="/absolute/path/to/the-explicit-snapshot.json"
FROZEN_COMMIT="$(jq -er '.repository.commitSha' "$OFFLINE_SNAPSHOT")"

git -C "$SLIDE_REPO" remote get-url origin
git -C "$SLIDE_REPO" cat-file -e "${FROZEN_COMMIT}^{commit}"
git -C "$SLIDE_REPO" merge-base --is-ancestor \
  "$FROZEN_COMMIT" refs/remotes/origin/main
cp "$OFFLINE_SNAPSHOT" "$SLIDE_RUN/snapshot.json"
```

Collect documentation evidence from those immutable local Git objects with the explicit `--commit` command above, then use the normal model command with `--snapshot "$SLIDE_RUN/snapshot.json"` and the retained exact runtime inputs.
Model construction revalidates the snapshot hash and documentation envelope.
Stop when the snapshot is incomplete, the commit or `origin/main` evidence is unavailable, or an exact runtime input is missing.
An offline model replay remains preview-only unless the exact two-format artifacts, actual-object readbacks, parity receipt, validation evidence, and approval required for publication are also available and still pass every publication check.

## Create the Narrative Input

Create `narrative-input.json` outside Git.
Bind the reviewed weekly milestone report to its observation time and canonical digest.

```json
{
  "schemaVersion": 1,
  "observedAt": "2026-08-24T20:00:00Z",
  "reportSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "milestoneRows": [
    {
      "milestoneNodeId": "MI_synthetic_q3",
      "updates": [
        {
          "epicNodeId": "I_synthetic_pi_agent",
          "epicBodySha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "label": "Pi Agent",
          "text": "Shared onboarding foundations merged"
        }
      ],
      "risks": [
        {
          "label": "Pi",
          "text": "Station qualification remains open"
        }
      ]
    }
  ]
}
```

Required fields are:

- top-level `schemaVersion`, with value `1`;
- top-level `observedAt`, with the report's ISO-8601 observation timestamp;
- top-level `reportSha256`, calculated from canonical JSON after removing only `reportSha256`;
- top-level `milestoneRows`, the explicit weekly selection of one to three eligible roadmap
  milestones in relative roadmap order; other paginated roadmap milestones need not appear;
- row `milestoneNodeId`, which must resolve to the corresponding selected roadmap row;
- row `updates`, with exactly one entry for every roadmap Epic in that row;
- update `epicNodeId` and `epicBodySha256`, which must match the frozen snapshot; model validation
  resolves and verifies the issue number from that Epic identity and source evidence rather than a
  duplicated update field;
- update `label` and `text`, which must be concise, evidence-bound display copy;
- row `risks`, with only documented risk or blocker entries, each containing `label` and `text`.

For an update whose Epic has a null native milestone, require its reviewed
`presentationMilestoneNodeId` to equal the row's `milestoneNodeId`.
Preserve the null native milestone in the built model and source evidence.

Model construction derives each slide row's stable `contentId`, visible `title`, and source `url`
from the selected roadmap evidence.
It adds `sourceId` and `sourceDigest` to every update and risk, bound to the exact milestone report.
Do not author those derived model fields in the narrative input.

Use an empty `risks` array when the complete report records no risk or blocker.
The adapters render that state as one native bullet containing `None`.
Do not infer a risk from a title, due date, missing update, previous slide, or memory.
More than three milestone rows block publication.
Release data stays in the frozen snapshot for the latest-release top card; it does not create
narrative rows.

## Build and Validate the Model

Create `template-fingerprint-input.json` outside Git from the complete Google source inspection.
The Google source projection owns the semantic fingerprint for both output backends.
The exported PowerPoint inspection and frame map are separate native bindings.
Use the complete valid object and exact nested contract in
[`template-contract.md`](template-contract.md#template-fingerprint).

The seven required top-level fields are `slideSize`, `masters`, `layouts`, `theme`,
`fontRoles`, `protectedRegions`, and `roles`.
The `roles` object must contain exactly the four base roles: `roadmap-executive`,
`roadmap-capability`, `markitecture`, and `weekly-release`.
Each base role must contain exactly `preArchiveIndex`, `masterRole`, `layoutRole`,
`requiredNativeObjectTypes`, `geometry`, `mixedStyleRunBoundaries`,
`placeholderStructure`, and `groupStructure`.

Use these exact nested entry fields:

- master: `semanticRole`, `objectKinds`;
- layout: `semanticRole`, `masterRole`, `objectKinds`, `placeholderStructure`,
  `groupStructure`;
- color role: `semanticRole`, `hex`;
- font role: `semanticRole`, `family`, `sizePt`, `weight`, `style`;
- protected region: `semanticRole`, `leftEmu`, `topEmu`, `widthEmu`, `heightEmu`;
- geometry: `semanticRole`, `kind`, `leftEmu`, `topEmu`, `widthEmu`, `heightEmu`;
- mixed-style run boundary: `semanticRole`, `characterIndexes`;
- placeholder: `semanticRole`, `placeholderType`, `index`;
- group: `semanticRole`, `children`.

Sort object-entry arrays by `semanticRole` and string arrays by ascending UTF-16 code-unit order.
Sort `characterIndexes` in ascending numeric order.
Remove duplicates from every sorted array.
Every master and layout reference must resolve.
A base role's master must equal its selected layout's `masterRole`.

The only permitted additional top-level fields are `revision`, `comments`, and
`unrelatedSlides`.
The derivation intentionally excludes those three fields.
The helper rejects every other top-level or nested field.

Derive the fingerprint with the checked-in TypeScript helper:

```bash
TEMPLATE_FINGERPRINT="$(
  node --import tsx "$SLIDE_SKILL/scripts/derive-template-fingerprint.mts" \
    --input "$SLIDE_RUN/template-fingerprint-input.json"
)"
printf '%s\n' "$TEMPLATE_FINGERPRINT"
```

The helper calls the same `semanticTemplateFingerprint` function used by model validation.
It canonicalizes the seven semantic fields by recursively sorting object keys, preserving array order, normalizing line endings, encoding compact UTF-8 JSON, and adding one final LF before SHA-256.
The result is not the PowerPoint file hash.
Set this exact value in the model and both runtime role maps.

Build the model:

```bash

node --import tsx "$SLIDE_SKILL/scripts/build-slide-model.mts" \
  --repo-root "$SLIDE_REPO" \
  --snapshot "$SLIDE_RUN/snapshot.json" \
  --docs "$SLIDE_RUN/docs-evidence.json" \
  --presentation-map "$SLIDE_RUN/presentation-map.json" \
  --claims "$SLIDE_SKILL/references/markitecture-claims.json" \
  --narrative-input "$SLIDE_RUN/narrative-input.json" \
  --template-fingerprint "$TEMPLATE_FINGERPRINT" \
  --output "$SLIDE_RUN/slide-model.json"
```

Validate preview behavior first:

```bash
node --import tsx "$SLIDE_SKILL/scripts/validate-slide-model.mts" \
  --model "$SLIDE_RUN/slide-model.json" \
  --schema "$SLIDE_SKILL/references/slide-model.schema.json" \
  --mode preview \
  --output "$SLIDE_RUN/model-validation-preview.json"
```

Before publication, run the same command with `--mode publish` and a different output path.
A nonzero exit status blocks publication.

The model orders slides as alternating roadmap page pairs, followed by `markitecture` and
`weekly-release`:

```text
roadmap-executive.1
roadmap-capability.1
roadmap-executive.2
roadmap-capability.2
...
markitecture
weekly-release
```

`weekly-release` remains exactly one singleton slide.
Its narrative input explicitly selects one to three eligible roadmap milestones and preserves
their relative roadmap order, regardless of the number of roadmap pages or collected or in-window
releases.

Each roadmap slide has a stable `instanceId`, 1-based `pageIndex`, and total `pageCount`.
Each pair contains one to three milestones.
Every non-final pair contains exactly three milestones.
On the final partial pair, add exact frame-map `delete` targets for each unused executive milestone
title, focus, and outcome object.
Add one for each unused capability top-row `HOME_PLATE` shape.
The renderer deletes only those objects, clears the unused capability body cells, and keeps every
native-table top-row cell blank.

Every modeled roadmap milestone has normalized status
`{ "state": "open", "label": "Active" }` and its exact valid `dueOn`.
The selected snapshot evidence retains the native `OPEN` state and null `closedAt`.
The executive focus uses `NemoClaw:` above the focus text.
Closed, past-due open, and undated open milestones remain outside the modeled roadmap slides.
The capability slide shows the milestone title only in its top-row `HOME_PLATE` shape.

Each executive outcome, capability item, and unclassified item carries the Epic's native `state` as
`OPEN` or `CLOSED` and its exact `closedAt` value.
An open executive row is `displayTitle: shortenedOutcome`.
A closed executive row is `✓ displayTitle: shortenedOutcome`.
The checkmark, label, and colon are bold, and the closed context is regular gray `#5B5B5B`.
An open capability item is `displayTitle (#NNNN)`.
A closed capability item is `✓ displayTitle (#NNNN)`.
The checkmark and label are bold, and only the `#NNNN` span is linked.

Roadmap managed notes add these records after the base role marker:

```text
instance_id=roadmap-executive.1
page=1/2
```

The capability page uses its own `roadmap-capability.N` instance ID.
Each capability cell may contain no more than three compact open or completed entries.
Four entries in one cell block layout and publication.
Do not move or omit an Epic to satisfy this limit.

## Create the Google Slides Preview

Use the native Google Slides workflow in `SKILL.md`.
Unless the user explicitly names an alternate template, use the source defined in
[`google-template.json`](google-template.json).
The default title is `[Public] NemoClaw Product Slides Template`.
The canonical URL is
[the approved public Google Slides source](https://docs.google.com/presentation/d/1wnVoqkjV_KTGwLkm6fFGnIGJ1-1YKfpOAg4HIqrXvBk/edit).

Treat the [public template example contract](slide-contract.md#public-template-examples) as a
maintainer requirement for the next template revision.
Do not treat exemplar wording as evidence or copy it into the frozen model.
Generated copies must replace every exemplar entry from the model before readback.

Read the complete source presentation.
Hash its complete inspected projection and semantic fingerprint.
Include every source slide in order and every inspected native object, style, link, and note.
Exclude only file ownership, permissions, file ID, and an absent or provider-generated revision value.
Confirm that the default presentation ID and title match the checked-in record.
Confirm that source access meets the record's `requiredAccess` value.
Confirm every capability in the record's `requiredCapabilities` array.
Stop before copying or exporting when any required capability is unavailable.
Bind an explicitly named alternate to its complete inspected state for this run only.

Create one new preview copy for every run.
Do not reuse an earlier output.
Never edit the default or alternate source template.
Set `parent_folder` to the user-named folder URL or ID.
If the user names no folder, set `parent_folder` to the literal `root` for My Drive.
For a user-named folder, preflight its folder MIME type and non-trashed state.
When permission metadata is available, reject a destination that cannot keep the copy `Restricted`.
Stop before `copy_file` when a destination preflight fails.
Call Google Drive `copy_file` once with the source URL as `url` and that `parent_folder`.
Require the returned copy ID to differ from the source presentation ID.
Read the copy metadata.
Require the Google Slides MIME type, expected parent, non-trashed state, and `Restricted` General access.
For My Drive, require the invoking user to own the copy.
For a Shared Drive destination, require that Shared Drive to own the copy.
Read the complete source again after copying.
Require its projection hash and semantic fingerprint to match the first source read.
Record and compare the source revision only when Google returns one.
Require the fresh copy to match that stable inspected source state before authoring.
On any post-copy mismatch, stop authoring and report the exact copy ID and failed condition.
If rollback is authorized, move only that copy to trash and confirm its trashed state.
Otherwise, retain the copy and ask the user to direct cleanup of that exact ID.
Keep General access `Restricted`.
Do not add or change sharing permissions during generation.
A later sharing change is a separate user-authorized action.
The invoking user owns the copy unless its destination is a Shared Drive.
A Shared Drive owns a copy created there.
Target every Google Slides mutation at the verified copy ID.
Reject any mutation target that equals the source presentation ID.

Render from `slide-model.json`.
Then create `google-readback.json` from the actual preview objects.
Use the [Google Slides readback](#google-slides-readback) contract.

If Google Slides is the only requested format, stop after preview validation.
Do not publish a one-format result.

## Prepare the PowerPoint Template Workspace

Call the workspace dependency loader before running a PowerPoint helper or builder.
Copy its three returned absolute paths exactly:

```bash
RUNTIME_NODE="<absolute loader-provided Node.js executable>"
RUNTIME_NODE_MODULES="<absolute loader-provided Node.js packages directory>"
RUNTIME_BIN_DIR="<absolute loader-provided override binaries directory>"
SKILL_DIR="<absolute presentations skill directory>"
```

Do not derive one runtime path from another.
Do not substitute a system, global, or repository-local Node.js executable or package tree.
`SKILL_DIR` identifies the Presentations skill.
`SLIDE_SKILL` identifies this repo-local NemoClaw skill.
Keep `TMP_DIR` equal to the owner-only `SLIDE_RUN` path.

Select exactly one runtime PowerPoint template path.
For the default, assign the fresh export path:

```bash
PPTX_TEMPLATE="$DEFAULT_PPTX_TEMPLATE"
```

For an explicitly named alternate, assign its exact absolute path:

```bash
PPTX_TEMPLATE="/absolute/path/to/user-named-alternate.pptx"
```

For the default, use the presentation in
[`google-template.json`](google-template.json).
Use the native Google Drive export to create `$PPTX_TEMPLATE` under `SLIDE_RUN`.
The export reads the source and must not change it.

Before export, record the source presentation ID, complete projection hash, and semantic fingerprint.
Require the export destination to be absent.
After export, set the file mode to `0600` and read the complete Google source again.
Require its projection hash and semantic fingerprint to match the first source read.
Record and compare the source revision only when Google returns one.
Require the fresh PowerPoint inspection to match that stable inspected source state.
Do not use the export after any source-state mismatch.

Record these bindings in `template-audit.txt`:

- source presentation ID;
- source projection hashes before and after export;
- source semantic fingerprints before and after export;
- source revision before and after export, when returned;
- selected PowerPoint absolute path and SHA-256;
- semantic template fingerprint from that source inspection.

Set the role map's `templateSha256` from those exact selected bytes.
Set its `templateFingerprint` from the same source inspection.
Do not use a prior export, cached file, or separate default PowerPoint template.
Use the alternate assignment only when the user explicitly names that file for this run.

Inspect the exact approved source template before any authoring operation:

```bash
RUNTIME_NODE="$RUNTIME_NODE" \
RUNTIME_NODE_MODULES="$RUNTIME_NODE_MODULES" \
RUNTIME_BIN_DIR="$RUNTIME_BIN_DIR" \
SKILL_DIR="$SKILL_DIR" \
TMP_DIR="$TMP_DIR" \
"$RUNTIME_NODE" "$SKILL_DIR/template_following_scripts/inspect_template_deck.mjs" \
  --workspace "$TEMPLATE_WORKSPACE" \
  --pptx "$PPTX_TEMPLATE"
```

Review every source-slide render, layout file, extracted object, font record, and manifest entry.
Reject an inspection that omits a source slide or reports a positive truncated-record count.
Create these three files directly under `TEMPLATE_WORKSPACE` after the review:

- `template-audit.txt`;
- `deviation-log.txt`;
- `template-frame-map.json`.

The audit must record the source hierarchy, reusable roles, protected regions, placeholders, typography, and insertion contract.
The deviation log must record every intentional difference from a duplicated source slide.
Use an empty deviation log only when the output has no intentional differences.

Derive the complete source slide count from the live Google read and exact exported PowerPoint bytes.
Require both counts and the inspected role order to match.
Let `P` be the roadmap page count and `S` the complete source slide count.
The output has `S + (2 × (P - 1))` slides.
One to three eligible milestones produce one page pair and an output with `S` slides.
Each additional page duplicates the resolved executive and capability role slides before markitecture.
Resolve markitecture and weekly release from their distinct checked-in slide object IDs.

The following one-page example shows the structural frame-map shape.
Replace every synthetic element ID, name, zone, and content ID with inspected and modeled values:

```json
{
  "outputSlides": [
    {
      "outputSlide": 1,
      "sourceSlide": 1,
      "narrativeRole": "preserve title",
      "reuseMode": "duplicate-slide",
      "editTargets": []
    },
    {
      "outputSlide": 2,
      "sourceSlide": 2,
      "narrativeRole": "roadmap-executive",
      "instanceId": "roadmap-executive.1",
      "reuseMode": "duplicate-slide",
      "editTargets": [
        {
          "action": "rewrite",
          "sourceElementId": "synthetic-executive-title-id",
          "sourceElementName": "synthetic-executive-title"
        }
      ]
    },
    {
      "outputSlide": 3,
      "sourceSlide": 3,
      "narrativeRole": "roadmap-capability",
      "instanceId": "roadmap-capability.1",
      "reuseMode": "duplicate-slide",
      "editTargets": [
        {
          "action": "rewrite",
          "sourceElementId": "synthetic-native-capability-table-id",
          "sourceElementName": "synthetic-native-capability-table"
        },
        {
          "action": "add",
          "contentId": "matrix-needs-classification",
          "newPrimitiveAllowed": true,
          "mustNotOverlapInherited": true,
          "reason": "Preview-only warning below the native table when unclassified Epics exist",
          "zone": { "left": 100, "top": 600, "width": 400, "height": 80 }
        }
      ]
    },
    {
      "outputSlide": 4,
      "sourceSlide": 4,
      "narrativeRole": "markitecture",
      "reuseMode": "duplicate-slide",
      "editTargets": [
        {
          "action": "rewrite",
          "sourceElementId": "synthetic-markitecture-title-id",
          "sourceElementName": "synthetic-markitecture-title"
        },
        {
          "action": "add",
          "contentIds": [
            "node.synthetic",
            "connector.synthetic",
            "connector.synthetic:label"
          ],
          "newPrimitiveAllowed": true,
          "mustNotOverlapInherited": true,
          "reason": "Native modeled markitecture objects in the inspected body zone",
          "zone": { "left": 80, "top": 120, "width": 1000, "height": 500 }
        }
      ]
    },
    {
      "outputSlide": 5,
      "sourceSlide": 5,
      "narrativeRole": "weekly-release",
      "reuseMode": "duplicate-slide",
      "editTargets": [
        {
          "action": "rewrite",
          "sourceElementId": "synthetic-weekly-title-id",
          "sourceElementName": "synthetic-weekly-title"
        },
        {
          "action": "rewrite-and-reposition",
          "sourceElementId": "synthetic-weekly-card-id",
          "sourceElementName": "synthetic-weekly-card"
        }
      ]
    }
  ],
  "omittedSourceSlides": []
}
```

This example shows the slide mapping and edit-target forms, not the complete runtime target inventory.
Add one preserve entry for every unlisted source slide from the complete live projection.
Map every rewritten or deleted source object by its exact inspected ID and name.
Authorize exactly the modeled markitecture node, connector, and connector-label content IDs.
Keep `matrix-needs-classification` below the native table.
Use that add target only for a preview with nonempty unclassified items.
Publication still requires an empty unclassified list.

For each additional roadmap page, insert one executive and capability entry before markitecture.
Use the same inspected source slides and base `narrativeRole` values.
Set each entry's exact `instanceId`, such as `roadmap-executive.2` and
`roadmap-capability.2`.
Shift markitecture, weekly release, and every later preserved output by two positions.
Do not change their relative order or source-slide mapping.

Every runtime `geometryOperations` target requires one matching frame-map `rewrite-and-reposition` target.
If the same object also changes content, authorize its `rewrite` separately.
Record each approved geometry difference in `deviation-log.txt`.

Do not run the operation marker or starter-deck helper manually.
The builder owns those authoring steps.

## Create the PowerPoint Preview

For the default, the approved PowerPoint source is the fresh `PPTX_TEMPLATE` export for this run.
For an alternate, it is the exact PowerPoint file that the user explicitly named.
Its bytes must hash to the role map's `templateSha256`.
The model's `templateFingerprint` must derive from the matching stable Google source inspection.
The exported PowerPoint inspection must match that source state and every selected role.
Every selected source role must have inspected `preArchive: true` evidence.
The role map's `templateFrameMapSha256` must hash the exact frame-map bytes.

Preview uses fresh, no-clobber artifact destinations.
Before the command, these deterministic destinations must be absent:

- the `--output`, `--readback`, and optional `--inspect-output` files;
- every model-derived managed slide image and `managed-montage.webp` under `--preview-dir`;
- every model-derived managed slide layout JSON file under `--layout-dir`.

For one roadmap page, the managed stems remain `01-roadmap-executive`,
`02-roadmap-capability`, `03-markitecture`, and `04-weekly-release`.
For multiple pages, roadmap stems include the instance suffix, such as
`01-roadmap-executive-1` and `03-roadmap-executive-2`.
Markitecture and weekly-release prefixes follow their actual model positions.

Existing empty preview and layout directories are allowed.
The builder never overwrites one of these files in preview or publication mode.

```bash
RUNTIME_NODE="$RUNTIME_NODE" \
RUNTIME_NODE_MODULES="$RUNTIME_NODE_MODULES" \
RUNTIME_BIN_DIR="$RUNTIME_BIN_DIR" \
SKILL_DIR="$SKILL_DIR" \
TMP_DIR="$TMP_DIR" \
"$RUNTIME_NODE" "$SLIDE_SKILL/scripts/build-pptx.mts" \
  --model "$SLIDE_RUN/slide-model.json" \
  --template-pptx "$PPTX_TEMPLATE" \
  --template-workspace "$TEMPLATE_WORKSPACE" \
  --template-frame-map "$TEMPLATE_WORKSPACE/template-frame-map.json" \
  --role-map "$SLIDE_RUN/pptx-role-map.json" \
  --output "$SLIDE_RUN/product-slides-preview.pptx" \
  --preview-dir "$SLIDE_RUN/pptx-preview-images" \
  --layout-dir "$SLIDE_RUN/pptx-layout-readback" \
  --readback "$SLIDE_RUN/pptx-readback.json" \
  --inspect-output "$SLIDE_RUN/pptx-inspection.ndjson" \
  --mode preview
```

The script checks the output, readback, optional inspection, preview directory, layout directory, and every generated child against every other output and input path, including case aliases, filesystem aliases, and hard links.
Every deterministic layout, preview-image, and montage path is subject to the same check.
The script reads the source template and writes a separate output file.
It never writes the source template.
It suppresses the artifact runtime's implicit inspection sidecar.
`--inspect-output` is the only way to retain an inspection file.

Before authoring, the builder validates the complete inspection, audit, deviation log, frame map, model, template, and role-map binding.
It counts the sequential slide parts in the exact PPTX bytes frozen into the authoring surface.
The inspection manifest and every inspected slide record must match that actual count.

The builder copies the exact template, model, role-map, frame-map, and inspection bytes into owner-only files in the authoring surface.
The plan, starter, authoring, and fidelity stages use their applicable frozen files.
The builder runs the standard plan validator against the frozen frame map and inspection without writing a report.
It then records exactly one `edit` marker for one `pptx` output and runs the standard starter-deck helper.
It prepends `RUNTIME_BIN_DIR` to each bundled child process `PATH`.
It copies the checked-in plain-JavaScript authoring source to a temporary `.mjs` under `TMP_DIR` and runs that file with `RUNTIME_NODE`.
The authoring module imports the generated starter deck, edits only authorized targets, and exports one PowerPoint file.
After export, the builder writes final layout evidence and runs both its strict layout comparison and the standard template-fidelity check.
The strict comparison binds each retained object identity and exact authorized geometry before the standard check runs. For the standard helper's overlay scan only, the builder copies the final bounding box into the matching starter-layout object for exact `rewrite-and-reposition` targets. Added and unplanned objects are not normalized, so the standard overlay check still rejects them.
It retains the temporary `.mjs` through the fidelity check and removes that temporary authoring directory afterward.

Rewrite fidelity preserves effective typography, ordered run styles within each paragraph, native table styles, and retained source-object relative order.
The markitecture fidelity check also requires every native connector to remain below every native node.

Immediately before artifact finalization, the builder rechecks path isolation against every original and frozen input.
It creates no-clobber hard links for the readback, optional inspection, preview images, layout files, and montage first.
It links the PowerPoint file last as the finalization marker.
If a link fails, the builder removes only same-inode artifacts created by that invocation.
It reports any rollback cleanup failure.

The only permitted OOXML write restores the exact approved root `ppt/theme/theme*.xml` parts and required package declarations.
The builder does not write Notes Master, speaker-note, slide, table, text, geometry, or connector OOXML.
The native authoring module attaches each markitecture connector to its actual node shapes and sets its arrowhead and dash style.

If PowerPoint is the only requested format, stop after preview validation.
Do not publish a one-format result.

## Compare Both Readbacks

Run parity only after both previews have actual-object readbacks:

```bash
node --import tsx "$SLIDE_SKILL/scripts/compare-output-parity.mts" \
  --model "$SLIDE_RUN/slide-model.json" \
  --google-readback "$SLIDE_RUN/google-readback.json" \
  --pptx-readback "$SLIDE_RUN/pptx-readback.json" \
  --role-map "$SLIDE_RUN/pptx-role-map.json" \
  --output "$SLIDE_RUN/parity-comparison.json"
```

The command exits with a nonzero status for any mismatch.
`parity-comparison.json` is not yet a publication receipt.
Add the exact artifact and readback bindings from the [parity receipt](#parity-receipt) contract.

## Publish PowerPoint

Publish only after all of these conditions are true:

- the user approved the exact output path and evidence hashes;
- both previews have actual-object readbacks;
- the parity receipt reports equality and has no errors;
- the validation evidence records the completed review;
- the five frozen source inputs still rebuild the exact model;
- the approved template, frame-map, and role-map bytes are unchanged.

Use a new output path.
Do not use the source-template path or reviewed-preview path.
Publication uses the same fresh-destination contract as preview.
Its output, readback, optional inspection, all managed preview images, all managed layout files,
and montage must be absent.
Use a new empty template workspace because the preview builder retains its starter and layout evidence.
Repeat the standard read-only inspection in that workspace.
Then copy the exact reviewed audit, deviation log, and frame-map bytes into it.
Confirm the copied frame map still hashes to the role map's `templateFrameMapSha256`.

```bash
PUBLISH_TEMPLATE_WORKSPACE="$TMP_DIR/pptx-template-workspace-publish"
mkdir -p "$PUBLISH_TEMPLATE_WORKSPACE"
chmod 700 "$PUBLISH_TEMPLATE_WORKSPACE"

RUNTIME_NODE="$RUNTIME_NODE" \
RUNTIME_NODE_MODULES="$RUNTIME_NODE_MODULES" \
RUNTIME_BIN_DIR="$RUNTIME_BIN_DIR" \
SKILL_DIR="$SKILL_DIR" \
TMP_DIR="$TMP_DIR" \
"$RUNTIME_NODE" "$SKILL_DIR/template_following_scripts/inspect_template_deck.mjs" \
  --workspace "$PUBLISH_TEMPLATE_WORKSPACE" \
  --pptx "$PPTX_TEMPLATE"

cp "$TEMPLATE_WORKSPACE/template-audit.txt" \
  "$PUBLISH_TEMPLATE_WORKSPACE/template-audit.txt"
cp "$TEMPLATE_WORKSPACE/deviation-log.txt" \
  "$PUBLISH_TEMPLATE_WORKSPACE/deviation-log.txt"
cp "$TEMPLATE_WORKSPACE/template-frame-map.json" \
  "$PUBLISH_TEMPLATE_WORKSPACE/template-frame-map.json"
chmod 600 \
  "$PUBLISH_TEMPLATE_WORKSPACE/template-audit.txt" \
  "$PUBLISH_TEMPLATE_WORKSPACE/deviation-log.txt" \
  "$PUBLISH_TEMPLATE_WORKSPACE/template-frame-map.json"
```

```bash
RUNTIME_NODE="$RUNTIME_NODE" \
RUNTIME_NODE_MODULES="$RUNTIME_NODE_MODULES" \
RUNTIME_BIN_DIR="$RUNTIME_BIN_DIR" \
SKILL_DIR="$SKILL_DIR" \
TMP_DIR="$TMP_DIR" \
"$RUNTIME_NODE" "$SLIDE_SKILL/scripts/build-pptx.mts" \
  --model "$SLIDE_RUN/slide-model.json" \
  --template-pptx "$PPTX_TEMPLATE" \
  --template-workspace "$PUBLISH_TEMPLATE_WORKSPACE" \
  --template-frame-map "$PUBLISH_TEMPLATE_WORKSPACE/template-frame-map.json" \
  --role-map "$SLIDE_RUN/pptx-role-map.json" \
  --output "/absolute/path/to/product-slides-published.pptx" \
  --preview-dir "$SLIDE_RUN/published-preview-images" \
  --layout-dir "$SLIDE_RUN/published-layout-readback" \
  --readback "$SLIDE_RUN/published-pptx-readback.json" \
  --inspect-output "$SLIDE_RUN/published-pptx-inspection.ndjson" \
  --mode publish \
  --approval "$SLIDE_RUN/pptx-approval.json" \
  --validation-evidence "$SLIDE_RUN/pptx-validation-evidence.json" \
  --parity-evidence "$SLIDE_RUN/parity-receipt.json" \
  --reviewed-preview-pptx "$SLIDE_RUN/product-slides-preview.pptx" \
  --repo-root "$SLIDE_REPO" \
  --snapshot "$SLIDE_RUN/snapshot.json" \
  --docs "$SLIDE_RUN/docs-evidence.json" \
  --presentation-map "$SLIDE_RUN/presentation-map.json" \
  --claims "$SLIDE_SKILL/references/markitecture-claims.json" \
  --narrative-input "$SLIDE_RUN/narrative-input.json"
```

The five frozen source inputs are `snapshot`, `docs`, the owner-only runtime `presentation-map`,
`claims`, and `narrative-input`.
The repository root is a separate trust input: it must have the official NemoClaw origin and the recorded documentation commit must be reachable from its fetched `origin/main`.
Model construction and publication re-read the immutable Git objects and fail when the evidence envelope does not match them.
Publication also fails when the five source files do not rebuild the exact reviewed model.

Google Slides publication is a separate native write.
It requires the same two readbacks and parity receipt.
It also requires the revision and recovery-copy checks in `template-contract.md`.

## PowerPoint Role Map

Create `pptx-role-map.json` outside Git after inspecting the complete approved template.
The following synthetic JSON shows the runtime field shapes:

```json
{
  "schemaVersion": 1,
  "templateFingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "templateSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "templateFrameMapSha256": "9999999999999999999999999999999999999999999999999999999999999999",
  "insertionIndex": 1,
  "roles": {
    "roadmap-executive": {
      "preArchive": true,
      "sourceSlideIndex": 1,
      "targetSlideIndex": 1,
      "protectedTextSha256": [
        "4ad36f23a4516241e974131c5d177eaf530ff2ec9e4c8d70b9702b3ba5383f62"
      ],
      "forbiddenText": ["Synthetic stale executive exemplar text"],
      "operations": [
        {
          "target": { "name": "synthetic-executive-title" },
          "valuePath": "title"
        }
      ],
      "richTextOperations": [],
      "outcomeOperations": [],
      "outcomeListOperations": [
        {
          "target": { "name": "synthetic-outcomes-1" },
          "outcomesPath": "milestones.0.outcomes",
          "textStyle": { "fontSize": 48, "color": "#141414" },
          "paragraphStyles": [
            {
              "bulletCharacter": "●",
              "marginLeft": 355600,
              "indent": -406400,
              "spaceBefore": 1800,
              "spaceAfter": 0
            }
          ],
          "textFrameStyle": { "lineSpacing": 0.92, "alignment": "left" }
        },
        {
          "target": { "name": "synthetic-outcomes-2" },
          "outcomesPath": "milestones.1.outcomes",
          "textStyle": { "fontSize": 48, "color": "#141414" },
          "paragraphStyles": [
            {
              "bulletCharacter": "●",
              "marginLeft": 355600,
              "indent": -406400,
              "spaceBefore": 1800,
              "spaceAfter": 0
            }
          ],
          "textFrameStyle": { "lineSpacing": 0.92, "alignment": "left" }
        },
        {
          "target": { "name": "synthetic-outcomes-3" },
          "outcomesPath": "milestones.2.outcomes",
          "textStyle": { "fontSize": 48, "color": "#141414" },
          "paragraphStyles": [
            {
              "bulletCharacter": "●",
              "marginLeft": 355600,
              "indent": -406400,
              "spaceBefore": 1800,
              "spaceAfter": 0
            }
          ],
          "textFrameStyle": { "lineSpacing": 0.92, "alignment": "left" }
        }
      ]
    },
    "roadmap-capability": {
      "preArchive": true,
      "sourceSlideIndex": 2,
      "targetSlideIndex": 2,
      "forbiddenText": ["Synthetic stale matrix exemplar text"],
      "operations": [
        {
          "target": { "name": "synthetic-matrix-title" },
          "valuePath": "title"
        },
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
        "target": { "name": "synthetic-native-capability-table" },
        "topRow": 0,
        "firstMilestoneColumn": 1,
        "milestoneColumnCount": 3,
        "areaLabelColumn": 0,
        "areaRows": {
          "Usability and Onboarding": 1,
          "Agent Features": 2,
          "Acceleration and Optimization": 3,
          "Integrations and Blueprints": 4
        },
        "cellTextStyle": {
          "fontSize": 64,
          "typeface": "NVIDIA Sans Medium",
          "color": "#141414"
        },
        "cellParagraphStyle": { "bulletCharacter": "" },
        "cellTextFrameStyle": { "lineSpacing": 0.9, "alignment": "left" }
      },
      "unclassifiedWarning": {
        "position": { "left": 100, "top": 600, "width": 400, "height": 80 },
        "fill": "#FFF2CC",
        "lineFill": "#A15C00",
        "lineWidth": 1,
        "textStyle": { "fontSize": 14, "color": "#5F3700" }
      }
    },
    "markitecture": {
      "preArchive": true,
      "sourceSlideIndex": 3,
      "targetSlideIndex": 3,
      "forbiddenText": ["Synthetic stale markitecture exemplar text"],
      "title": {
        "position": { "left": 80, "top": 40, "width": 1000, "height": 70 },
        "prefix": "NemoClaw",
        "prefixStyle": { "fontSize": 28, "bold": true },
        "suffixStyle": { "fontSize": 28 },
        "textStyle": { "verticalAlignment": "middle" }
      },
      "geometry": {
        "connectorColor": "#5B5B5B",
        "connectorWidth": 2,
        "connectorLabelFontSize": 12,
        "connectorLabelTypeface": "Arial",
        "connectorLabelBold": false,
        "nodeFill": "#F2F2F2",
        "nodeLine": "#5B5B5B",
        "nodeFontSize": 14,
        "nodeTypeface": "Arial",
        "nodeTextColor": "#000000",
        "secondaryTextColor": "#5B5B5B",
        "nodeInsets": { "top": 6, "right": 8, "bottom": 6, "left": 8 },
        "connectorFrames": {
          "connector.synthetic": {
            "line": { "left": 300, "top": 300, "width": 120, "height": 0 },
            "label": { "left": 320, "top": 270, "width": 80, "height": 24 }
          }
        },
        "nodeFrames": {
          "node.synthetic": {
            "position": { "left": 100, "top": 250, "width": 200, "height": 100 },
            "geometry": "roundRect"
          }
        }
      }
    },
    "weekly-release": {
      "preArchive": true,
      "sourceSlideIndex": 4,
      "targetSlideIndex": 4,
      "forbiddenText": ["Synthetic stale weekly exemplar text"],
      "operations": [
        {
          "target": { "name": "synthetic-weekly-title" },
          "valuePath": "title"
        }
      ],
      "richTextOperations": [],
      "metricOperations": [
        {
          "target": { "name": "synthetic-momentum" },
          "kind": "momentum",
          "metricContentIds": ["metric.stars", "metric.forks"],
          "labelStyle": { "fontSize": 12 },
          "valueStyle": { "fontSize": 20, "bold": true },
          "detailStyle": { "fontSize": 12 }
        },
        {
          "target": { "name": "synthetic-opened-closed" },
          "kind": "opened-closed",
          "metricContentId": "metric.vdr-uat",
          "openedStyle": { "fontSize": 12 },
          "separatorStyle": { "fontSize": 12 },
          "closedStyle": { "fontSize": 12 }
        },
        {
          "target": { "name": "synthetic-latest-release" },
          "kind": "single",
          "metricContentId": "metric.latest-release",
          "valueStyle": { "fontSize": 18, "bold": true }
        }
      ],
      "milestoneRowOperations": [
        {
          "target": { "name": "synthetic-weekly-row-1-label" },
          "rowIndex": 0,
          "kind": "label",
          "placement": "left",
          "fillColor": "#76B900",
          "textStyle": { "fontSize": 14, "color": "#FFFFFF", "bold": true },
          "paragraphStyle": { "bulletCharacter": "" }
        },
        {
          "target": { "name": "synthetic-weekly-row-1-updates" },
          "rowIndex": 0,
          "kind": "updates",
          "nativeBullets": true,
          "textStyle": { "fontSize": 12 },
          "paragraphStyle": { "bulletCharacter": "•" }
        },
        {
          "target": { "name": "synthetic-weekly-row-1-risks" },
          "rowIndex": 0,
          "kind": "risks",
          "nativeBullets": true,
          "textStyle": { "fontSize": 12 },
          "paragraphStyle": { "bulletCharacter": "•" }
        },
        {
          "target": { "name": "synthetic-weekly-row-2-label" },
          "rowIndex": 1,
          "kind": "label",
          "placement": "left",
          "fillColor": "#76B900",
          "textStyle": { "fontSize": 14, "color": "#FFFFFF", "bold": true },
          "paragraphStyle": { "bulletCharacter": "" }
        },
        {
          "target": { "name": "synthetic-weekly-row-2-updates" },
          "rowIndex": 1,
          "kind": "updates",
          "nativeBullets": true,
          "textStyle": { "fontSize": 12 },
          "paragraphStyle": { "bulletCharacter": "•" }
        },
        {
          "target": { "name": "synthetic-weekly-row-2-risks" },
          "rowIndex": 1,
          "kind": "risks",
          "nativeBullets": true,
          "textStyle": { "fontSize": 12 },
          "paragraphStyle": { "bulletCharacter": "•" }
        },
        {
          "target": { "name": "synthetic-weekly-row-3-label" },
          "rowIndex": 2,
          "kind": "label",
          "placement": "left",
          "fillColor": "#76B900",
          "textStyle": { "fontSize": 14, "color": "#FFFFFF", "bold": true },
          "paragraphStyle": { "bulletCharacter": "" }
        },
        {
          "target": { "name": "synthetic-weekly-row-3-updates" },
          "rowIndex": 2,
          "kind": "updates",
          "nativeBullets": true,
          "textStyle": { "fontSize": 12 },
          "paragraphStyle": { "bulletCharacter": "•" }
        },
        {
          "target": { "name": "synthetic-weekly-row-3-risks" },
          "rowIndex": 2,
          "kind": "risks",
          "nativeBullets": true,
          "textStyle": { "fontSize": 12 },
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

Replace every synthetic selector, index, style, frame, and forbidden string with inspected values.
The map must bind every meaning-bearing exemplar object.
Repeat operations until every model value has one intended native target.

Required top-level fields are `schemaVersion`, `templateFingerprint`, `templateSha256`,
`templateFrameMapSha256`, `insertionIndex`, and `roles`.
`templateFrameMapSha256` must hash the exact `template-frame-map.json` bytes.
Use `insertionIndex: 1` to place the managed group after the preserved title slide.
Keep exactly the four base keys under `roles`; do not add `.N` instance keys there.
Repeated roadmap instances reuse the base contract through their frame-map entries.

Each base role requires:

- `preArchive: true`;
- a zero-based `sourceSlideIndex` from the inspected pre-archive region;
- a zero-based base `targetSlideIndex` that equals `insertionIndex` plus its role offset;
- `forbiddenText`, including every reviewed stale exemplar string for publication;
- all role-specific edit operations needed to render the complete model.

The reusable base-role offsets follow this order:

1. `roadmap-executive`;
2. `roadmap-capability`;
3. `markitecture`;
4. `weekly-release`.

For one roadmap page, these base roles use target indexes 1 through 4 and occupy slides 2 through 5.
The output count equals the complete inspected source count.
Each additional roadmap page reuses the first two base-role contracts.
Its frame-map entries use the next `roadmap-executive.N` and `roadmap-capability.N`
instance IDs.
The markitecture, weekly release, and preserved suffix entries move two output positions for each
additional page.

Each base role's source index must agree with every matching frame-map `sourceSlide` and
`narrativeRole`.
For the one-page base layout, its target index must also agree with `outputSlide`.
Do not use `deleteSourceAfterDuplicate`, `clearSourceElements`, or `preserveSourceText`.
Authorize each rewrite, deletion, and new primitive explicitly in the frame map.

Each role can include `protectedTextSha256`.
Use it only for approved slide-local template text that the inherited-layer comparison cannot classify.
Each entry must be the lowercase SHA-256 of the visible string after line-ending normalization.
Keep the allowlist in the runtime role map outside Git.
Omit the field when the role has no additional protected text.
Do not allowlist model-managed text or stale exemplar text.
Use the same reviewed per-role allowlist when classifying both format readbacks.

A target must contain one inspected selector:

```json
{ "name": "synthetic-native-object-name" }
```

```json
{ "anchorId": "synthetic-runtime-anchor" }
```

```json
{ "elementIndex": 7 }
```

Use `name` when the template provides one stable unique name.
`elementIndex` is zero-based and requires a new review after template drift.

Text operations support these fields:

- required `target`;
- exactly one of `valuePath` or `literal`;
- optional `prefix`, `suffix`, `search`, `linkPath`, or literal `link`;
- optional `textStyle`, `paragraphStyle`, and `textFrameStyle` where the operation supports them.
- optional `linkTextStyle` with `color` and `underline` for the exact linked run.

Role-specific arrays use these bindings:

- `outcomeOperations`: `target` and `outcomePath`;
- `outcomeListOperations`: `target`, `outcomesPath`, and one ordered `paragraphStyles`
  entry for each rendered outcome;
- `metricOperations`: `target`, `kind`, and the named metric ID field;
- `milestoneRowOperations`: `target`, zero-based `rowIndex`, and `kind` with value `label`,
  `updates`, or `risks`; every label also declares `placement: "left"`, inspected
  `fillColor: "#76B900"`, bold white `textStyle`, and an empty bullet character; every update or
  risk operation declares `nativeBullets: true` and the inspected native bullet character;
- capability `operations`: exactly three milestone-title bindings from `columns.0.title` through
  `columns.2.title`, in addition to other inspected capability text bindings;
- capability `table`: native table target, blank `topRow`, and all body row and column indexes;
- markitecture `geometry`: one frame for every model node and connector content ID.
- `geometryOperations`: a named native target and its complete integer-EMU `positionEmu`.

The adapters derive completed-Epic text from each item's native `state`.
The runtime role map does not contain an author-supplied completion flag.
For a closed executive outcome, add a checkmark (`✓`) and one space to the bold label run.
Apply gray `#5B5B5B` to the regular outcome run.
For a closed capability or unclassified item, add a checkmark (`✓`) and one space to the bold label
run and keep only `#NNNN` linked.

Define exactly one `milestoneRowOperations` entry for each kind at row indexes `0`, `1`, and `2`.
Use a distinct native target for every entry.
Clear all three targets for an unused row.
Require each inspected label target to remain vertically aligned with its row, left of both content
columns, filled `#76B900`, and rendered in bold white text. Validate those relative relationships
from artifact geometry instead of introducing replacement coordinates.
For `updates` and `risks`, use native paragraph bullets, preserve the bold `label` and regular
`text` runs, and never insert a bullet glyph into the text.
When a row has no documented risk, render `None` as exactly one native bullet.
Derive a weekly milestone-structure inventory from each output artifact. It records label fill,
label text color, relative left placement, paragraph text, and native bullet character; parity
blocks plain text, typed bullet glyphs, or a non-native `None` paragraph.
Keep weekly milestone labels, update text, risk text, and the latest-release top card unlinked.
Capture every reviewed weekly scorecard position and size in `geometryOperations`.
This includes card backgrounds, headings, milestone labels, update and risk regions, and source text
when their geometry changed.
Every `geometryOperations` target must have an exact matching frame-map `rewrite-and-reposition` target.

For the approved template, repeat the inspected raw paragraph values for each rendered outcome.
Keep each outcome's source-slot differences in the same order.
Define three executive milestone slots.
Define exactly three capability milestone-title operations and set capability
`milestoneColumnCount` to `3`.
Each operation must target one inspected top-row `HOME_PLATE` shape in column order.
Each milestone-title operation is a direct named-target `valuePath` binding: do not add `literal`,
`prefix`, `suffix`, `search`, fallback, transform, link, or alternate target fields.
Set `topRow` to the native table's blank structural row.
Preserve the inspected shape geometry, shape-over-table z-order, and white table dividers.
Do not render another milestone label below the table.
On a final partial page, the frame map must authorize `delete` for each unused executive milestone
title, focus, and outcome object and each unused capability `HOME_PLATE` shape.
The renderer deletes exactly those objects, filters their missing-column operations, clears each
unused capability body cell, and keeps every table top-row cell blank.

For an unclassified Epic preview, provide either `unclassifiedTarget` or
`unclassifiedWarning`.

## Google Slides Readback

Create this readback from actual native Google Slides objects after all edits:

```json
{
  "schemaVersion": 1,
  "modelSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "snapshotSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "templateFingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "artifact": {
    "kind": "google-slides",
    "id": "synthetic-preview-deck-id",
    "revisionId": "synthetic-preview-revision-id"
  },
  "slides": [
    {
      "role": "roadmap-executive",
      "instanceId": "roadmap-executive.1",
      "nativeObjectKinds": ["line", "shape", "text"],
      "connectorInventory": [],
      "hyperlinkInventory": [],
      "visibleTextInventory": [
        "Synthetic managed text",
        "Synthetic protected template text",
        "‹#›",
        "‹#›"
      ],
      "managedVisibleTextInventory": ["Synthetic managed text"],
      "protectedVisibleTextInventory": ["Synthetic protected template text"],
      "inheritedVisibleTextInventory": ["‹#›", "‹#›"],
      "content": {
        "role": "roadmap-executive",
        "instanceId": "roadmap-executive.1",
        "pageIndex": 1,
        "pageCount": 1
      },
      "managedNotes": "[NEMOCLAW-MANAGED-SLIDE v1]\nrole=roadmap-executive\ninstance_id=roadmap-executive.1\npage=1/1\n",
      "sources": []
    },
    {
      "role": "roadmap-capability",
      "instanceId": "roadmap-capability.1",
      "nativeObjectKinds": ["shape", "table", "text"],
      "connectorInventory": [],
      "capabilityStructureInventory": {
        "table": {
          "rowCount": 5,
          "columnCount": 4,
          "topRowText": ["", "", "", ""],
          "dividers": {
            "segmentCount": 49,
            "color": "#FFFFFF",
            "lineStyle": "solid",
            "widthEmu": 228600
          }
        },
        "milestoneTargets": [
          {
            "tableColumnIndex": 1,
            "text": "Q3",
            "shapeType": "HOME_PLATE",
            "inTopRowCell": true
          }
        ],
        "unusedTopRowMilestoneTargetCount": 0,
        "unusedBodyCellNonemptyCount": 0,
        "bottomMilestoneTargetCount": 0
      },
      "hyperlinkInventory": [
        {
          "text": "#101",
          "url": "https://github.com/NVIDIA/NemoClaw/issues/101"
        }
      ],
      "visibleTextInventory": [
        "Synthetic managed text",
        "‹#›"
      ],
      "managedVisibleTextInventory": ["Synthetic managed text"],
      "protectedVisibleTextInventory": [],
      "inheritedVisibleTextInventory": ["‹#›"],
      "content": {
        "role": "roadmap-capability",
        "instanceId": "roadmap-capability.1",
        "pageIndex": 1,
        "pageCount": 1
      },
      "managedNotes": "[NEMOCLAW-MANAGED-SLIDE v1]\nrole=roadmap-capability\ninstance_id=roadmap-capability.1\npage=1/1\n",
      "sources": []
    },
    {
      "role": "markitecture",
      "nativeObjectKinds": ["connector", "shape", "text"],
      "connectorInventory": [
        {
          "contentId": "connector.gateway-sandbox",
          "from": "node.gateway",
          "to": "node.sandbox",
          "direction": "from-to",
          "lineStyle": "solid"
        },
        {
          "contentId": "connector.sandbox-state",
          "from": "node.sandbox",
          "to": "node.state",
          "direction": "from-to",
          "lineStyle": "dashed"
        }
      ],
      "hyperlinkInventory": [],
      "visibleTextInventory": [
        "Synthetic managed text",
        "‹#›"
      ],
      "managedVisibleTextInventory": ["Synthetic managed text"],
      "protectedVisibleTextInventory": [],
      "inheritedVisibleTextInventory": ["‹#›"],
      "content": { "role": "markitecture" },
      "managedNotes": "[NEMOCLAW-MANAGED-SLIDE v1]\nrole=markitecture\n",
      "sources": []
    },
    {
      "role": "weekly-release",
      "nativeObjectKinds": ["shape", "text"],
      "connectorInventory": [],
      "hyperlinkInventory": [],
      "visibleTextInventory": [
        "Synthetic managed text",
        "‹#›"
      ],
      "managedVisibleTextInventory": ["Synthetic managed text"],
      "protectedVisibleTextInventory": [],
      "inheritedVisibleTextInventory": ["‹#›"],
      "content": { "role": "weekly-release" },
      "managedNotes": "[NEMOCLAW-MANAGED-SLIDE v1]\nrole=weekly-release\nsnapshot_as_of=2026-08-24T20:00:00Z\nwindow_start=2026-08-17T20:00:00Z\nwindow_end=2026-08-24T20:00:00Z\nmilestone_report_observed_at=2026-08-24T20:00:00Z\nmilestone_report_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nmilestone_rows=Q3 | GTC Berlin | Q4\n",
      "sources": []
    }
  ]
}
```

The synthetic values above show their locations only.
For each managed slide instance, create every field from one read of the exact preview artifact:

- `content` is the complete validated model slide after removing only `managedNotes` and `sources`;
- actual native-object readback confirms each audience-facing text field, link, object kind, and managed marker represented on the slide;
- the raw Epic state and progress values remain model-only, while actual visible text proves the
  state-derived checkmark and run treatment;
- `managedNotes` is the text read from the actual speaker-notes object after line-ending normalization;
- `sources` is parsed from the `[Sources]` records in those actual speaker notes;
- `managedVisibleTextInventory` contains model-managed slide-local strings read from native objects and table cells;
- `protectedVisibleTextInventory` contains approved template-owned slide-local strings read from native objects;
- `inheritedVisibleTextInventory` contains strings read from inherited layout and master layers;
- `visibleTextInventory` contains all nonempty strings in the three scoped inventories;
- `hyperlinkInventory` contains `{ "text", "url" }` entries read from actual linked native text runs and table cells;
- `connectorInventory` contains canonical connector relationships derived from native arrowheads, line treatment, and geometry;
- each capability `capabilityStructureInventory` comes from the native table and shapes: table dimensions, all four top-row cell strings, deduplicated physical divider count and style, used milestone-target type/text/column/alignment, unused top-row milestone-target count, nonempty unused-body-cell count, and bottom milestone-target count;
- `nativeObjectKinds` contains the actual editable object kinds;
- `artifact.id` and `artifact.revisionId` identify the exact preview that was read.

Normalize line endings in every text field.
Keep duplicate strings and sort each inventory.
For hyperlinks, coalesce only adjacent linked runs with the same URL inside one native text object.
Do not coalesce links across objects.
Normalize CRLF and CR to LF after coalescing, then remove exactly one provider-implied terminal LF.
Preserve every other space and newline.
Sort hyperlink entries by text and then URL without removing duplicates.
Normalize `homePlate` and `HOME_PLATE` to `HOME_PLATE`, divider colors to uppercase `#RRGGBB`,
and divider styles to lowercase. Preserve target order and table-column indexes.

The independently model-derived hyperlink contract is:

- every open executive Epic renders as `${displayTitle}: ${shortenedOutcome}`;
- every closed executive Epic renders as `✓ ${displayTitle}: ${shortenedOutcome}`;
- each complete executive row is at most 90 characters;
- the open executive `displayTitle:` is bold and its context is regular;
- the closed executive `✓ displayTitle:` is bold and its context is regular gray `#5B5B5B`;
- the executive roadmap has no visible text hyperlinks; retain its URLs in the model and speaker notes;
- every open capability item and unclassified Epic renders as `${displayTitle} (#${issueNumber})`;
- every closed capability item and unclassified Epic renders as
  `✓ ${displayTitle} (#${issueNumber})`;
- the two-to-four-word `displayTitle`, with any preceding checkmark, is bold and unlinked;
- only the `#${issueNumber}` run links to its exact `NVIDIA/NemoClaw` issue URL;
- capability entries contain no colon or executive context;
- each capability top-row `HOME_PLATE` milestone title is unlinked;
- markitecture has no hyperlinks;
- weekly milestone labels, Updates, Risks / Blockers, and the latest-release top card are unlinked;
- a template-owned source link, when present, remains protected and is inventoried separately from
  model-managed hyperlinks.

The comparator requires each format's artifact-derived hyperlink inventory to match this model-derived contract and the other format, including duplicate counts.

For connector readback, use entries shaped as
`{ "contentId", "from", "to", "direction": "from-to", "lineStyle" }`.
Derive each entry from the native artifact:

- identify the managed connector and its endpoint geometry;
- require exactly one arrowhead;
- resolve the arrowhead endpoint to the model's `to` node and the opposite endpoint to the model's `from` node;
- report `direction` as `from-to` only after that native check passes;
- report the native line treatment as `solid` or `dashed`;
- use an empty inventory for every other managed slide instance;
- sort by `contentId` and preserve every connector.

The expected relationship direction comes from each model connector's `from` and `to` fields.
The expected line treatment comes from its reviewed claim-ledger `lineStyle` field.
The rebuild, snapshot, and restore connector is dashed; the other six current connectors are solid.
Missing, duplicate, arrowless, double-arrowed, reversed, or differently styled connectors block parity.

The managed inventory must equal the exact model-derived inventory for that role, including duplicate counts.
The complete inventory must equal the sorted concatenation of the managed, protected, and inherited inventories.
Each protected inventory must match the exact per-role digest multiset in the runtime `protectedTextSha256` allowlist.
Each inherited inventory must contain only `‹#›`, twice for each `roadmap-executive` instance and
once for each other managed instance.
The protected and inherited inventories must then match across formats.
The actual notes and parsed source records must equal the corresponding model fields.
Parse each nonempty line after `[Sources]` and before the next bracketed section as
`sourceId | kind | location | commitSha | digest`.
Require at least one parsed source record.
Block publication when an actual slide-local string belongs to neither the managed nor protected inventory.

The slides array must contain every managed slide instance in exact model order.
For one roadmap page, it contains the two `.1` roadmap instances, markitecture, and weekly release.
Do not project notes, sources, any visible-text inventory, `hyperlinkInventory`, or `connectorInventory` from the model.

The PowerPoint builder writes the parallel readback automatically.
Its top level also contains `templateSha256`, `roleMapSha256`, and a `pptx` artifact identity.

## Parity Receipt

Start with the exact fields from `parity-comparison.json`.
Add both artifact bindings without changing a comparison hash:

```json
{
  "schemaVersion": 1,
  "equal": true,
  "modelSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "expectedProjectionSha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "googleProjectionSha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "pptxProjectionSha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  "googleVisibleTextSha256": "1111111111111111111111111111111111111111111111111111111111111111",
  "pptxVisibleTextSha256": "1111111111111111111111111111111111111111111111111111111111111111",
  "expectedHyperlinkSha256": "7777777777777777777777777777777777777777777777777777777777777777",
  "googleHyperlinkSha256": "7777777777777777777777777777777777777777777777777777777777777777",
  "pptxHyperlinkSha256": "7777777777777777777777777777777777777777777777777777777777777777",
  "expectedConnectorSha256": "8888888888888888888888888888888888888888888888888888888888888888",
  "googleConnectorSha256": "8888888888888888888888888888888888888888888888888888888888888888",
  "pptxConnectorSha256": "8888888888888888888888888888888888888888888888888888888888888888",
  "errors": [],
  "googleArtifact": {
    "id": "synthetic-preview-deck-id",
    "revisionId": "synthetic-preview-revision-id",
    "readbackPath": "/absolute/path/to/google-readback.json",
    "readbackSha256": "2222222222222222222222222222222222222222222222222222222222222222"
  },
  "pptxArtifact": {
    "id": "/absolute/path/to/product-slides-preview.pptx",
    "revisionId": "3333333333333333333333333333333333333333333333333333333333333333",
    "sha256": "3333333333333333333333333333333333333333333333333333333333333333",
    "readbackPath": "/absolute/path/to/pptx-readback.json",
    "readbackSha256": "4444444444444444444444444444444444444444444444444444444444444444"
  }
}
```

Required bindings are:

- both projection hashes must equal `expectedProjectionSha256`;
- both visible-text hashes must be non-null and equal;
- both artifact hyperlink hashes must be non-null and equal to `expectedHyperlinkSha256`;
- both artifact connector hashes must be non-null and equal to `expectedConnectorSha256`;
- `errors` must be empty;
- each `readbackSha256` must hash the exact named readback bytes;
- the Google identity must match `google-readback.json`;
- the PowerPoint ID must be the absolute reviewed-preview path;
- the PowerPoint `revisionId` and `sha256` must equal the reviewed-preview file hash.

Hash the final parity-receipt bytes.
Use that hash in validation evidence and approval.

## PowerPoint Validation Evidence

Create this file after full-size visual review, editability validation, and parity:

```json
{
  "schemaVersion": 1,
  "snapshotSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "modelSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "templateFingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "templateSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "roleMapSha256": "5555555555555555555555555555555555555555555555555555555555555555",
  "previewPptxPath": "/absolute/path/to/product-slides-preview.pptx",
  "previewPptxSha256": "3333333333333333333333333333333333333333333333333333333333333333",
  "outputPath": "/absolute/path/to/product-slides-published.pptx",
  "parityReceiptPath": "/absolute/path/to/parity-receipt.json",
  "parityReceiptSha256": "6666666666666666666666666666666666666666666666666666666666666666",
  "inspectedRoles": [
    "roadmap-executive.1",
    "roadmap-capability.1",
    "markitecture",
    "weekly-release"
  ],
  "fullSizeVisualReview": true,
  "nativeEditability": true,
  "notesAndLinksMatch": true,
  "crossFormatParity": true,
  "overflow": false,
  "clipping": false,
  "fontSubstitution": false,
  "staleText": false
}
```

Every field shown is required.
The three paths must be absolute and normalized.
The preview, publication output, and source-template paths must be distinct.
Despite its field name, `inspectedRoles` lists every managed slide identity in model order.
Add each additional roadmap `instanceId` before markitecture and weekly release.

## PowerPoint Approval

Create this file only after the user approves the exact reviewed artifacts:

```json
{
  "targetId": "/absolute/path/to/product-slides-published.pptx",
  "targetRevision": "absent",
  "snapshotSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "modelSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "templateFingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "roleMapSha256": "5555555555555555555555555555555555555555555555555555555555555555",
  "parityReceiptSha256": "6666666666666666666666666666666666666666666666666666666666666666"
}
```

Required bindings are:

- `targetId` equals the absolute resolved publication output path;
- `targetRevision` must equal the JSON string `"absent"` because the PowerPoint publication
  destination must not exist;
- the snapshot, model, and semantic template hashes equal the reviewed model;
- `roleMapSha256` hashes the exact runtime role-map bytes;
- `parityReceiptSha256` hashes the exact final parity-receipt bytes.

Preview approval does not authorize publication.
Never edit either source template during preview or publication.

## Retain and Clean Up Runtime Artifacts

The user owns the local runtime directory, each generated local preview, and each local publication output.
The invoking user owns the Google Slides copy unless its destination is a Shared Drive.
A Shared Drive owns a copy created there.
Retain `SLIDE_RUN`, the exact PowerPoint preview, the Google Slides preview copy, their readbacks, and every approval or evidence file until the user completes review and decides whether to publish.
Do not include a published output, source template, recovery copy, or target deck in routine cleanup.

Cleanup requires the user's direction for the exact local run directory and the exact Google Slides preview-copy ID.
Before local cleanup, display the resolved directory and enumerate its contents.
Reject a symlink or a directory name outside the `nemoclaw-product-slides.*` pattern created in [Runtime paths](#runtime-paths):

```bash
printf '%s\n' "$SLIDE_RUN"
find "$SLIDE_RUN" -mindepth 1 -maxdepth 1 -print
test -d "$SLIDE_RUN"
test ! -L "$SLIDE_RUN"
case "${SLIDE_RUN##*/}" in
  nemoclaw-product-slides.*) ;;
  *) exit 1 ;;
esac
```

Only after the user confirms that exact resolved path, remove that directory and confirm absence:

```bash
rm -rf -- "$SLIDE_RUN"
test ! -e "$SLIDE_RUN"
```

For the Google Slides preview copy, move only the user-named preview ID to trash, then read that same ID and report that it is trashed or absent.
Do not remove the source template, target deck, recovery copy, or another preview.
If any cleanup or absence check fails, report the remaining exact path or Drive ID and stop; do not broaden the removal scope.
