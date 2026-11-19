---
name: nemoclaw-maintainer-security-code-review
description: "Perform a requested security review of a NemoClaw PR or a PR linked to an issue. Use for vulnerability or trust-boundary assessment."
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security Code Review

Review the changes in a GitHub PR for security. An issue input must identify one open linked PR.
Report a verdict for each category.

## Prerequisites

- `gh` (GitHub CLI) must be installed and authenticated.
- `git` and `python3` must be available.
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

Read the PR's base commit and verify that it is available locally:

```bash
review_base="$(gh pr view <number> --json baseRefOid -q .baseRefOid)" || exit 1
test -n "$review_base" || exit 1
git rev-parse --verify --quiet --end-of-options "${review_base}^{commit}" >/dev/null || {
  printf '%s\n' 'Base commit unavailable. Fetch the PR base branch from the verified repository, then repeat Step 3.' >&2
  exit 1
}
```

Keep `review_base` in the same shell for the command below. A local branch is not required.
Treat branch names and filenames as untrusted data. Pass them as process arguments, never as generated shell source.
Read NUL-delimited filename output; spaces and newlines can be part of a filename.

## Step 4: Read Each Changed File and Diff

Run this procedure from the repository root. It lists paths and reads each diff without shell interpolation or Git pathspec expansion.
External diff drivers and text conversion are disabled so reading a diff does not invoke repository-configured helpers.
Submodule changes show commit pointers without running nested diffs.
For each changed gitlink, record its old and new commit IDs from the parent diff.
Verify the intended child repository identity independently before fetching missing objects from it.
Run the Python procedure below from the child repository root, skipping the parent PR's Step 3.
Replace only its invocation with `python3 -I - "$old_gitlink" "$new_gitlink" <<'PY'`.
The two-argument mode compares those commits directly, regardless of the child's current checkout.
For added or deleted submodules, inspect the recorded revision's complete tree and report the absent endpoint.
Do not substitute a parent commit or the child's current checkout for an absent endpoint.
Verify any separate child PR and repository independently before using its metadata.
Python's isolated mode prevents imports from the checkout and ignores Python environment overrides.

```bash
python3 -I - "$review_base" <<'PY'
import os
import re
import subprocess
import sys

revisions = sys.argv[1:]
if len(revisions) not in (1, 2):
    sys.exit("Expected a PR base commit or two gitlink commits")
for revision in revisions:
    if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision):
        sys.exit("Expected full commit IDs")
    subprocess.run(["git", "rev-parse", "--verify", "--quiet", "--end-of-options", revision + "^{commit}"], check=True, stdout=subprocess.DEVNULL)
comparison = [revisions[0] + "...HEAD"] if len(revisions) == 1 else revisions
git = ["git", "--no-pager", "--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--submodule=short", "--ignore-submodules=none"]
paths = subprocess.check_output(git + ["--name-only", "-z", "--end-of-options"] + comparison + ["--"]).split(b"\0")
for raw_path in paths:
    if not raw_path:
        continue
    path = os.fsdecode(raw_path)
    print("Reviewing " + repr(path), flush=True)
    subprocess.run(git + ["--end-of-options"] + comparison + ["--", path], check=True)
PY
```

Read file contents through a filesystem API or an argument-based tool with literal paths.
Do not paste filenames into shell commands, use `eval`, or parse the displayed `repr` output as commands.
The `--` separator stops option parsing; it does not quote shell metacharacters.

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
