<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Relationship Judgment

Use this process to classify each candidate issue. This is the only step that requires model judgment.

## Contents

- Inputs to the model
- The prompt
- Evidence requirement
- Confidence levels
- Reverse-link boost

## Inputs to the model

- PR diff (limit: 3000 characters)
- PR description body
- PR's linked issue number for the SAME_ISSUE_DIFF check
- Candidate issue number, title, and body (limit: 2000 characters)
- First five candidate-issue comments

## The prompt

```text
Judge whether this PR's changes affect the open issue.

PR #{pr_number}: {pr_title}
PR description: {pr_body}
PR diff (relevant slice): {diff}

Candidate issue #{issue_number}: {issue_title}
Issue body: {issue_body}
First five issue comments:
{candidate_comments}

PR's primary linked issue: #{primary_issue}

Classify the relationship:

- ADJACENT_FIX: The PR resolves this issue or enables follow-up work on the changed code.
- CONTRADICTING: The PR prevents the requested behavior or leaves another instance of the bug.
- SAME_ISSUE_DIFF: same root bug as #{primary_issue} (dedupe filter)
- UNRELATED: no meaningful relationship

For ADJACENT_FIX or CONTRADICTING, cite one of these evidence types:

  (a) DIRECT: Cite PR diff lines and the issue symptoms that those lines affect.

  (b) BY-OMISSION: Name the bug class and the instances that the PR fixes.
      Name the unchanged instances that the issue reports.

  (c) FOLLOW-ON: Cite the changed symbol or file.
      Cite the issue request about that symbol or file.

Confidence: high / medium / low

If you cannot cite one of these evidence types, answer UNRELATED.
```

## Evidence requirement

For each ADJACENT_FIX or CONTRADICTING result, cite one of these evidence types:

- **Direct:** A PR diff line and the issue symptom that it affects.
- **By omission:** The bug class that the PR changes and an unchanged instance of that bug in the issue.
- **Follow-on:** A changed symbol or file and an issue request about that symbol or file.

Without this evidence, classify the issue as UNRELATED.

This rule prevents unsupported matches based only on a shared code area.

## Confidence levels

- **high:** The cited PR change affects the cited issue symptom.
- **medium:** The evidence is incomplete, but the change affects the related code.
- **low:** The result depends on an inference. The default confidence threshold removes it.

## Reverse-link boost

If the issue body or comments mention the PR number, increase confidence by one level:

- low → medium
- medium → high
- high → high

After classification, check the issue body and comments for the PR number.
If the number occurs, increase the confidence.

## Search and classification

Token matching finds candidates. These checks remove unsupported matches:

1. **Relationship judgment:** Check whether the issue describes the changed behavior.
2. **Evidence requirement:** Cite the related lines and symptoms.

The PR-number check increases confidence when the issue already links the PR.
