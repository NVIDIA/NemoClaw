---
name: interrogate
description: Have several independent agents try to break a change, design, or specification, and keep only the findings a run proves. Use when asked to interrogate, stress-test, or find blind spots.
disable-model-invocation: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-FileCopyrightText: Copyright (c) 2026 Lauren Tan -->
<!-- SPDX-License-Identifier: Apache-2.0 AND MIT -->
<!-- Adapted from pstack's interrogate skill; see ../NOTICE.md. -->

# Interrogate

Adversaries try to break a change or a design.
A finding survives only when a run proves it.
Report the findings; don't apply fixes.

## Frame

- The scope is what the user names.
  Otherwise it is the branch diff from its merge base with `v1`, through the working tree.
- An issue is a design: read its body, every comment, and its sub-issues.
  Later decisions supersede earlier text, so state which text you treat as current.
- Restate in your own words what the user wants and which problem the scope solves, from the user's message, the commits, and the pull request or issue.
  Ask the user when the intent is unclear.
- List the upstream versions the scope depends on, from `versions.json`, the image catalog, or `Cargo.lock`, so adversaries probe what NemoClaw ships rather than the latest release.

## Fan Out

Run two to four adversaries, each in its own agent session and Git worktree.
Create each worktree outside the checkout, such as `../NemoClaw-worktrees/interrogate-<topic>-<n>`, at the scope's commit, and copy in the scope's uncommitted changes.
Use different model families when your harness offers them.
Give each adversary the scope, the intent, the versions, and this brief:

> Break this change.
> Prove each finding with a run against the code or the pinned upstream versions, such as a failing test, a reproduction script, or command output that shows the wrong behavior.
> For a design or specification, run a prototype, probe the current tree, or run the pinned upstream component.
> Try at least these: stop it at each step and run it again; give the same state two writers; take the person's next action after each failure.
> Keep reproductions in your own worktree.
> Create only live resources you own, as [live tests](../../../docs/contributing/live-tests.md) describe, and remove them when you finish.
> Ask before runs that need credentials, paid services, or GPUs.
> Don't push, open pull requests, or comment on issues.
> Report each finding with a title, the exact command, the output it printed, and the output the intent requires.
> Leave out anything you did not run, including style, naming, structure, and risks that need a future change to matter.
> No findings is a valid result.

If an adversary produces nothing, continue with the rest and say so.

## Verify

- Rerun each finding's command yourself.
  Keep a finding when the output shows the failure and the failure breaks the intent; drop the rest.
- Merge findings that share a root cause.
  Keep every verified finding, not one adversary's list.
- Apply the [upstream boundaries](../../../docs/design/scope.md#upstream-boundaries) to each finding and name the component that owns it.

## Report

- **Intent**: the restatement and the text you treated as current.
- **Findings**: for each verified finding, the command, its output, how it breaks the intent, the adversaries that found it, and the owning component.
  Say "no verified findings" when none survive.
- **Dropped**: for each adversary, the count of dropped findings and why.
- **Cleanup**: the worktrees and live resources you created and whether you removed them.

Ask before posting the report on an issue or pull request.
