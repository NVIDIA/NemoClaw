---
name: security-code-review
description: Performs a comprehensive security review of code changes in a GitHub PR or issue. Checks out the branch, analyzes changed files against a 9-category security checklist, and produces PASS/WARNING/FAIL verdicts. Use when reviewing pull requests for security vulnerabilities, hardcoded secrets, injection flaws, auth bypasses, or insecure configurations. Trigger keywords - security review, code review, appsec, vulnerability assessment, security audit, review PR security.
user_invocable: true
---

# Security Code Review

Perform a thorough security review of the changes in a GitHub PR or issue, producing a structured report with per-category verdicts.

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

## Step 4: Read Every Changed File and Diff

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

- **PASS** — no issues found (brief justification).
- **WARNING** — potential concern (describe risk and suggested fix).
- **FAIL** — confirmed vulnerability (describe impact, severity, and remediation).

### Category 1: Secrets and Credentials

- No hardcoded secrets, API keys, passwords, tokens, or connection strings in code, configs, or test fixtures.
- No secrets committed to version control (check for `.env` files, PEM/key files, credential JSON).
- Tokens and credentials passed via environment variables or secret stores, not string literals.

### Category 2: Input Validation and Data Sanitization

- All user-controlled inputs (APIs, forms, URLs, headers, query params, file uploads) are validated against an allowlist of expected types, lengths, and formats.
- Proper encoding and escaping to prevent XSS, SQL injection, command injection, path traversal, and SSRF.
- Deserialization of untrusted data uses safe parsers (no `pickle.loads`, `yaml.unsafe_load`, `eval`, `new Function`, or similar).

### Category 3: Authentication and Authorization

- All new or modified endpoints enforce authentication before processing requests.
- Authorization logic ensures users can only access or modify resources they own or are permitted to use.
- No privilege escalation paths (horizontal or vertical).
- Token validation (expiry, signature, scope) is correctly implemented.

### Category 4: Dependencies and Third-Party Libraries

- Newly added dependencies checked for known CVEs (OSV, Snyk, GitHub Advisory DB).
- Dependencies pinned to specific, secure versions (no floating ranges in production).
- OSS license compatibility not violated.
- Dependencies pulled from trusted registries only.

### Category 5: Error Handling and Logging

- Error responses do not leak stack traces, internal paths, or sensitive data.
- Logging does not record secrets, tokens, passwords, or PII.
- Exceptions caught at appropriate boundaries; no unhandled crashes that expose state.

### Category 6: Cryptography and Data Protection

- Standard, up-to-date algorithms (AES-256-GCM, RSA-2048+, SHA-256+).
- No MD5 or SHA-1 for security purposes. No custom cryptography.
- Sensitive data encrypted at rest and in transit where applicable.

### Category 7: Configuration and Security Headers

- Secure defaults (debug mode off, restrictive permissions, minimal port exposure).
- If HTTP endpoints are present: CSP and CORS configured correctly. No wildcard origins in authenticated contexts.
- Container images use non-root users, minimal base images, and pinned digests.

### Category 8: Security Testing

- Tests cover security edge cases: malicious input, boundary values, unauthorized access attempts.
- Existing security test coverage not degraded by the change.
- Negative test cases verify that forbidden actions are denied.

### Category 9: Holistic Security Posture

- Changes do not degrade overall security posture.
- No false sense of security (client-only validation, incomplete checks).
- Least privilege followed for code, services, and users.
- No TOCTOU race conditions in security-critical paths.
- No unsafe concurrency that bypasses security checks.

## Step 6: Produce the Report

Structure the output as follows:

### Verdict

One paragraph summarizing the overall risk assessment and whether the PR is safe to merge.

### Findings Table

One row per finding:

| # | Category | Severity | File:Line | Description | Recommendation |
|---|----------|----------|-----------|-------------|----------------|

If no findings, state explicitly that the review is clean.

### Detailed Analysis

Per-category breakdown (categories 1 through 9), each with its PASS, WARNING, or FAIL verdict and justification.

### Files Reviewed

List every file analyzed.

## Important Notes

- If the PR has no changed files or is a draft with no code, state that and skip the analysis.
- For NemoClaw PRs, pay special attention to sandbox escape vectors: SSRF bypasses, Dockerfile injection, network policy circumvention, credential leakage, and blueprint tampering.
- Do not skip categories. If a category is not applicable to the changes (e.g., no cryptography involved), mark it PASS with "Not applicable — no cryptographic operations in this change."
- When in doubt about severity, err on the side of WARNING rather than PASS.
