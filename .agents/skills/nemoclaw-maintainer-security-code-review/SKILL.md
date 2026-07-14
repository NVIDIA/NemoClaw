---
name: nemoclaw-maintainer-security-code-review
description: Reviews code changes in a GitHub PR or issue for security. Checks changed files against nine categories and reports PASS/WARNING/FAIL verdicts. Use when reviewing pull requests for security vulnerabilities, hardcoded secrets, injection flaws, auth bypasses, or insecure configurations. Trigger keywords - security review, code review, appsec, vulnerability assessment, security audit, review PR security.
user_invocable: true
---

# Security Code Review

Review the changes in a GitHub PR or issue for security. Report a verdict for each category.

## Prerequisites

- `gh` (GitHub CLI) must be installed and authenticated.
- `git` must be available.
- Network access to clone repositories and fetch PR metadata.

## When to Use

- Reviewing a pull request before merge for security vulnerabilities.
- Triaging a GitHub issue that reports a potential security flaw.
- Auditing code changes for hardcoded secrets, injection flaws, auth bypasses, or insecure configurations.

## Step 1: Parse the GitHub URL

If the user provided a PR or issue URL, extract the owner, repo, and number. If not, ask for one.

Supported URL formats:

- `https://github.com/OWNER/REPO/pull/NUMBER`
- `https://github.com/OWNER/REPO/issues/NUMBER`

## Step 2: Check Out the Code

Determine whether you are already in the target repository (compare `gh repo view --json nameWithOwner -q .nameWithOwner` against the URL). If you are:

```bash
gh pr checkout <number>
```

If reviewing a different repo, clone it to a temporary directory first:

```bash
TMPDIR=$(mktemp -d)
gh repo clone OWNER/REPO "$TMPDIR"
cd "$TMPDIR"
gh pr checkout <number>
```

## Step 3: Identify Changed Files

List all files changed relative to the base branch:

```bash
git diff main...HEAD --name-status
```

If the PR targets a branch other than `main`, use the correct base. Check with:

```bash
gh pr view <number> --json baseRefName -q .baseRefName
```

## Step 4: Read Each Changed File and Diff

Read the full content of each changed file and the diff for that file:

```bash
git diff main...HEAD -- <file>
```

For large PRs (more than 30 changed files), prioritize files in this order:

1. Files that handle authentication, authorization, or credentials.
2. Files that process user input (API handlers, CLI argument parsing, URL parsing).
3. Configuration files (Dockerfiles, YAML policies, environment configs).
4. New dependencies (package.json, requirements.txt, go.mod changes).
5. Everything else.

## Step 5: Analyze Against the Security Checklist

For each of the 9 categories below, assign a verdict:

- **PASS** — no issues found (give a brief reason).
- **WARNING** — a concern (describe the risk and fix).
- **FAIL** — a vulnerability (describe the impact, severity, and fix).

### Category 1: Secrets and Credentials

- No hardcoded secrets, API keys, passwords, tokens, or connection strings in code, configs, or test fixtures.
- No secrets committed to version control (check for `.env` files, PEM/key files, credential JSON).
- Tokens and credentials passed via environment variables or secret stores, not string literals.

### Category 2: Input Validation and Data Sanitization

- Validate user-controlled inputs (APIs, forms, URLs, headers, query params, file uploads) against an allowlist of types, lengths, and formats.
- Encode and escape inputs to prevent XSS, SQL injection, command injection, path traversal, and SSRF.
- Use safe parsers for untrusted data (no `pickle.loads`, `yaml.unsafe_load`, `eval`, `new Function`, or similar).

### Category 3: Authentication and Authorization

- Authenticate new or modified endpoints before processing requests.
- Allow users to access or modify only resources they own or may use.
- Prevent horizontal and vertical privilege escalation.
- Verify token expiry, signature, and scope.

### Category 4: Dependencies and Third-Party Libraries

- Check new dependencies for known CVEs (OSV, Snyk, GitHub Advisory DB).
- Pin production dependencies; do not use floating ranges.
- Preserve OSS license compatibility.
- Use trusted registries.

### Category 5: Error Handling and Logging

- Do not leak stack traces, internal paths, or sensitive data in errors.
- Do not log secrets, tokens, passwords, or PII.
- Catch exceptions where callers can handle them; do not expose state through crashes.

### Category 6: Cryptography and Data Protection

- Use current standard algorithms (AES-256-GCM, RSA-2048+, SHA-256+).
- No MD5 or SHA-1 for security purposes. No custom cryptography.
- Encrypt sensitive data at rest and in transit where needed.

### Category 7: Configuration and Security Headers

- Disable debug mode, restrict permissions, and expose only needed ports.
- For HTTP endpoints, set CSP and CORS. Do not use wildcard origins in authenticated contexts.
- Run container images as non-root users with minimal base images and pinned digests.

### Category 8: Security Testing

- Test malicious input, boundary values, and unauthorized access attempts.
- Do not reduce existing security test coverage.
- Test that forbidden actions are denied.

### Category 9: Holistic Security Posture

- Do not weaken the system's security.
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

If no findings, state explicitly that the review is clean.

### Detailed Analysis

For each category, give its PASS, WARNING, or FAIL verdict and reason.

### Files Reviewed

List every file analyzed.

## Important Notes

- If the PR has no changed files or is a draft with no code, state that and skip the review.
- For NemoClaw PRs, check sandbox escape vectors: SSRF bypasses, Dockerfile injection, network policy circumvention, credential leakage, and blueprint tampering.
- Do not skip categories. If a category is not applicable to the changes (e.g., no cryptography involved), mark it PASS with "Not applicable — no cryptographic operations in this change."
- When in doubt about severity, err on the side of WARNING rather than PASS.
