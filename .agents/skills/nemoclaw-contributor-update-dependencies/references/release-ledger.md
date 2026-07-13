<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Release ledger

Use this reference to turn a version gap into adjacent, auditable migration ranges.

## Required identities

Record for the current dependency and every candidate endpoint:

- semantic version and exact commit SHA;
- lightweight or annotated tag type;
- whether the commit is verified under the upstream project's policy;
- tag ancestry from the currently supported release;
- GitHub or registry release status: published, draft, prerelease, failed, or absent;
- producer workflow run and attempt when artifacts exist;
- release date and the next endpoint.

Treat a tag, release, package publication, and container publication as separate facts. A tag with
a failed release workflow is a source boundary but not a shippable artifact boundary.

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

1. Exact tagged source and tests that execute the contract.
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

## Minimum per-range output

```text
Range: <old-tag>..<new-tag>
Identity: <old-sha> -> <new-sha>
Release state: <published|failed|absent|candidate>
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
