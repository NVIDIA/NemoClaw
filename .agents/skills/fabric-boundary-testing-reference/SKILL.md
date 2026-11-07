---
name: fabric-boundary-testing-reference
description: Decide where evidence for a NemoClaw–NeMo Fabric boundary behavior belongs. Names the owning repository and component from scope and implementation evidence in both repositories, the cheapest layer that can observe the behavior, the existing tests to reuse, and the manual checks or model evaluations that must remain, with reasons. Use when planning, migrating, or reviewing a test or a verify-skill check for a Fabric-managed agent. Advises only; never deploys or writes tests.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Boundary Testing Reference

This skill recommends where evidence for a behavior at the NemoClaw–NeMo Fabric boundary belongs: which repository and component owns it, which layer observes it most cheaply, which existing tests already cover it, and what must stay a manual check or a model evaluation.
It advises only.
Once NemoClaw owns a part, [`write-tests`](../write-tests/SKILL.md) picks its suite and [`test-driven-development`](../test-driven-development/SKILL.md) governs writing it.

## Invoke

The skill sets `disable-model-invocation: true`, so an agent loads it only by name.
In Pi, type `/skill:fabric-boundary-testing-reference` followed by the behavior, change, or check to place:

```text
/skill:fabric-boundary-testing-reference OpenClaw must keep a plugin the agent installed after a runtime restart.
```

It needs a NemoClaw `v1` checkout and `gh` read access to `NVIDIA/NemoClaw` and `NVIDIA/NeMo-Fabric`.
It needs no deployment, GPU, or inference credentials.

## Report

Return one entry per behavior, or per part of a split requirement:

| Field | Contents |
|---|---|
| Behavior and phase | The circumstances, the observable outcome, and the lifecycle phase |
| Owner | Repository and component, citing scope sources and implementation sources separately |
| Revisions | The NemoClaw commit, the Fabric pin NemoClaw consumes, and any other revision consulted |
| Existing coverage | Each test that observes the behavior, by path and name, with what it doesn't observe and whether the owner's CI runs it |
| Missing guarantee | What no existing test observes, or `none` |
| Destination | Repository, layer, and the suite or scenario to extend, with the reason; or `no new test` |
| Remaining evidence | Each manual check or model evaluation that remains, with its reason, owner, and exit condition |
| Open questions | Each unresolved ownership or contract question, with the evidence that is missing or conflicts |

Recommend `no new test` when existing evidence is sufficient.

## Decide

Work through these steps for each behavior.
[Placement](references/placement.md) holds the layer rules, [evidence](references/evidence.md) the commands and source locations, and [manual evidence](references/manual-evidence.md) the rules for checks that remain.

1. **State the behavior.** Write the circumstances and the observable outcome, then name the lifecycle phase: configure, launch, interact, change, resume, or clean up.
2. **Establish the owner from both repositories.** Read NemoClaw's [upstream boundaries](../../../internal-docs/design/scope.md#upstream-boundaries) and design documents, Fabric's contracts and contributor guidance at the consumed pin, and the issue and PR decisions that bind them.
   Follow OpenShell or native-harness ownership when the sources point there.
   [Classify each source](references/evidence.md#classify-each-source) as a required contract, proposed scope, current implementation, or observed passing evidence; one kind doesn't stand in for another.
3. **Record revisions and cite sources.** [Record](references/evidence.md#record-revisions) the NemoClaw commit, the Fabric pin, and any other upstream revision you read.
   Cite exact files, lines, and test names at those revisions, and [check each issue's and PR's current state](references/evidence.md#check-status) before relying on it.
   A test or fix on Fabric `main` covers NemoClaw only once the pin includes it.
   When evidence is missing or conflicts, name the open ownership or contract question; don't invent scope or propose a workaround.
4. **Find existing coverage first.** Search the owner's tests in both repositories before proposing new work.
   [Split a composite requirement](references/placement.md#split-composite-requirements): configuration projection, native effects, and deployed wiring can have different owners and layers.
5. **Choose the cheapest sufficient layer** in the owner's repository, using [the paired layers](references/placement.md#paired-layers).
   A scripted model makes a native process's inputs repeatable; it doesn't make that process a unit test.
   A directory name doesn't establish what a test proves; [read what it runs](references/placement.md#evidence-strength).
6. **Justify each live assertion** by what needs real images, mounts, forwarding, an engine or cluster, or the deployment lifecycle, following [live assertions](references/placement.md#live-assertions).
   Extend a small existing journey and keep permutations at lower layers.
   Keep deployed failure and recovery evidence that no fixture can produce.
   Don't multiply harnesses, models, and lifecycle phases into a matrix, or raise a time budget.
7. **Separate what tests can't prove.** Keep model evaluations and target-platform qualification apart from boundary tests.
   For each manual check that remains, state the missing observation, why automation can't make it, its owner, and its exit condition.
   Say whether it waits for automation, needs judgment, or needs target access.
   Retire a manual check only for an equivalent guarantee: the same harness, lifecycle phase, and platform risk.

## Limits

- Read only. Don't write tests, edit files, deploy, run live suites, or create, comment on, or edit issues and pull requests; when the user asks for that work, use the skill that owns it.
- Report scope you can't establish as an open question, not as a gap for NemoClaw to fill; [upstream boundaries](../../../internal-docs/design/scope.md#upstream-boundaries) say what to do when an upstream gap blocks a feature.
- Put issue status, coverage counts, and qualification results in the report, not in this skill.

## Related Skills

| Need | Use |
|---|---|
| The NemoClaw suite, file, and assertions | [`write-tests`](../write-tests/SKILL.md) and [test layers](../../../internal-docs/contributing/testing.md#test-layers) |
| Writing the test | [`test-driven-development`](../test-driven-development/SKILL.md) |
| A manual check on a deployment | [`verify-fabric-boundary`](../verify-fabric-boundary/SKILL.md) |
| Fixture commands and CI selection | [Run integration tests](../../../internal-docs/contributing/integration-tests.md) and [how CI runs the tests](../../../internal-docs/contributing/testing.md#how-ci-runs-the-tests) |

## Maintain

This skill follows [`create-verification-skill`](../create-verification-skill/SKILL.md)'s process, adapted to a placement decision: interview both repositories, ground the rules in their sources, prove the workflow by driving placement requests, then define maintenance.
Its input is a behavior and repository evidence, and its output is a recommendation; a recommendation qualifies no product behavior.
It has no launch, doctor, drive, or feature map, so it isn't a verify skill: [`maintain-verification-skill`](../maintain-verification-skill/SKILL.md) doesn't apply, and a deployment doesn't validate it.

Review it when any of these change:

- NemoClaw's [scope](../../../internal-docs/design/scope.md), upstream boundaries, or design documents;
- the Fabric pin, Fabric's test layout, or Fabric's contributor or adapter-contract guidance;
- NemoClaw's suites in [tests](../../../internal-docs/contributing/testing.md) or [`write-tests`](../write-tests/SKILL.md);
- the boundary a reference names between Fabric, OpenShell, and a harness.

Validate a change by driving representative placement requests from a fresh checkout with a reader who isn't given the expected answers, then check each recommendation's owner, layer, citations, and manual-check reasons against the sources.
