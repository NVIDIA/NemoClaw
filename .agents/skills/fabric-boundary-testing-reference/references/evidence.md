<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Evidence

Collect evidence from both repositories at the revisions NemoClaw consumes.
Run these commands from the root of a NemoClaw `v1` checkout.

## Record Revisions

```sh
git rev-parse HEAD
PIN=$(sed -n 's/^ARG FABRIC_REVISION=//p' image/fabric/Dockerfile)
echo "$PIN"
grep -h 'nemo-fabric-core = ' crates/*/Cargo.toml | sort -u
```

`FABRIC_REVISION` is the Fabric that the agent images install; the `nemo-fabric-core` revision is the one the Rust crates compile against.
Report both, and say which one the behavior depends on when they differ.

Before citing a Fabric test or fix from another revision, such as `main`, check whether the pin contains it:

```sh
gh api "repos/NVIDIA/NeMo-Fabric/compare/$PIN...main" -q '"\(.status) main_ahead=\(.ahead_by) pin_ahead=\(.behind_by)"'
gh api "repos/NVIDIA/NeMo-Fabric/compare/COMMIT...$PIN" -q .status
```

The second command prints `ahead` or `identical` when the pin contains `COMMIT`.
A pin that has `diverged` from `main` carries commits that `main` lacks, so neither one's tests stand in for the other's.

## Read Fabric at the Pin

Read single files and directories without cloning:

```sh
gh api "repos/NVIDIA/NeMo-Fabric/contents/PATH?ref=$PIN" -H 'Accept: application/vnd.github.raw'
gh api "repos/NVIDIA/NeMo-Fabric/contents/tests?ref=$PIN" -q '.[].path'
```

To search many files, fetch the pin outside the checkout:

```sh
FABRIC_SRC=$(mktemp -d)
git -C "$FABRIC_SRC" init -q
git -C "$FABRIC_SRC" fetch -q --depth 1 https://github.com/NVIDIA/NeMo-Fabric "$PIN"
git -C "$FABRIC_SRC" checkout -q FETCH_HEAD
```

Then search it with `git -C "$FABRIC_SRC" grep -n -i -E 'PATTERN' -- tests adapters`, and remove the directory when you finish.

GitHub code search indexes only the default branch, so it can't show what the pin contains.

At the pin, start with:

- `AGENTS.md`, and the Testing section of `CONTRIBUTING.md`, for suites and commands;
- `.agents/skills/validate-change/SKILL.md` and `.agents/skills/contribute-adapter/SKILL.md`, for the checks an adapter change needs;
- `adapter-contract/` and `docs/adapter-contract/`, for what an adapter promises;
- the adapter's `README.md` under `adapters/`;
- `.github/workflows/`, for which suites CI runs and which harnesses it installs.

Fabric's test directories are search starting points, not layers: read each test's fixtures to see whether it runs a native harness, a mock, or a scripted model server.

## Read NemoClaw

- Responsibilities: [scope](../../../../internal-docs/design/scope.md), including its upstream boundaries and ownership and recovery, and the [design documents](../../../../internal-docs/design/), such as [Fabric management](../../../../internal-docs/design/fabric-management.md).
- Accepted gaps: [current limits](../../../../docs/resources/limits.md).
- How NemoClaw consumes Fabric: `image/fabric/`, `crates/nemoclaw-fabric/`, and `crates/fabric-provider/`.
- Tests: every suite that [`write-tests`](../../write-tests/SKILL.md#2-find-what-already-covers-it) lists, searched by resource type, field, error text, and fixture fault, for example:

```sh
git grep -n -i -E 'skills|extraDirs' -- crates image
```

## Classify Each Source

| Kind | Examples | Establishes |
|---|---|---|
| Required contract | NemoClaw's scope and design documents, Fabric's adapter contract, a decision recorded in an issue or merged PR | What must hold |
| Proposed scope | An open issue or epic, an open PR | What someone intends; not yet required |
| Current implementation | Source at the recorded revision | What the code does now |
| Observed passing evidence | A test at the recorded revision that the owner's CI runs, or a recorded run | That the behavior held under that test's conditions |

Report each kind separately.
Implementation without a contract isn't a requirement, and a passing test at another revision isn't evidence for the pin.

## Check Status

Check an issue or PR's state when you cite it:

```sh
gh issue view N --repo OWNER/REPO --json state,title,closedAt
gh pr view N --repo OWNER/REPO --json state,mergedAt,mergeCommit,baseRefName
```

A merged PR counts only when the recorded revision contains its merge commit: `git merge-base --is-ancestor SHA HEAD` for NemoClaw, and the comparison in [Record Revisions](#record-revisions) for Fabric.
