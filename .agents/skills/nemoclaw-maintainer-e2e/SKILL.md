---
name: nemoclaw-maintainer-e2e
description: Dispatches and verifies trusted advisory GitHub Actions E2E for NemoClaw maintainers. Use for requests such as run the E2E suite, run the Launchable E2E, run the full E2E suite, diagnose the overnight consolidated run, selectively rerun failures, or validate a release candidate without gating its tag.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Maintainer E2E

Use `.github/workflows/e2e.yaml` from trusted `main`.
Do not substitute local `npm run test:live-e2e` unless the maintainer explicitly requests local execution.

## Select the Mode

| Request | Mode | `jobs` | `include_staging_brev_launchable` |
|---|---|---|---|
| “Run the E2E suite” | Ordinary | empty | `false` |
| “Run the Launchable E2E” | Launchable | `staging-brev-launchable` | `false` |
| “Run the full E2E suite” | Full | empty | `true` |
| “diagnose the overnight consolidated run” | Scheduled inspection | n/a | n/a |
| “run release-candidate E2E” | Full | empty | `true` |

A generic E2E request must not authorize the Brev Launchable path.
Do not infer full mode from words such as “all” or “complete.”
Ask for clarification only when the request contains conflicting mode phrases.

Ordinary mode runs the default-enabled GitHub Actions suite.
Launchable mode runs only `Exact staging Brev Launchable`.
Full mode runs the default-enabled suite and `Exact staging Brev Launchable` in the same workflow run.

## Inspect the Scheduled Consolidated Run

For overnight diagnosis, start from the trusted frozen plan. Do not dispatch a fresh full run merely to inspect the scheduled run:

```bash
export PLAN_PATH=/path/to/downloaded-release-edition-plan/plan.json
CANDIDATE_SHA="$(node -p "require(process.env.PLAN_PATH).candidateCommit")"
export EDITION_CUTOFF_AT="$(node -p "require(process.env.PLAN_PATH).authorization.cutoffAt")"
CUTOFF_SECONDS="$(node -p "Date.parse(process.env.EDITION_CUTOFF_AT) / 1000")"
WINDOW_END_SECONDS="$((CUTOFF_SECONDS + 12 * 60 * 60))"
RUNS="$(gh run list --repo NVIDIA/NemoClaw --workflow e2e.yaml \
  --event schedule --branch main --limit 50 \
  --json databaseId,createdAt,headSha,status,conclusion,url)"
MATCHES="$(jq -c --argjson start "$CUTOFF_SECONDS" --argjson end "$WINDOW_END_SECONDS" \
  '[.[] | select((.createdAt | fromdateiso8601) >= $start and
                 (.createdAt | fromdateiso8601) < $end)] | sort_by(.createdAt)' <<<"$RUNS")"
test "$(jq 'length' <<<"$MATCHES")" -eq 1
RUN_ID="$(jq -r '.[0].databaseId' <<<"$MATCHES")"
RUN_SHA="$(jq -r '.[0].headSha' <<<"$MATCHES")"
RUN_URL="$(jq -r '.[0].url' <<<"$MATCHES")"
```

The twelve-hour window starts at the plan's exact 4 PM cutoff and ends before the 4 AM cut. If no scheduled run is recorded yet, report it as pending and poll; do not silently substitute full mode. More than one match is ambiguous and must be reported.

Record whether `RUN_SHA` equals `CANDIDATE_SHA`. If an accidental post-cutoff merge makes them differ, diagnose the scheduled run as next-edition advisory state and do not describe it as frozen-candidate evidence. The tag remains bound to the frozen plan.

Watch and inspect the selected run even when it fails:

```bash
gh run watch "$RUN_ID" --repo NVIDIA/NemoClaw
gh run view "$RUN_ID" --repo NVIDIA/NemoClaw \
  --json status,conclusion,headSha,jobs,url
gh run view "$RUN_ID" --repo NVIDIA/NemoClaw --log-failed
```

Classify failures before choosing selective reruns. Dispatch full mode only for an explicit full or release-candidate rerun request.

## Operate the Overnight Loop

For the frozen edition, keep one agent session active from 4:00 PM through the 8:00 AM handoff. Do not start competing agents over the same failure set. Repeat this sequence until the handoff boundary:

1. inspect newly completed consolidated or selective E2E jobs and exact-SHA post-merge advisor findings;
2. choose the highest-impact unresolved failure that is not already owned by a prepared fix;
3. classify it as a product regression, flaky test, infrastructure failure, or stale test;
4. prepare the smallest focused fix or justified test cleanup and run its deterministic checks;
5. open or update a fix PR without merging it during the freeze;
6. dispatch only the selective rerun needed to test the diagnosis; and
7. update the shared handoff state, then immediately choose the next actionable item.

Do not wait idly for an unrelated rerun when another unresolved failure can be diagnosed. Continue across the 4:00 AM tag without changing the frozen candidate or treating the tag as E2E success. At 8:00 AM, stop the loop and hand over every unresolved failure, rerun, and prepared PR. If the active agent cannot continue before then, transfer the same state to one replacement agent.

## Resolve the Candidate

Run from a trusted NemoClaw checkout:

```bash
gh auth status
git fetch --prune origin main
CANDIDATE_SHA="$(git rev-parse origin/main)"
```

For a frozen-edition request, read `FROZEN_CANDIDATE_SHA` from the generated release plan and compare it with `CANDIDATE_SHA`, which is the current trusted `origin/main` dispatch ref. When they match, the rerun is also bound to the frozen candidate. If `main` advanced after the cutoff, keep the plan frozen and describe new dispatches as current-main or next-edition validation; the current direct-main workflow does not dispatch an older ancestor. Do not use the PR-controller checkout inputs to bypass that boundary.

