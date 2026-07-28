---
name: nemoclaw-maintainer-e2e
description: Dispatches and verifies trusted GitHub Actions E2E for NemoClaw maintainers. Use for requests such as run the E2E suite, run the Launchable E2E, run the full E2E suite, deploy pre-release full E2E, run pre-tag full E2E, or run release-candidate E2E.
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
| “deploy pre-release full E2E” | Full | empty | `true` |
| “run pre-tag full E2E” | Full | empty | `true` |
| “run release-candidate E2E” | Full | empty | `true` |

A generic E2E request must not authorize the protected Brev path.
Do not infer full mode from words such as “all” or “complete.”
Ask for clarification only when the request contains conflicting mode phrases.

Ordinary mode runs the default-enabled GitHub Actions suite.
Launchable mode runs only `Exact staging Brev Launchable`.
Full mode runs the default-enabled suite and `Exact staging Brev Launchable` in the same workflow run.

## Resolve the Candidate

Run from a trusted NemoClaw checkout:

```bash
gh auth status
git fetch --prune origin main
CANDIDATE_SHA="$(git rev-parse origin/main)"
```

For a pre-tag request, use the full candidate SHA from the generated release plan.
Require that SHA to equal `origin/main` before dispatch.
Stop and regenerate the release plan when they differ.

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
The protected environment can require approval for Launchable and full runs.

### Release Coverage Dispatch Group

Use this subsection only when `nemoclaw-maintainer-cut-release-tag` supplies a release E2E preflight.
It coordinates independent workflow runs; it does not change the meaning of ordinary or full mode above.

Read `dispatches` from the preflight.
Create a different correlation ID for each run.
Dispatch the `defaultSuite` run first, using ordinary or full mode exactly as reported.
Without waiting for it, dispatch the non-empty `parallelExplicit.jobs` value:

```bash
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f "jobs=${EXPLICIT_JOBS}" \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f "correlation_id=${EXPLICIT_CORRELATION_ID}"
```

Do not add `staging-brev-launchable` to that selector list.
Do not dispatch a conditional Jetson lane unless the authoritative repository runner inventory was confirmed online.
After that confirmation, use a separate run and opt into queueing explicitly:

```bash
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f jobs=jetson-nvmap-gpu \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f allow_jetson_runner_queue=true \
  -f "correlation_id=${JETSON_CORRELATION_ID}"
```

Find all correlation IDs with one bounded `gh run list` query.
Require exactly one run per correlation ID and the candidate SHA on every match.
Dispatch the whole group before watching any member; do not serialize independent runs.
Watch the group with batched status snapshots and collect results after all members are terminal.

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

Launchable and full modes can wait for protected-environment approval.
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

For a release coverage group, also collect every attempt for the matrix-preserving ledger:

```bash
gh api --paginate --slurp \
  "repos/NVIDIA/NemoClaw/actions/runs/$RUN_ID/jobs?filter=all&per_page=100" \
  >"$EVIDENCE_DIR/jobs-$RUN_ID.json"
```

Reuse `run-$RUN_ID.json` and `jobs-$RUN_ID.json` as the `nemoclaw-maintainer-cut-release-tag` manifest inputs.
Do not fetch the same run again.
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
A Launchable-mode run is not full-mode or pre-tag release evidence.
A missing, mismatched, or failed cleanup receipt is not evidence.

## Bind Release Evidence

If no release plan exists, label a successful full run against `origin/main` as provisional release evidence.
Return:

- candidate SHA;
- workflow run URL and conclusion;
- `Exact staging Brev Launchable` job URL;
- workflow attempt number;
- Launchable E2E identity; and
- cleanup result.

If the release candidate SHA changes, discard the earlier run group and rerun every required release coverage group for the new SHA.
No release-note-only delta exception is currently defined.

When `nemoclaw-maintainer-cut-release-tag` invokes this skill, return the validated fields for its pre-tag E2E evidence ledger.
The trusted `dispatch.json` receipt proves that full mode selected the default suite.
The release evidence ledger proves the result of each default-suite execution.
Do not ask for the release confirmation phrase in this skill.

## Access Failures

Follow the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).
Stop on authentication, authorization, remote-access, or permission failures.
