<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Manual and Evaluation Evidence

Verification skills such as [`verify-fabric-boundary`](../../verify-fabric-boundary/SKILL.md) expose evidence that automation still lacks; they don't decide where tests belong.
Every manual check that remains needs a specific reason.

| Remaining check | Why automated evidence may not suffice | What replaces it |
|---|---|---|
| Model judgment and reports | A scripted response can't show autonomous tool choice, use of hidden skill instructions, non-evasion, or a truthful report of success or failure | Evaluations with the real model, independent graders, and repeatable inputs; human review where no reliable grader exists |
| Interactive experience | An API reply, an HTML fetch, or an allocated pseudo-terminal doesn't show a usable browser or terminal session, reconnection, shared sessions, or ownership after stop | A test that drives the real UI or terminal and asserts those behaviors; human review for usability that a harness can't measure |
| Target environment | A generic CI runner can't establish the selected hardware, model, credentials, storage, reboot, or platform policy | Candidate qualification on that target with the same observable outcomes; manual work only where provisioning or evidence collection is unscripted |
| Uncovered native or lifecycle behavior | Mapping tests and fakes can't show native skill or plugin loading, tool effects, physical retention, cold resume, or bounded shutdown | Owner integration tests for native behavior, and deployed tests for mounts and lifecycle wiring; this is an automation gap, not manual work |

## Record Each Check

For each manual check that remains, report:

1. the required outcome;
2. the missing evidence, and why existing automation can't provide it;
3. the owner;
4. the replacement test or evaluation, which is its exit condition.

State whether the check waits for automation, needs judgment that no reliable grader provides, or needs access to a target or credential that CI lacks.

## Rules

- Keep only the missing observation; don't repeat parsing, projection, or planning assertions that tests already prove.
- A missing feature is Failed and missing access is Not tested; neither becomes a pass through a workaround.
- Retire a manual check only when automation covers the same harness, lifecycle phase, and platform risk.
- Use verification runs and release QA to find residual gaps, not to define where tests belong.