Record `CANDIDATE_SHA` for every dispatch.
Do not use a relative revision in the evidence report.

## Dispatch One Trusted Run

Generate a unique correlation ID:

```bash
CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
```

For ordinary mode:

```bash
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f jobs= \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f "correlation_id=${CORRELATION_ID}"
```

For Launchable mode:

```bash
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f jobs=staging-brev-launchable \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f "correlation_id=${CORRELATION_ID}"
```

For full mode:

```bash
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f jobs= \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=true \
  -f "correlation_id=${CORRELATION_ID}"
```

Do not set `jobs=staging-brev-launchable` for full mode.
Empty `jobs` and `targets` select the default suite.
The boolean input adds the Launchable E2E job to that same run.
The trusted `main` workflow verifies that the dispatching and rerunning actors have
repository `maintain` or `admin` permission before the Launchable path's source
checkout. That role check is the authorization.
Launchable and full runs do not require separate environment approval.

Find the run by its unique title:

```bash
RUN_TITLE="E2E main (${CORRELATION_ID})"
for POLL_INDEX in $(seq 1 30); do
  RUNS="$(gh run list --repo NVIDIA/NemoClaw --workflow e2e.yaml \
    --event workflow_dispatch --branch main --limit 50 \
    --json databaseId,displayTitle,headSha,status,url)"
  MATCHES="$(jq -c --arg title "$RUN_TITLE" \
    '[.[] | select(.displayTitle == $title)]' <<<"$RUNS")"
  [ "$(jq 'length' <<<"$MATCHES")" -le 1 ] || {
    echo "Correlation matched more than one E2E run" >&2
    exit 1
  }
  RUN_ID="$(jq -r '.[0].databaseId // empty' <<<"$MATCHES")"
  [ -z "$RUN_ID" ] || break
  sleep 10
done
test -n "${RUN_ID:-}"
RUN_SHA="$(jq -r '.[0].headSha' <<<"$MATCHES")"
test "$RUN_SHA" = "$CANDIDATE_SHA"
```

Reject a run for another SHA.
Do not reuse it as evidence.

Wait for completion:

```bash
gh run watch "$RUN_ID" --repo NVIDIA/NemoClaw --exit-status
```

Launchable and full modes can wait in the non-cancelling Launchable concurrency queue.
Queued, waiting, or accepted dispatch state is not success.

## Verify the Result

Create a private temporary evidence directory:

```bash
EVIDENCE_DIR="$(mktemp -d)"
chmod 700 "$EVIDENCE_DIR"
trap 'rm -rf "$EVIDENCE_DIR"' EXIT
gh api "repos/NVIDIA/NemoClaw/actions/runs/$RUN_ID" >"$EVIDENCE_DIR/run-$RUN_ID.json"
gh api "repos/NVIDIA/NemoClaw/actions/runs/$RUN_ID/jobs?filter=latest&per_page=100" \
  >"$EVIDENCE_DIR/jobs-latest-$RUN_ID.json"
```

`jobs-latest-$RUN_ID.json` is only the validator input for the latest full-mode attempt.

For ordinary and Launchable modes, require `run-$RUN_ID.json` to report:

- `head_sha` equal to `CANDIDATE_SHA`;
- `status` equal to `completed`; and
- `conclusion` equal to `success`.

For Launchable mode, also require `jobs-latest-$RUN_ID.json` to contain one completed, successful
`Exact staging Brev Launchable` job. Return the workflow and job URLs.

For full mode, download the Launchable E2E evidence:

```bash
gh run download "$RUN_ID" --repo NVIDIA/NemoClaw \
  --name "staging-brev-launchable-${CANDIDATE_SHA}-${RUN_ID}" \
  --dir "$EVIDENCE_DIR"
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-e2e/scripts/validate-full-e2e-evidence.mts \
  --candidate-sha "$CANDIDATE_SHA" \
  --run-json "$EVIDENCE_DIR/run-$RUN_ID.json" \
  --jobs-json "$EVIDENCE_DIR/jobs-latest-$RUN_ID.json" \
  --dispatch-json "$EVIDENCE_DIR/dispatch.json" \
  --launchable-e2e-json "$EVIDENCE_DIR/launchable-e2e.json" \
  --cleanup-json "$EVIDENCE_DIR/cleanup.json"
```

The validator requires:

- the workflow run to succeed for the selected SHA;
- `dispatch.json` to bind the run and attempt to empty selectors and `include_staging_brev_launchable=true`;
- `Exact staging Brev Launchable` to conclude `success` in the reported attempt;
- `launchable-e2e.json` to identify the selected SHA in the repository and provision records;
- the booted repository to be unmodified;
- the in-guest full E2E to pass; and
- `cleanup.json` to report the same workspace as `ABSENT`.

A skipped, cancelled, queued, or failed Launchable E2E job is not evidence.
A Launchable-mode run is not full-mode evidence.
A missing, mismatched, or failed cleanup receipt is not evidence.

## Bind Advisory Evidence

If no release plan exists, label a successful full run against `origin/main` as advisory E2E evidence.
Return:

- candidate SHA;
- workflow run URL and conclusion;
- `Exact staging Brev Launchable` job URL;
- workflow attempt number;
- Launchable E2E identity; and
- cleanup result.

Bind every result to the tested SHA. For the frozen edition, classify failures and prepare fixes for the next merge window.
Return the trusted dispatch, test, Launchable, and cleanup receipts needed for diagnosis.
Never treat success as tag authorization or failure as a reason to delay the 4 AM tag.

## Access Failures

Follow the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).
Stop on authentication, authorization, remote-access, or permission failures.
