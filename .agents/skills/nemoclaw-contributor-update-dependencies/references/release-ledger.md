<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Release Ledger

Use a release ledger to divide a dependency upgrade into adjacent migration ranges. Derive
tag formats, publication mechanisms, and artifact types from the current upstream and downstream
repositories.

## Record identities

Keep separate records for:

- each source tag or commit and its ancestry;
- release or registry publication status;
- the producer repository, workflow, run, attempt, and source identity;
- each consumed package, archive, binary, or image identity;
- required upstream fix commits;
- the NemoClaw PR commit and its validation evidence.

Do not compare unrelated upstream and downstream commit SHAs for equality. Bind each artifact and
result to the identity domain that produced or consumed it.

## Audit adjacent ranges

For each adjacent release boundary:

1. Resolve immutable endpoints and verify ancestry.
2. Read release notes and the repository changelog.
3. Inspect every commit and changed path.
4. Read changed source and upstream tests that define downstream contracts.
5. Record packaging or publication failures.
6. Open downstream concerns before continuing to the next range.

Do not replace adjacent ranges with one aggregate old-to-new summary. Include unreleased commits as
a distinct terminal range and repeat that audit when a release is published.

## Prioritize sources

Use evidence in this order when sources disagree:

1. Source and tests at the selected immutable revision.
2. Published schemas and release workflow inputs.
3. Official release notes and changelog entries.
4. Commit and PR descriptions.
5. Downstream documentation and assumptions.

Lower-priority evidence can identify a concern. It cannot overrule current executable behavior.

## Use the collector

The skill includes `scripts/collect-release-ledger.py` for deterministic Git and supported GitHub
evidence. Inspect its current `--help`, source, and tests before use. Do not copy its command-line
interface into this reference.

When collector output contributes provenance evidence, execute the helper from the trusted base
revision with reviewed tool paths. Treat incomplete history, ambiguous identity, remote drift, or
collection failure as missing evidence.

The collector does not establish producer success, package publication, artifact integrity, or
runtime selection unless its current output explicitly records that evidence.

## Minimum range result

Record the endpoints, release state, commits and paths, upstream behavior changes, downstream
consumers, opened and resolved concerns, evidence, and carry-forward questions for each range.
