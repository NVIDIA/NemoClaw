---
name: fabric-boundary-testing-reference
description: Decide where evidence for a NemoClaw–NeMo Fabric boundary behavior belongs, meaning the owning repository and component, the cheapest layer that observes it, the existing tests to reuse, and any manual check or model evaluation that must remain. Use when planning, migrating, or reviewing a test or verify-skill check for a Fabric-managed agent. Advises only.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Boundary Testing Reference

This skill recommends where a test for a behavior at the NemoClaw–NeMo Fabric boundary belongs.
It reads both repositories and reports; it doesn't write tests, deploy, or change GitHub.
Once NemoClaw owns a part, [`write-tests`](../write-tests/SKILL.md) picks its suite.

Run it by name, since it sets `disable-model-invocation: true`:

```text
/skill:fabric-boundary-testing-reference OpenClaw must keep a plugin the agent installed after a runtime restart.
```

It needs a NemoClaw `v1` checkout and `gh` read access to `NVIDIA/NemoClaw` and `NVIDIA/NeMo-Fabric`, and no deployment, GPU, or inference credentials.

## Decide

For each behavior:

1. **State it:** the circumstances, the observable outcome, and the lifecycle phase: configure, launch, interact, change (a configuration change or sandbox replacement), resume (state and sessions returning afterward), or clean up.
2. **Record revisions** from the NemoClaw checkout's root:

   ```sh
   git rev-parse HEAD
   PIN=$(sed -n 's/^ARG FABRIC_REVISION=//p' image/fabric/Dockerfile)
   gh api "repos/NVIDIA/NeMo-Fabric/compare/$PIN...main" -q .status
   gh api "repos/NVIDIA/NeMo-Fabric/contents/PATH?ref=$PIN" -H 'Accept: application/vnd.github.raw'
   gh pr list --base v1 --state open --limit 100 --json number,title,files --jq '.[] | select(any(.files[]; .path == "image/fabric/Dockerfile")) | "#\(.number) \(.title)"'
   ```

   Read Fabric at `$PIN`, the revision the agent images install; GitHub code search shows only `main`.
   Unless the status is `identical` or `behind`, `main` has commits the pin lacks, and a test or fix there covers NemoClaw only once the pin contains it; `diverged` also means the pin has commits `main` lacks.
   When an open PR moves the pin, name it and say which answer it would change.
3. **Find the owner in both repositories.** Read NemoClaw's [upstream boundaries](../../../internal-docs/design/scope.md#upstream-boundaries), `internal-docs/design/`, and the user documentation under `docs/` for the feature.
   At the pin, start with the Testing section of Fabric's `CONTRIBUTING.md`, `.agents/skills/validate-change/SKILL.md`, the adapter's source and tests, and the `justfile` and `.github/workflows/`, which show what CI runs.
   Follow OpenShell or native-harness ownership when the sources point there: read `NVIDIA/OpenShell` at the release `versions.json` names, and each harness at the version `image/fabric/Dockerfile` pins.
   Keep four kinds of source apart: a required contract, proposed scope such as an open issue, the current implementation, and observed passing evidence.
   Check each issue's and PR's current state before relying on it.
   When evidence is missing or conflicts, report an open ownership or contract question; don't invent scope or propose a workaround.
4. **Find existing coverage first**, in both repositories, including the manual checks in [`verify-fabric-boundary`](../verify-fabric-boundary/SKILL.md).
   Split a composite requirement into parts with their own owners.
   For example, "an installed plugin survives a runtime restart" splits into NemoClaw binding the retained volume, the adapter keeping native state there, the harness reloading the plugin, and the files surviving a real restart.
