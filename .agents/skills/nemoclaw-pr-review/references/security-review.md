### Step 4: Security Review

NemoClaw's security model has multiple layers. Verify changes respect all of them:

#### Build-Time Security (Dockerfile)
- `openclaw.json` is root-owned mode 444, verified by SHA-256 hash at startup
- No ARG interpolation into Python source (C-2 injection vector)
- Build args must be promoted to ENV vars before Python RUN layers
- Pin package versions in security-hardening PRs

#### Runtime Security (nemoclaw-start.sh)
- Config integrity hash verified before anything starts
- Gateway runs as `gateway` user (not `sandbox` user) — process isolation
- PATH is hardened to prevent binary injection
- Capabilities are dropped via `capsh`
- Symlinks in `.openclaw` are validated and made immutable via `chattr +i`

#### Network Security (policies/)
- SSRF validation in `nemoclaw/src/blueprint/ssrf.ts`
- Sandbox network policies control egress
- `deny` entries must take precedence over broader `read_only` grants

#### Auto-Pair Security
- `clientId`/`clientMode` are **client-supplied and spoofable** — allowlists are defense-in-depth, not trust boundaries
- The gateway stores `connectParams.client.id` verbatim with no server-side validation
- Real identity validation requires changes in the openclaw gateway itself

#### CI/CD Workflow Security (`.github/workflows/*.yaml`)

Workflows are a first-class part of the security surface. Any PR that adds or modifies a workflow must be reviewed with the same rigor as sandbox runtime code — arbitrary code execution in a secrets-bearing job is as bad as a sandbox escape.

**The trusted-code boundary rule.** A workflow job has two inputs:
1. **Code it executes** (action steps, scripts invoked by `run:`, npm packages it installs)
2. **Data it operates on** (the PR diff, issue text, user-supplied inputs)

If the job has **secrets in scope** (API keys, `GITHUB_TOKEN` with write perms, deploy creds), the **code it executes must come from a trusted ref** (typically `main`, a release tag, or an explicitly pinned trusted SHA). The **data** can come from the PR checkout — but only as inert bytes the trusted code reads.

**The anti-pattern to flag as 🔴 BLOCKER:**

```yaml
on:
  pull_request:          # ← fires on same-repo and (sometimes) fork PRs
jobs:
  analyze:
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}   # ← untrusted code
      - run: npm install -g some-tool                      # ← unpinned
      - run: node tools/advisor/analyze.mjs                # ← runs PR's copy
        env:
          API_KEY: ${{ secrets.PI_API_KEY }}               # ← secret in scope
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}        # ← write token
```

A future same-repo PR (or a maintainer-approved fork PR) can modify `tools/advisor/analyze.mjs` itself and execute arbitrary Node in a secrets-bearing context. This is the GitHub Actions equivalent of the classic "pwn request" / confused-deputy pattern. `pull_request_target` has the same hazard if combined with a head-SHA checkout and script invocation.

**Acceptable patterns:**

1. **Two-stage checkout** — advisor/tool code from a trusted ref, PR code as inert data:
   ```yaml
   - uses: actions/checkout@v4
     with:
       ref: main                    # trusted code
       path: advisor
   - uses: actions/checkout@v4
     with:
       ref: ${{ github.event.pull_request.head.sha }}
       path: pr-workdir             # inert data only
   - run: node advisor/tools/e2e-advisor/agent-analyze.mjs --workdir pr-workdir
     env:
       API_KEY: ${{ secrets.PI_API_KEY }}
   ```

2. **Split the workflow** — untrusted, no-secrets job uploads an artifact; a separate `workflow_run`-triggered job from `main` consumes the artifact with secrets in scope.

3. **Run with no secrets** — if the analysis truly doesn't need credentials, don't attach any, and fail closed if creds are somehow present.

**Supply-chain pinning in secret-bearing jobs.** Any `npm install`, `pip install`, `curl | sh`, `uv tool install`, or similar in a job that has secrets attached must be **pinned to an exact version** (and ideally a hash). Unpinned installs turn any future compromised publish into code execution against your secrets.

- ❌ `npm install -g <agent-package>`
- ✅ `npm install -g <agent-package>@0.73.1`
- ✅ better: `npm ci` from a committed lockfile, or `actions/setup-node` with cache + integrity
- ✅ pair with Dependabot/Renovate so upgrades go through normal review

The same rule applies to **third-party actions**: pin to a full commit SHA, not a floating tag (`actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683`, not `@v4`). Floating tags can be reassigned.

**GitHub Actions permission-name traps.** The `permissions:` block names don't always match the REST endpoint path. Common mismatches to watch for:

| What you want to do | Endpoint path suggests | Permission actually required |
|---|---|---|
| Comment on a PR via `GITHUB_TOKEN` | `POST /repos/:o/:r/issues/:n/comments` — looks like `issues` | **`pull-requests: write`** (PRs are a specialization of issues; for Actions tokens the PR permission wins). With only `issues: write`, you get 403 `Resource not accessible by integration`. |
| Comment on a real (non-PR) issue | Same endpoint | `issues: write` |
| Submit a PR review | `POST /repos/:o/:r/pulls/:n/reviews` | `pull-requests: write` **plus** org setting "Allow GitHub Actions to create and approve pull requests" enabled |
| Add an inline review comment | `POST /repos/:o/:r/pulls/:n/comments` | `pull-requests: write` |
| Label a PR | `POST /repos/:o/:r/issues/:n/labels` | `pull-requests: write` (not `issues`) |
| Set a commit status | `POST /repos/:o/:r/statuses/:sha` | `statuses: write` |
| Dispatch another workflow | `POST /repos/:o/:r/dispatches` | Needs a PAT or App token — `GITHUB_TOKEN` cannot trigger other workflows by design |

To verify the effective permissions a workflow actually got, open any run's `Set up job` log group; GitHub prints a `GITHUB_TOKEN Permissions` block listing exactly what scopes the token has. If the YAML declared more than what the block shows, repo/org Actions settings are clamping it.

**Other workflow red flags:**
- `permissions:` block missing or set wider than needed (default to read-only, opt in per-job to `issues: write`, `pull-requests: write`, `contents: write`)
- Secrets referenced in jobs that also run attacker-influenced code (PR title, branch name, commit message, diff content interpolated into shell)
- `${{ github.event.pull_request.* }}` interpolated directly into `run:` scripts (script injection — use env vars instead)
- `workflow_dispatch` inputs used without validation in shell contexts
- Self-hosted runner jobs triggered by `pull_request` without a contributor allowlist

**Review checklist for any workflow change:**
1. What triggers fire this job? (`pull_request`, `pull_request_target`, `issue_comment`, `workflow_run`, etc.)
2. What secrets / token perms does the job have?
3. Where does the **code being executed** come from — trusted ref or PR HEAD?
4. Are all installed dependencies pinned?
5. Is attacker-controlled text interpolated into a shell?
6. Is the `permissions:` block minimized?

Flag as 🔴 BLOCKER when code from a PR checkout executes in a job that carries secrets or write-scoped tokens.

Security review patterns:
- **Fail closed, not open** — missing hash files, missing configs should refuse to start, not proceed
- **Don't overstate security claims** — if a check is bypassable, say so explicitly
- **Defense-in-depth is good but must be labeled correctly** — distinguish trust boundaries from convenience filters
- **Check the blast radius** — does this weaken security for deployments that don't need the feature?

