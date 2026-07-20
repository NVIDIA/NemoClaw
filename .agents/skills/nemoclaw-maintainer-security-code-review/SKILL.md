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

## Step 5: Analyze Against the Security Checklist

For each of the nine categories, assign a verdict:

- Use **PASS** when you find no issue. Give a short reason.
- Use **WARNING** for a concern. Describe the risk and fix.
- Use **FAIL** for a vulnerability. Describe its impact, severity, and fix.

### Category 1: Secrets and Credentials

- No hardcoded secrets, API keys, passwords, tokens, or connection strings in code, configs, or test fixtures.
- No secrets committed to version control (check for `.env` files, PEM/key files, credential JSON).
- Pass tokens and credentials through environment variables or secret stores. Do not put them in string literals.

### Category 2: Input Validation and Data Sanitization

- Validate each user-controlled input. Allow only the required type, length, and format.
- Encode and escape inputs to prevent XSS, SQL injection, command injection, path traversal, and SSRF.
- Use safe parsers for untrusted data (no `pickle.loads`, `yaml.unsafe_load`, `eval`, `new Function`, or similar).

### Category 3: Authentication and Authorization

- Require authentication before a new or changed endpoint processes a request.
- Allow users to access or modify only resources they own or may use.
- Prevent horizontal and vertical privilege escalation.
- Verify token expiry, signature, and scope.

### Category 4: Dependencies and Third-Party Libraries

- Check new dependencies for known CVEs (OSV, Snyk, GitHub Advisory DB).
- Pin production dependencies. Do not use floating ranges.
- Confirm that each dependency has a compatible open-source license.
- Use trusted registries.

### Category 5: Error Handling and Logging

- Do not leak stack traces, internal paths, or sensitive data in errors.
- Do not log secrets, tokens, passwords, or PII.
- Catch exceptions where callers can handle them. Do not expose state through crashes.

### Category 6: Cryptography and Data Protection

- Use current standard algorithms (AES-256-GCM, RSA-2048+, SHA-256+).
- No MD5 or SHA-1 for security purposes. No custom cryptography.
- Encrypt sensitive data at rest and in transit where needed.

### Category 7: Configuration and Security Headers

- Disable debug mode, restrict permissions, and expose only needed ports.
- Set CSP and CORS for HTTP endpoints. Do not allow wildcard origins for authenticated requests.
- Run container images as non-root users with minimal base images and pinned digests.

### Category 8: Security Testing

- Test malicious input, boundary values, and unauthorized access attempts.
- Do not reduce existing security test coverage.
- Verify that the system denies forbidden actions.

### Category 9: System Security

- Check whether the change weakens an existing security control.
- Do not rely on client-only validation or incomplete checks.
- Use least privilege for code, services, and users.
- Prevent TOCTOU race conditions in security-critical paths.
- Prevent concurrency from bypassing security checks.

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
