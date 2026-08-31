<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Main E2E Runs

Use this procedure only when the maintainer requests a new trusted `main` dispatch.

## Choose the Mode

| Request | `RUN_MODE` | `jobs` | `targets` | Launchable E2E included |
| --- | --- | --- | --- | --- |
| “Run the E2E suite” | `ordinary` | empty | empty | no |
| “Run focused E2E” | `focused` | named IDs or empty | named IDs or empty | no |
| “Run the Launchable E2E” | `launchable` | `staging-brev-launchable` | empty | only this job |
| “Run the full E2E suite” | `full` | empty | empty | yes |
| “deploy pre-release full E2E” | `full` | empty | empty | yes |
| “run pre-tag full E2E” | `full` | empty | empty | yes |
| “run release-candidate E2E” | `full` | empty | empty | yes |

A generic E2E request must not authorize the Brev Launchable path. Do not infer full mode from “all”
or “complete.” Ask only when the request contains conflicting mode phrases.

Ordinary mode selects the default E2E suite without `Staging Brev Launchable`. Focused mode
selects named jobs or typed targets; set only one selector input. Launchable mode runs only that
job. Full mode adds it to the default suite.

The full `Release qualification` job is strict: every release-required job must succeed. It does not
waive failed jobs. Its result reports the run; it does not decide whether a release can proceed.

## Credential and Resource Boundary

Before dispatch, read [Push and Manual PR E2E](../../../../test/e2e/README.md#push-and-manual-pr-e2e)
for the selected jobs' credential locations, access, lifetimes, and removal or cleanup boundaries.

Ordinary, focused, and full runs can expose credentials to selected candidate jobs. These credentials
can provide inference, Brave Search, messaging, or scoped GitHub access.

Before dispatch:

- review the trusted `main` revision;
- inspect failed-run artifacts;
- remove external resources that target cleanup did not remove; and
- rotate or revoke any credential that candidate code could have copied.

`Staging Brev Launchable` uses `BREV_API_KEY` and `BREV_ORG_ID` during trusted host
preparation. It exposes `NEMOCLAW_IMAGE_DISPATCH_TOKEN` only to the trusted host script as
`GH_TOKEN`. It exports `NVIDIA_INFERENCE_API_KEY` into the Brev guest for full E2E. Candidate code in
that guest can read the inference key. The workflow requires repository `maintain` or `admin`
permission before source checkout. If cleanup fails, remove the recorded workspace. Rotate or revoke
credentials that may remain accessible.

Protected managed-image qualification supplies `NVIDIA_API_KEY` only to trusted qualification code.
If its verified cleanup refuses removal, inspect the temporary NIM container and rotate the key.

Jetson and DGX Spark remain disabled in the standard commands below. Enable them only with the
operator and runner approvals documented by the workflow. See
[Jetson Dispatch Controller](../../../../test/e2e/docs/jetson-dispatch.md). GitHub can require an
authorized environment reviewer before DGX Spark qualification starts.

## Resolve the Commit to Test

```bash
gh auth status
git fetch --prune origin main
CANDIDATE_SHA="$(git rev-parse origin/main)"
```

A new dispatch tests the `origin/main` commit resolved here. If the caller supplied another candidate
SHA, report the difference. Do not reject it or decide the release outcome.

## Dispatch Once

Set the selected mode and selectors:

```bash
RUN_MODE='<ordinary|focused|launchable|full>'
E2E_JOBS=''
E2E_TARGETS=''
INCLUDE_LAUNCHABLE=false

case "$RUN_MODE" in
  ordinary) ;;
  focused)
    if [[ -n "$E2E_JOBS" && -n "$E2E_TARGETS" ]] ||
      [[ -z "$E2E_JOBS" && -z "$E2E_TARGETS" ]]; then
      echo "Focused E2E requires jobs or targets, but not both" >&2
      exit 1
    fi
    ;;
  launchable) E2E_JOBS=staging-brev-launchable ;;
  full) INCLUDE_LAUNCHABLE=true ;;
  *) echo "Unknown E2E mode: $RUN_MODE" >&2; exit 1 ;;
esac
```

Generate one correlation ID and dispatch one workflow:

```bash
CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f "targets=${E2E_TARGETS}" \
  -f "jobs=${E2E_JOBS}" \
  -f inference_mode=mock \
  -f "include_staging_brev_launchable=${INCLUDE_LAUNCHABLE}" \
  -f allow_jetson_dispatch=false \
  -f allow_dgx_spark_runner_queue=false \
  -f "correlation_id=${CORRELATION_ID}"
```

Do not dispatch again because the run is slow to appear. Find it with bounded reads:

```bash
set -euo pipefail
RUN_TITLE="E2E main (${CORRELATION_ID})"
if [[ "$RUN_MODE" == full ]]; then
  RUN_TITLE="E2E full main (${CORRELATION_ID})"
fi
for POLL_INDEX in $(seq 1 30); do
  RUNS="$(gh run list --repo NVIDIA/NemoClaw --workflow e2e.yaml \
    --event workflow_dispatch --branch main --limit 50 \
    --json databaseId,displayTitle,headSha,status,url)"
  MATCHES="$(jq -c --arg title "$RUN_TITLE" \
    '[.[] | select(.displayTitle == $title)]' <<<"$RUNS")"
  test "$(jq 'length' <<<"$MATCHES")" -le 1
  RUN_ID="$(jq -r '.[0].databaseId // empty' <<<"$MATCHES")"
  test -z "$RUN_ID" || break
  sleep 10
done
test -n "${RUN_ID:-}"
RUN_SHA="$(jq -r '.[0].headSha' <<<"$MATCHES")"
test "$RUN_SHA" = "$CANDIDATE_SHA"
```

The SHA comparison proves which commit the selected run tested. It is not a tag-authorization
rule. If the run does not appear after the bounded search, inspect GitHub Actions for the correlation
ID. Do not dispatch again.

Wait for completion:

```bash
gh run watch "$RUN_ID" --repo NVIDIA/NemoClaw
```

The Launchable concurrency group does not cancel a running E2E job. GitHub can replace an older pending run with a newer pending run in the same group.

## Verify and Report

Read the run and latest-attempt jobs:

```bash
EVIDENCE_DIR="$(mktemp -d)"
chmod 700 "$EVIDENCE_DIR"
trap 'rm -rf "$EVIDENCE_DIR"' EXIT
gh api "repos/NVIDIA/NemoClaw/actions/runs/$RUN_ID" >"$EVIDENCE_DIR/run.json"
gh api "repos/NVIDIA/NemoClaw/actions/runs/$RUN_ID/jobs?filter=latest&per_page=100" \
  >"$EVIDENCE_DIR/jobs.json"
```

Require the selected run to report `head_sha` equal to `CANDIDATE_SHA` and `status` equal to
`completed`. A successful ordinary, focused, Launchable, or full run has workflow conclusion
`success`. Otherwise, return each failed, cancelled, skipped, or running job and URL.

For Launchable mode, also require one completed, successful `Staging Brev Launchable` job.
Preserve links to `launchable-e2e.json`, `full-e2e.log`, and `cleanup.json` for diagnosis.

For full mode, also require one completed, successful `Release qualification` job. A skipped, cancelled, queued, or failed aggregate is not a passing full run.

Return:

- the mode and selectors;
- the tested SHA;
- the workflow status, conclusion, attempt, and URL; and
- relevant job URLs.

Do not decide whether a release can proceed.
