---
name: nemoclaw-maintainer-security-code-review
description: Review a PR, or a PR linked to an issue, for security risks. Check nine categories and report PASS, WARNING, or FAIL. Use when reviewing code for vulnerabilities, secrets, injection, authorization bypasses, or unsafe configuration. Trigger keywords - security review, code review, appsec, vulnerability assessment, security audit, review PR security.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security Code Review

Review the changes in a GitHub PR for security. An issue input must identify one open linked PR.
Report a verdict for each category.

## Prerequisites

- `gh` (GitHub CLI) must be installed and authenticated.
- `git` must be available.
- Network access to clone repositories and fetch PR metadata.

## Step 1: Parse the GitHub URL

If the user gives a PR or issue URL, extract the owner, repository, and number.
Otherwise, ask for the URL.

Supported URL formats:

- `https://github.com/OWNER/REPO/pull/NUMBER`
- `https://github.com/OWNER/REPO/issues/NUMBER`

For a PR URL, verify the number before Step 2:

```bash
gh pr view <number> --repo OWNER/REPO --json number,url
```

For an issue URL, list its open closing PRs:

```bash
gh issue view <number> --repo OWNER/REPO --json closedByPullRequestsReferences \
  --jq '.closedByPullRequestsReferences | map(select(.state == "OPEN")) | .[].number'
```

Continue only when this returns one PR number, and verify that number with `gh pr view`.
If it returns zero or more than one, stop and ask for the PR URL.
Use the verified PR number in each later command.

## Step 2: Check Out the Code

Compare `gh repo view --json nameWithOwner -q .nameWithOwner` with the URL.
If the repositories match, check out the verified PR:

```bash
gh pr checkout <number>
```

If the repositories do not match, clone the target to a temporary directory:

```bash
REVIEW_DIR=$(mktemp -d)
gh repo clone OWNER/REPO "$REVIEW_DIR"
cd "$REVIEW_DIR"
gh pr checkout <number>
```

## Step 3: Identify Changed Files

List all files changed from the base branch:

```bash
git diff main...HEAD --name-status
```

If the PR targets another branch, use that branch as the base. Check it with:

```bash
gh pr view <number> --json baseRefName -q .baseRefName
```

## Step 4: Read Each Changed File and Diff

Read each changed file. Read its diff:

```bash
git diff main...HEAD -- <file>
```

If a PR changes more than 30 files, review them in this order:

1. Files that handle authentication, authorization, or credentials.
2. Files that process user input (API handlers, CLI argument parsing, URL parsing).
3. Configuration files (Dockerfiles, YAML policies, environment configs).
4. New dependencies (package.json, requirements.txt, go.mod changes).
5. Everything else.

## Step 5: Analyze Against the Security Rubric

Read the canonical [Security Rubric](../_shared/security-rubric.md). Independently evaluate the
completed change against every category, including its trust-boundary questions and expected
evidence. Do not rely on planning or implementation conclusions as review evidence.

For each of the nine categories, assign a verdict:

- Use **PASS** when you find no issue. Give a short reason.
- Use **WARNING** for a concern. Describe the risk and fix.
- Use **FAIL** for a vulnerability. Describe its impact, severity, and fix.

## Step 6: Produce the Report

Structure the output as follows:

### Verdict

One paragraph summarizing the risk and whether the PR is safe to merge.

### Findings Table

One row per finding:

| # | Category | Severity | File:Line | Description | Recommendation |
|---|----------|----------|-----------|-------------|----------------|

If there are no findings, state that the review found none.

### Detailed Analysis

For each category, give its PASS, WARNING, or FAIL verdict and reason.

### Files Reviewed

List every file analyzed.

## Important Notes

- If the PR has no changed files, state that result and stop the review.
- If no changed or reviewable security surface exists, state that result and stop the review.
- Review security surfaces in drafts, including Dockerfiles, workflows, network policies, blueprints, dependencies, and security configuration.
- For NemoClaw PRs, check SSRF bypasses, Dockerfile injection, network-policy bypasses, credential leaks, and blueprint changes.
- Do not skip a category. If a category does not apply, mark it PASS and state why.
- If severity is uncertain, use WARNING instead of PASS.
