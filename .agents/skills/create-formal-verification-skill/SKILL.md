---
name: create-formal-verification-skill
description: Formally verify one NemoClaw promise where a bug costs the most and tests reach the least, and leave a project-local skill that rechecks it. Use to model-check a race, prove an invariant, or verify lifecycle, retry, or recovery logic.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 Lauren Tan -->
<!-- SPDX-License-Identifier: Apache-2.0 AND MIT -->
<!-- Adapted from pstack's create-formal-verification-skill; see ../NOTICE.md. -->

# Create a Formal Verification Skill

A test checks the cases someone wrote.
Formal verification checks every case in a stated scope: every order of steps in a model, every input up to a bound, or every input.
This skill verifies one property of the code where that matters most and leaves a project-local skill that lets the next agent check a change against it.
Write that skill for an agent who reads it cold, mid-change.
The user must be able to trust the result without learning the verification language.

## Choose the Target

Answer from the code, and ask the user only what you cannot observe.
If the user named an area or a bug, start there.

A good target is a promise NemoClaw makes, where a break harms users and tests rarely reach the case that breaks it.
The [ownership and recovery invariants](../../../docs/design/scope.md#ownership-and-recovery) list the strongest candidates: locked operations, recovery from partial creation and deletion, removing state only on confirmed absence, and retained storage.
Choose the strongest target, not the easiest.

Verify only NemoClaw's own promises.
When the property belongs to Fabric, OpenShell, or another component, apply the [upstream boundaries](../../../docs/design/scope.md#upstream-boundaries) and tell the user which repository should hold the check.

## Choose the Tool

Pick the tool that answers the question at the lowest cost, and tell the user why.

| Question | Tool |
|---|---|
| Can events across processes or components happen in a bad order? | A TLA+ model, read with the `statechart` skill. |
| Can threads or tasks inside one Rust crate interleave badly? | A Rust model checker that runs the code, such as loom or Stateright. |
| Does the Rust code behave for every input up to a bound, such as no overflow or a kept data-structure invariant? | A bounded verifier that runs on the code, such as Kani. |
| None of these runs on the code | Property-based tests of the code itself, not a hand model of the function. |

No verifier is a NemoClaw dependency yet.
A new crate must pass the [dependency policy](../../../docs/contributing/testing.md#dependency-policy), and a new tool in `cargo ci` must be pinned in `versions.json`.
Discuss either with the user before adding it.

## What Makes It Good

- **True to the code.** Every part of the model or proof points to code a reviewer can open.
  What the verification treats as one indivisible step is one indivisible step in the code.
  Names come from this repository.
- **Able to fail.** Show each property failing on a broken variant of the code it guards, such as a removed check or a reordered step.
- **Findings stay findings.** When the current code breaks the property, report the counterexample in the code's terms.
  Don't weaken the property or the model until it passes, and don't change product code unless the user asks.
- **Honest about scope.** Say what is verified, under which bounds and assumptions, and what is left out.
- **Readable without the tool.** State the property and the harm in one plain sentence each, and tell a counterexample as a short sequence of steps in the code's words.
- **Cheap to rerun.** One command, a pinned tool version, and a run short enough to use on every relevant change.
- **Kept in step with the code.** Record which files and functions each check covers and the commit at which you last confirmed the verification describes them.

## Generate the Verify Skill

Write `.agents/skills/verify-<area>/SKILL.md` with frontmatter naming the area and when to use it, the SPDX header, and `disable-model-invocation: true` unless every change to the area should load it.
Keep TLA+ models beside that skill; keep Rust harnesses and property tests in the crate they check.

From the skill alone, the next agent must be able to tell whether a change touches the verified code, run the check, tell a code bug from a modeling error, and update the verification when a change is intended.
Record the coverage and the sync commit in the skill, and tell the next agent to move the sync commit forward only after confirming that the verification describes the code at the new commit.
Use real commands, paths, and terms, with no placeholders.
For a TLA+ model, tell the next agent to read results with the `statechart` skill, and copy none of its commands into the generated skill.

## Prove It Before Handoff

Follow the generated skill once, as the next agent would, on a scratch change that breaks the property in the code.
It must catch the break.
Then drop the scratch change and confirm the check is back where it started: passing, or failing only on the findings you will report.
If the skill misses the break or a step doesn't run, fix the skill or the verification, not the scratch change.

## Hand Off

Tell the user what you verified, which tool you used and why, the bounds, what the check found, how to run it, and what it does not cover.
Commit the verification apart from any product fix.
Point the user to the `maintain-formal-verification-skill` skill for changes that skipped the check.
