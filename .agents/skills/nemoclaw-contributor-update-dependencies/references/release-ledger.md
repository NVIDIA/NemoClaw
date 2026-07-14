<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Release ledger

Use this reference to turn a version gap into adjacent, auditable migration ranges.

## Required identities

Record for the current dependency and every candidate endpoint:

- semantic version and commit SHA;
- lightweight or annotated tag type;
- whether the commit is verified under the upstream project's policy;
- tag ancestry from the currently supported release;
- GitHub or registry release status: published, draft, prerelease, failed, or absent;
- producer repository, workflow path, event, run, attempt, status, conclusion, and source SHA when
  artifacts exist;
- release date and the next endpoint.

Treat a tag, release, package publication, and container publication as separate facts. A tag with
a failed release workflow is a source boundary but not a shippable artifact boundary.
Artifacts uploaded before a later job failure remain non-shippable even when their individual
metadata and source SHA look correct.

For GitHub repositories, pass `--github-repository OWNER/REPO` and the API hostname to the
collector. It binds the canonical repository ID, requires a rerun when the requested name redirects
or was renamed, inventories paginated remote semantic-version refs, and verifies every in-range tag
against the local root object and peeled commit. It rechecks the canonical repository identity,
the advertised target ref, full semantic-version tag-root inventory, and full visible release
inventory after local range collection; a changed value invalidates the run. Shallow history,
missing or corrupt reachable objects, `refs/replace`, grafts, alternates, promisor packs, repository
config includes, and `fsck.*` overrides stop collection. Partial/promisor clone configuration,
including an empty marker or invalid promisor boolean, also stops collection before ref resolution
or history traversal so lazy fetch cannot conceal incomplete object closure. Every Git command is
bounded and non-interactive, ignores ambient `GIT_*` controls plus system/global config, disables
replacement objects and lazy fetch, suppresses signature display, and cannot invoke configured
filesystem-monitor, pager, external diff, textconv, or signature helpers. The collector traverses
the complete target and in-range tag object closure and runs strict full integrity checks. For an
untagged candidate, pass the advertised `refs/heads/...` ref and require it to equal the audit
target; a raw Git commit endpoint can expose fork or pull-request objects and does not prove
upstream-ref membership. GitHub exposes drafts only to viewers with push access, so an omitted tag
is `absent` only with proven full draft visibility; otherwise it is `not-published`, which proves no
visible published release but not that no draft exists. API, authentication, response-shape,
identity, timestamp, URL, tag, and timeout failures stop collection. Release `target_commitish` is
reported creation input, not resolved tag identity. None of this infers producer success or
package/container publication from the release object.

## Adjacent-range procedure

For every `release N -> release N+1` range:

1. Read the official release notes and repository changelog entry.
2. Read every commit subject and inspect the complete changed-path list.
3. Open source and tests for every plausible downstream contract change.
4. Identify changes omitted from or generalized by the notes.
5. Record packaging, CI, and release failures even when product source is sound.
6. Add concern-ledger rows before moving to the next range.

Do not batch “small” releases together. A one-line commit can change a default, image tag,
minimum platform, or failure mode that controls the entire downstream runtime.

## Source priority

Use evidence in this order when sources disagree:

1. Tagged source and tests that execute the contract.
2. Published schemas, generated API definitions, and release workflow inputs.
3. Official release notes and changelog.
4. Commit or PR descriptions.
5. Downstream assumptions and historical documentation.

Lower-priority evidence can identify a concern but cannot overrule higher-priority behavior.

## Missing or failed releases

When a tag lacks a successful release:

- retain it in the semantic source ledger;
- record why publication failed and which artifacts were skipped;
- do not use its absent artifacts as a compatibility result;
- inspect whether the next release incorporates the same source plus additional changes;
- require the final consumed release to pass its own provenance and compatibility gates.

When the target is an unreleased commit, label the last range `latest-tag -> candidate-commit` and
repeat that range against the final tag before shipping.

Keep four identity records beside the ledger: required upstream fix SHAs; the upstream audit
target; the upstream artifact producer repository/head/workflow/run/attempt; and the downstream
NemoClaw PR head plus proof manifest. Require the audit target to descend from every required fix,
bind an untagged audit target to its advertised upstream ref, require the upstream producer and
artifacts to bind to that target, and require the downstream manifest to pin those artifacts while
its workflow binds to the NemoClaw head. Upstream and downstream SHAs are different identity
domains, not values that should equal each other. Descendant evidence can inform the next audit
range but cannot close the requested target, and predecessor evidence cannot be inherited forward.

## Minimum per-range output

```text
Range: <old-tag>..<new-tag>
Identity: <old-sha> -> <new-sha>
Release state: <published|prerelease|draft|failed|absent|not-published|unreleased-commit>
Commits and changed paths: <ledger reference>
Notes claims: <claims or none>
Source/test findings: <behavioral findings>
Downstream touchpoints: <paths/symbols or pending trace>
Concerns opened: <IDs>
Concerns resolved: <IDs and evidence>
Carry-forward questions: <questions for later ranges>
```

Carry questions forward explicitly. A later release may supersede a migration, but the ledger must
show the old and new contracts and why only the final one needs downstream implementation.
