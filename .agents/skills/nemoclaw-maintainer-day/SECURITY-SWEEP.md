# Security Sweep Workflow

Review a security-sensitive item before it enters the normal fast path.

## Step 1: Identify the Security Item

The morning triage and `find-review-pr` already surface security-labeled PRs. Start from the item selected in the day loop's action step. If running standalone, check the triage queue for PRs touching risky areas (see [RISKY-AREAS.md](RISKY-AREAS.md)).

## Step 2: Gather Context

Read the PR or issue, all comments, linked items, changed files, diff, current checks, and recent relevant `main` commits.

## Step 3: Classify Risk

Which bucket applies?

- **escape or policy bypass**
- **credential or secret exposure**
- **installer or release integrity**
- **workflow or governance bypass**
- **input validation or SSRF weakness**
- **test gap in risky code**

If none apply, route back to normal action selection.

## Step 4: Deep Security Pass

Load `security-code-review` for the nine-category review whenever the item changes behavior in a security-sensitive area. Do not skip this step just because the diff is small.

## Step 5: Decide Action

### Salvage-now

All true: risk is understood, fix is small/local, required tests are clear, no unresolved design question. Follow [SALVAGE-PR.md](SALVAGE-PR.md) and [TEST-GAPS.md](TEST-GAPS.md).

### Blocked

Any true: fix changes core trust assumptions, review found real vulnerability needing redesign, PR adds risk without tests, reviewer disagreement. Summarize blocker clearly; do not approve.

## Notes

- Backlog reduction never outranks a credible security concern.
- No security-sensitive approvals without both deep review and tests.
- Use full GitHub links.
