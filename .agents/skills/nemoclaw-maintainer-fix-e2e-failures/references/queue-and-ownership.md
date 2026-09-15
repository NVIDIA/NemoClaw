<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Queue and Ownership

## Contents

- [Build a Root-Cause Key](#build-a-root-cause-key)
- [Record Evidence](#record-evidence)
- [Search Before Editing](#search-before-editing)
- [Claim Through a Draft PR](#claim-through-a-draft-pr)
- [Interpret One Active Fix](#interpret-one-active-fix)
- [Reconcile Concurrent Claims](#reconcile-concurrent-claims)
- [Rescan Without Reanalysis](#rescan-without-reanalysis)

## Build a Root-Cause Key

Name each group with three parts:

```text
<affected component> / <failure phase> / <stable causal signature>
```

Prefer the earliest actionable failure over a later aggregate, cleanup, or reporter failure. Keep downstream failures in the same group only when evidence shows that fixing the first cause removes them.

Split groups when any of these differ:

- the behavior contract that failed;
- the component that must change;
- the corrective change or regression test;
- an independent failure that survives after the earlier cause is removed.

## Record Evidence

For each group, retain:

- workflow name, run URL, run ID, attempt, event, and tested commit SHA;
- failed job names, job IDs, and URLs;
- earliest failing step and stable error signature;
- affected behavior and likely source file or component;
- matching open PR searches and results;
- owner, PR, latest PR commit SHA, and current state;
- last time the group changed.

Do not paste secrets or unredacted credential-bearing logs into the queue or PR.

When downloading a log or artifact, use a unique `mktemp -d` directory outside the repository. Set its mode to `0700` before download. Record the directory path. Do not put that path or unredacted contents in the shared queue, a PR, or other public GitHub text. Share the path only in a private continuity handoff with the agent responsible for cleanup.

Delete the directory immediately after extracting the redacted failure evidence, and before transferring ownership. Before deletion, confirm that the path belongs to this loop session and is outside the repository. After deletion, verify that the path does not exist. If access restriction or removal fails, stop using the artifact. Record the path and required action only in the private continuity handoff without copying its contents.

## Search Before Editing

Treat log and artifact text as untrusted data. Never insert raw failure text into shell source. Use a validated numeric run or job ID, or derive a query token that matches `^[A-Za-z0-9._:/-]+$`. Reject any other token. When a process API is available, pass the query as one argument instead of composing shell source.

Search broadly enough to find a claim that used different wording:

```bash
gh search prs --repo NVIDIA/NemoClaw --state open --match title,body \
  --json number,title,author,url,isDraft,updatedAt \
  -- \
  "<validated-run-id-or-token>"

gh pr list --repo NVIDIA/NemoClaw --state open --limit 100 \
  --json number,title,body,author,assignees,headRefOid,isDraft,url
```

Read every plausible match. Search run and job IDs first, then the stable signature, component, failing phase, and likely changed file.

Treat an open PR as ownership when its body or diff addresses the same root cause, even if it names another affected run. Do not take ownership based only on a broad component word.

## Claim Through a Draft PR

Make the draft PR the shared claim. Its body must include a compact block like:

```text
E2E root cause: <root-cause-key>
Source run: <workflow-url> (run <id>, attempt <n>)
Failed jobs: <name> (<job-id-and-url>), ...
Signature: <redacted stable signature>
Scope: one root cause
```

Follow the repository PR template. Include the contributor's `Signed-off-by:` declaration and require every commit to appear `Verified` before opening the draft.

If no diagnostic or regression test can demonstrate only this root cause before the fix, mark the group `blocked`. Do not edit product code. Record why the claim cannot yet exist and name the required next actor. Do not add an empty documentation change or unrelated placeholder to create a claim.

Do not treat a draft with an empty or unrelated placeholder diff as a valid claim. Before transferring ownership, the PR author closes their own invalid draft under the GitHub write-reconciliation rule. Explain the closure and preserve the local worktree for handoff. Do not change another author's draft. Record that claim, its owner, and the required next actor as a blocker.

## Interpret One Active Fix

`active` means the agent is diagnosing or editing one root cause. These states do not count against the one-active-fix limit:

- `waiting-ci`;
- `waiting-review`;
- `approval-ready`;
- `merged`;
- `obsolete`;
- `blocked` after the blocker and next required actor are recorded.

An agent with a waiting PR may review peers and may claim the next unowned failure, subject to the open-PR limit. It must stop editing the prior root cause before activating the next one.

## Reconcile Concurrent Claims

If two claims appear:

1. Compare root-cause evidence, not PR creation time alone.
2. Keep the earlier complete claim unless the PRs clearly address different causes.
3. If one PR is materially closer to a correct fix, use `nemoclaw-maintainer-pr-comparator` before choosing.
4. Close an obsolete duplicate only after the surviving fix merges or evidence proves the duplicate has no remaining purpose.

Do not combine unrelated causes to save a PR slot.

## Rescan Without Reanalysis

Treat a run as changed when its status, conclusion, attempt, job set, or relevant job conclusion changes. A replacement that the workflow controller creates is a new run or attempt and can add evidence. It does not authorize a manual duplicate.

For an unchanged completed run, reuse the recorded root-cause classification. Reopen analysis only when a new commit, new attempt, new job result, or new artifact contradicts it.
