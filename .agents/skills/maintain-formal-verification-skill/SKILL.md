---
name: maintain-formal-verification-skill
description: Bring a project-local formal verification back in line with code that changed without rechecking it, and say whether each failure is drift or a bug. Use after merges or refactors that touched verified code.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 Lauren Tan -->
<!-- SPDX-License-Identifier: Apache-2.0 AND MIT -->
<!-- Adapted from pstack's maintain-formal-verification-skill; see ../NOTICE.md. -->

# Maintain a Formal Verification Skill

When the code changes and its verification doesn't, the check can keep passing on code that no longer exists.
That pass looks like a proof, so it is the dangerous case.
This skill updates a `.agents/skills/verify-<area>` skill that the `create-formal-verification-skill` skill generated, or any project skill that runs a model checker, prover, or verifier against named code, after changes that skipped it.

## Outcomes

Give each check one outcome:

- **in sync**: no change since the sync commit alters what the check describes, and the check passes.
- **updated**: the verification now describes the changed code, and the check passes.
- **bug**: the verification describes the current code, and the code breaks the property.
- **blocked**: the check could not be brought back in line or could not run; say exactly why.

A check can be both updated and bug.

## Edit Scope

Edit only the verification: models, harnesses, properties, and the verify skill.
Don't edit product code unless the user asks.
When a property fails on the current code, report it; don't weaken the property or the model to make it pass.

## Pass

1. **Find the checks.** Read each `verify-*` skill under `.agents/skills`, or the one the user named.
   For each check, collect the property, the covered code, the bounds and assumptions, the command, and the sync commit.
   If no verify skill exists, stop and point to `create-formal-verification-skill`.
   If the skill records no sync commit, use the last commit that changed the verification files and say so.
2. **Run it as it is.** Run each check once before changing anything and record the result.
   Don't decide whether a failure is drift or a bug until step 5.
3. **Read every change to covered code.** Run `git log` and `git diff` on the covered files from the sync commit to `HEAD`, and read each commit message.
   Follow covered functions that were renamed, split, or moved, and find new code that writes the state a check guards.
   Classify each change:
   - **No effect**: it alters nothing the verification describes; check this against the model or harness, not the commit message.
   - **Drift**: the verification no longer describes the code, such as one step becoming two, a branch added or removed, a check moved, or a new path to the guarded state.
   - **Intended promise change**: the doc comment, tests, design document, or commit message says the promise changed; the property must change, and you must cite that evidence.
   - **Possible bug**: the code changed and nothing says the promise changed.
4. **Update from the code, not from the result.** Write the update before rerunning, keep one indivisible step in the code as one step in the verification, and keep the bounds unless the change makes them wrong.
   For a property change, record the old wording, the new wording, and the evidence.
5. **Rerun and judge each result.**
   - **Pass:** break the new code the way the property guards against and confirm the check catches it; then drop the break.
   - **Fail:** replay the counterexample against the code step by step.
     If a step can't happen in the code, fix the verification and say what was wrong.
     If every step can happen, it is a bug: name the commit that introduced it, tell the counterexample in the code's words, and state the harm in one sentence.
     A reproduction against the code may go in the report, not in product code.
6. **Update the verify skill.** Update the coverage, commands, bounds, assumptions, and sync commit.
   Don't move the sync commit for a blocked check.
   Then follow the verify skill once, as the next agent would.

## Report

For each check, tell the user:

- the outcome and the commits you read;
- what changed in the verification and why, with the evidence for each intended promise change;
- the rerun result and the break that shows the updated check can still fail;
- each bug: the counterexample in the code's words, the harm, and the introducing commit;
- what the verification still doesn't cover.

Say which failures were drift and which were bugs.
When a check passed before the update and fails after, say that the old pass described stale code.
Commit the verification updates apart from any product fix.