5. **Choose the cheapest layer** in the owner's repository that observes the part:

   | Layer | NemoClaw | NeMo Fabric |
   |---|---|---|
   | Fast | Compilation, validation, configuration projection, mount payloads, graph changes, and CLI rules | Adapter mapping, tool policy, skill paths, state selection, validation, and runtime rules |
   | Integration | Plan and apply, target-only replacement, bindings, ownership, and recovery, against fixtures | Native loading, dispatch, interfaces, session resume, cancellation, and effects, through the packaged native runtime |
   | End to end | Deploy, use, and retain through real images, forwarding, mounts, and an engine or cluster | A complete runtime journey that lower layers can't observe |

   NemoClaw's fast layer is its unit suite, integration is its contract and integration suites, and end to end is live E2E; see [test layers](../../../internal-docs/contributing/testing.md#test-layers).
6. **Justify each live assertion** by what needs real images, mounts, forwarding, an engine or cluster, or the deployment lifecycle.
   Extend a small existing journey, keep permutations at lower layers, and keep deployed failure and recovery evidence that no fixture can produce.
   Don't build a harness, model, and lifecycle-phase matrix, or raise a time budget.
7. **Separate what tests can't prove**, using [manual evidence](#manual-evidence).

## Evidence Strength

- A scripted model makes inputs repeatable at any layer; a native process it drives is still an integration test, and it proves nothing about model behavior.
- A test whose native objects are mocks proves the adapter's handling, not native behavior.
- A directory name, such as `tests/e2e/`, doesn't show what a test proves; read what it starts and asserts.
- A test is CI evidence only when the owner's CI runs it: check Fabric's workflows and `justfile`, and NemoClaw's [CI selection](../../../internal-docs/contributing/testing.md#how-ci-runs-the-tests), which runs some live cases only when a change selects them.
- Configuration that NemoClaw passes through unchanged in an upstream format needs one pass-through test, not one per upstream field.
- Configuration or an advertised tool list doesn't prove native execution, denial, or loading.
- An API reply, an HTML fetch, or an allocated pseudo-terminal doesn't prove a usable browser or terminal session.
- Retained bytes don't prove a resumed conversation, and reuse within one runtime doesn't prove resume in a new one.

## Manual Evidence

Keep a manual check or evaluation only for an observation automation can't make yet:

| Remaining check | Why tests may not suffice | Replacement |
|---|---|---|
| Model judgment and reports | A scripted response can't show autonomous tool choice, use of hidden skill instructions, or a truthful report | Real-model evaluations with independent graders; human review where no reliable grader exists |
| Interactive experience | An API reply or a pseudo-terminal doesn't show a usable UI, reconnection, or shared sessions | A test that drives the real UI or terminal |
| Target environment | A generic CI runner can't establish the hardware, model, credentials, storage, reboot, or platform policy | Qualification on that target |
| Uncovered native or lifecycle behavior | Mapping tests and fakes can't show native loading, tool effects, physical retention, cold resume, or bounded shutdown | Owner integration tests and deployed tests: an automation gap, not manual work |

For each check, give the required outcome, the missing evidence and why automation can't provide it, the owner, and the replacement that retires it.
Retire a check only when automation covers the same harness, lifecycle phase, and platform risk.
A missing feature is Failed and missing access is Not tested; neither passes through a workaround.

## Report

For each behavior or part, report:

- **Owner:** repository and component, citing scope and implementation sources separately.
- **Revisions:** the NemoClaw commit and the Fabric pin, once when every part shares them.
- **Existing coverage:** each test by path and name, what it doesn't observe, and whether the owner's CI runs it.
- **Destination:** repository, layer, and the suite or scenario to extend, with the reason; or `no new test`.
- **Remaining evidence:** each manual check or evaluation, with its reason, owner, and exit condition.
- **Open questions:** each unresolved ownership or contract question.

Keep issue status, coverage counts, and qualification results in the report, not in this skill.

## Maintain

This skill follows [`create-verification-skill`](../create-verification-skill/SKILL.md)'s process, adapted to a placement decision; it has no launch or feature map, so [`maintain-verification-skill`](../maintain-verification-skill/SKILL.md) doesn't apply.
Review it when NemoClaw's scope or test layers, the Fabric pin, or Fabric's test guidance change, by running placement requests from a fresh checkout without giving the reader the expected answers.
