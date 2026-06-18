---
name: mcore-create-issue
description: Investigate a failing GitHub Actions run or job and create a GitHub issue for the failure.
license: Apache-2.0
when_to_use: User shares a GitHub Actions URL and wants to file a bug report; 'create an issue for this failure', 'file a bug for this CI run', 'triage this GitHub Actions failure'.
user_invocable: true
argument: "GitHub Actions run or job URL"
metadata:
  author: Philip Petrakian <ppetrakian@nvidia.com>
---

# Triage CI Failure into a GitHub Issue

Investigate a failing GitHub Actions job, extract the root cause, and file a
well-structured bug issue against `NVIDIA/Megatron-LM`.

## Workflow

### 1. Parse the URL

The argument is a GitHub Actions URL. It will be one of:

- **Job URL**: `https://github.com/<owner>/<repo>/actions/runs/<run_id>/job/<job_id>`
- **Run URL**: `https://github.com/<owner>/<repo>/actions/runs/<run_id>`

Extract `run_id` and, if present, `job_id`.

### 2. Identify failed jobs

- If a `job_id` was provided, use that job directly.
- If only a `run_id` was provided, list all failed jobs in the run:

  ```bash
  gh run view <run_id> --repo NVIDIA/Megatron-LM --json jobs \
    --jq '[.jobs[] | select(.conclusion == "failure") | {id: .databaseId, name: .name, url: .url}]'
  ```

  If multiple jobs failed, ask the user which one to triage, or triage all of them if they say so.

### 3. Fetch the failure logs

For each failed job, retrieve the logs and narrow them down to the failure:

```bash
# Pull the raw log and keep only error-bearing lines
gh api repos/NVIDIA/Megatron-LM/actions/jobs/<job_id>/logs 2>&1 \
  | grep -E "(FAILED|ERROR|\bError\b|assert|Traceback|Exception|##\[error\])" \
  | head -200
```

Also capture the full job name:

```bash
gh run view --job <job_id> --repo NVIDIA/Megatron-LM --json name --jq .name
```

If the grep output is sparse, download the full logs and look for the pytest
`FAILURES` section or the last non-zero exit signal.

### 4. Resolve the triggering PR and test author

**Triggering PR**: the run's head branch follows the pattern `pull-request/<number>`.
Extract it and resolve the PR:

```bash
gh run view <run_id> --repo NVIDIA/Megatron-LM --json headBranch --jq .headBranch
# → e.g. "pull-request/4332"
# Extract PR number and fetch metadata:
gh pr view <pr_number> --repo NVIDIA/Megatron-LM --json number,title,url \
  --jq '{number: .number, title: .title, url: .url}'
```

**Test file author**: find the GitHub login of whoever last touched the failing
test file. The file may not exist on `main` — first determine the PR's base
branch, then search from there:

```bash
# 1. Get the PR's base branch (e.g. "main", "dev", "release/X.Y")
gh pr view <pr_number> --repo NVIDIA/Megatron-LM --json baseRefName --jq .baseRefName

# 2. Search commits on that base branch
gh api "repos/NVIDIA/Megatron-LM/commits?path=<test-file-path>&sha=<base-branch>&per_page=1" \
  --jq '.[0] | {login: .author.login, name: .commit.author.name, sha: .sha}'
```

If the result is empty (file was introduced by the PR itself), query the PR's
commits instead:

```bash
gh api "repos/NVIDIA/Megatron-LM/pulls/<pr_number>/commits" \
  --jq '[.[] | select(.files? // [] | any(.filename == "<test-file-path>"))] | .[0].author.login'
```

As a last resort, list the PR commits and pick the author of the commit whose
message most closely relates to the failing test file.

### 5. Extract the root cause

From the logs, identify:

- **Failed test(s)**: lines matching `FAILED tests/...::...` give the exact pytest node IDs.
- **Error message**: the assertion failure, exception type, or first meaningful
  traceback frame — keep it under ~30 lines.
- **Job name**: the GitHub Actions job name (e.g. `tests/unit_tests/transformer/moe/**/*.py - latest`).
- **Run / job URLs** and **PR URL**: for linking in the issue.

### 6. Check for duplicate issues

Search for open issues that already cover the same test:

```bash
gh issue list --repo NVIDIA/Megatron-LM \
  --state open \
  --search "<failed-test-filename>" \
  --json number,title,url \
  --limit 10
```

- If a matching open issue exists, **do not create a new one**. Report the
  existing issue to the user and stop.
- If no match is found, proceed to file a new issue.

### 7. Create the issue

Pass `--assignee <test-author-login>` to assign the issue to the test file's
author. Include the triggering PR URL in the issue body.

```bash
gh issue create \
  --repo NVIDIA/Megatron-LM \
  --title "🐛 CI failure: <failed-test-node-id>" \
  --label "bug" \
  --assignee "<test-author-login>" \
  --body "..."
```

Use the bug-report template body structure:

```markdown
**Describe the bug**

CI test `<failed-test-node-id>` failed in job [`<job-name>`](<job-url>).
Tag @NVIDIA/mcore-oncall to get oncall's attention to this issue.

**Failing run**

| Field | Value |
|-------|-------|
| PR    | [#<pr_number>: <pr_title>](<pr_url>) |
| Run   | [<run_id>](<run_url>) |
| Job   | [<job_name>](<job_url>) |

**Error**

```
<core error message / traceback — 30 lines max>
```

**Steps/Code to reproduce bug**

Re-run the failing CI job linked above, or locally inside the dev container:

```bash
pytest <failed-test-node-id>
```

**Additional context**

Triaged automatically via `/triage-issue`.
```

If multiple tests failed in the same job, list each one as a separate bullet
under "Describe the bug" and include the combined error snippets. Assign the
issue to the author of whichever test file appears first in the failure list.

### 8. Report back to the user

Print the URL of the newly created issue (or the duplicate, if found) so the
user can review or share it.

## Important guidelines

- Never create an issue if a duplicate already exists — link the existing one instead.
- Always include the triggering PR link in the issue body.
- Always assign the issue to the test file's most recent author. If the author
  lookup fails (e.g. the commit was made by a bot or the login is unavailable),
  skip `--assignee` and note it in the "Additional context" section.
- Keep the error snippet concise (≤30 lines). Truncate long tracebacks and note that the full log is available via the job URL.
- Do not guess the root cause — quote the actual log output verbatim.
- If the job is still in progress or the logs are unavailable, say so and ask the user to retry once the run completes.
