---
name: nemoclaw-maintainer-e2e
description: Dispatches and verifies trusted GitHub Actions E2E for NemoClaw maintainers, including manual PR E2E for the current PR head commit. Use for requests such as run E2E for PR #123, run the E2E suite, run the Launchable E2E, run the full E2E suite, deploy pre-release full E2E, run pre-tag full E2E, or run release-candidate E2E.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Maintainer E2E

Use `.github/workflows/e2e.yaml` from trusted `main`.
Every push to `main` selects the default workflow E2E jobs.
Push runs skip `jetson-nvmap-gpu`, `llama-cpp-dgx-spark-plan`, and `llama-cpp-dgx-spark-qualification` because push events cannot set the required workflow dispatch flags.
Pre-tag evidence still requires the full `workflow_dispatch` mode described below.
Do not substitute local `npm run test:live-e2e` unless the maintainer explicitly requests local execution.

## Manual PR E2E

Use this mode when the maintainer requests E2E for a pull request.
It runs an authorized E2E selection against the current PR head commit while the workflow definition remains on `main`.
It is advisory and does not create a required PR check.

An empty-selector manual run exposes these values to candidate-controlled job processes:

- Long-lived API keys from repository secrets: `NVIDIA_INFERENCE_API_KEY`, `NVIDIA_API_KEY`, and `BRAVE_API_KEY`.
- Long-lived messaging credentials from repository secrets: `TELEGRAM_BOT_TOKEN_REAL`, `DISCORD_BOT_TOKEN_REAL`, `SLACK_BOT_TOKEN_REAL`, and `SLACK_APP_TOKEN_REAL`.
- The job-scoped `GITHUB_TOKEN` in the `token-rotation` and `openshell-gateway-upgrade` jobs. It has `checks: read`, `contents: read`, and `pull-requests: read` access. Candidate code can use it while either job runs. GitHub Actions invalidates it after the job.
- Messaging account and channel identifiers from repository secrets: `TELEGRAM_ALLOWED_IDS`, `TELEGRAM_AUTHORIZED_CHAT_IDS`, `TELEGRAM_CHAT_ID`, `TELEGRAM_CHAT_ID_E2E`, `DISCORD_CHANNEL_ID_E2E`, and `SLACK_CHANNEL_ID_E2E`.

The workflow does not rotate or revoke these API keys or messaging credentials. To remove later access, rotate or revoke every listed credential in the external service that issued it. The workflow cannot erase identifiers copied by candidate code. Review the complete candidate diff before dispatch.
Live targets can create external resources.
After a failure, inspect the artifacts and remove resources that target cleanup did not remove.

`Exact staging Brev Launchable` reads these credentials from repository Actions secrets:

- `BREV_API_KEY` authenticates the Brev CLI for workspace operations in the organization identified by `BREV_ORG_ID`.
- `NEMOCLAW_IMAGE_DISPATCH_TOKEN` is exposed as `GH_TOKEN` only to the trusted host script. It grants Actions read/write access to `brevdev/nemoclaw-image`, which the script uses to dispatch the image workflow, inspect its run, and download its handoff artifact.
- `NVIDIA_INFERENCE_API_KEY` is exported into the Brev guest for the full E2E process. Code in the baked candidate checkout can read and use it.

These credentials remain valid until they expire or an administrator revokes them in their issuing services. If cleanup fails, remove the recorded Brev workspace. Rotate or revoke each credential to remove later access.
This Brev credential boundary applies to trusted `main` pushes and Launchable or full manual runs. It does not apply to manual PR runs, which keep `include_staging_brev_launchable=false`.

For `managed-image-protected-runtime`, the workflow supplies the long-lived `NVIDIA_API_KEY` repository secret only to the trusted qualification step. Trusted host code uses it for NGC login and passes it as `NGC_API_KEY` and `NIM_NGC_API_KEY` to the temporary NIM container. Candidate managed sandboxes receive generated local route tokens instead of this key. The live fixture attempts to stop and remove `nemoclaw-managed-image-nim-e2e`, but Docker stop or removal errors do not fail the test. A surviving container can retain the API key until runner teardown. The final workflow step removes the job's isolated Docker credential directory and fails if that removal does not complete. The workflow does not revoke the NVIDIA API key. Rotate or revoke it in the issuing NVIDIA service to remove later access.

Resolve the current PR and trusted workflow identities:

```bash
set -euo pipefail
PR_NUMBER=123
git fetch --prune origin main
WORKFLOW_SHA="$(git rev-parse origin/main)"
PR_JSON="$(gh pr view "$PR_NUMBER" --repo NVIDIA/NemoClaw \
  --json number,state,headRefOid,baseRefOid,headRepository)"
test "$(jq -r .state <<<"$PR_JSON")" = OPEN
HEAD_SHA="$(jq -r .headRefOid <<<"$PR_JSON")"
BASE_SHA="$(jq -r .baseRefOid <<<"$PR_JSON")"
HEAD_REPOSITORY="$(jq -r .headRepository.nameWithOwner <<<"$PR_JSON")"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]]
```

Require a review reason containing 10 to 500 printable characters.

Choose exactly one mode:

- For a PR revision run, leave `E2E_JOBS` empty. The run selects:
  - every default-selected free-standing workflow E2E except `Exact staging Brev Launchable`;
  - every shared credential-free test; and
  - these controller-selected registry targets: `ubuntu-policy-custom-missing-presets-negative`, `ubuntu-repo-cloud-langchain-deepagents-code`, `ubuntu-repo-cloud-openclaw`, and `ubuntu-repo-docker-post-reboot-recovery`.
  The run skips `jetson-nvmap-gpu`, `llama-cpp-dgx-spark-plan`, and `llama-cpp-dgx-spark-qualification` unless their separate runner-queue flags are `true`.
- For protected managed-image runtime qualification, set `E2E_JOBS=managed-image-protected-runtime`. The exact candidate must contain `ci/protected-managed-image-multiarch-activation-v1.json` and `ci/protected-managed-image-runtime-activation-v1.json`.

Leave `targets` empty and keep Launchable disabled:

```bash
E2E_JOBS="${E2E_JOBS:-}"
case "$E2E_JOBS" in
  "" | managed-image-protected-runtime) ;;
  *) echo "Unsupported manual PR E2E job selector" >&2; exit 1 ;;
esac
REVIEW_REASON='Reviewed the PR head commit for credentialed E2E.'
CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f "jobs=${E2E_JOBS}" \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f allow_jetson_runner_queue=false \
  -f allow_dgx_spark_runner_queue=false \
  -f "pr_number=${PR_NUMBER}" \
  -f "checkout_sha=${HEAD_SHA}" \
  -f "checkout_repository=${HEAD_REPOSITORY}" \
  -f "base_sha=${BASE_SHA}" \
  -f "workflow_sha=${WORKFLOW_SHA}" \
  -f "review_reason=${REVIEW_REASON}" \
  -f "correlation_id=${CORRELATION_ID}"
```

The trusted pre-checkout step requires current `maintain` or `admin` permission and validates the open PR, repository, head SHA, base SHA, workflow SHA, review reason, and selected mode.
A second validation after checkout rejects a changed PR identity before preparation.

Find and verify the correlated run with bounded GitHub reads:

```bash
RUN_TITLE="E2E PR #${PR_NUMBER} (${CORRELATION_ID})"
MATCHES='[]'
for POLL_INDEX in $(seq 1 30); do
  RUNS="$(gh run list --repo NVIDIA/NemoClaw --workflow e2e.yaml \
    --event workflow_dispatch --branch main --limit 50 \
    --json databaseId,displayTitle,url)"
  MATCHES="$(jq -c --arg title "$RUN_TITLE" \
    '[.[] | select(.displayTitle == $title)]' <<<"$RUNS")"
  test "$(jq 'length' <<<"$MATCHES")" -le 1
  test "$(jq 'length' <<<"$MATCHES")" -eq 0 || break
  sleep 10
done
if test "$(jq 'length' <<<"$MATCHES")" -ne 1; then
  echo 'The dispatched run was not visible after bounded polling. Do not dispatch again. Inspect the E2E Actions runs for the recorded correlation ID and clean up any resources from a matching run.' >&2
  exit 1
fi
RUN_ID="$(jq -r '.[0].databaseId' <<<"$MATCHES")
RUN_URL="$(jq -r '.[0].url' <<<"$MATCHES")"
gh run watch "$RUN_ID" --repo NVIDIA/NemoClaw --exit-status
RUN_JSON="$(gh api "repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}")"
jq -e --arg sha "$WORKFLOW_SHA" '
  .run_attempt == 1 and
  .head_sha == $sha and
  .status == "completed" and
  .conclusion == "success"
' <<<"$RUN_JSON" >/dev/null
CURRENT_PR="$(gh pr view "$PR_NUMBER" --repo NVIDIA/NemoClaw \
  --json state,headRefOid,baseRefOid,headRepository)"
test "$(jq -r .state <<<"$CURRENT_PR")" = OPEN
test "$(jq -r .headRefOid <<<"$CURRENT_PR")" = "$HEAD_SHA"
test "$(jq -r .baseRefOid <<<"$CURRENT_PR")" = "$BASE_SHA"
test "$(jq -r .headRepository.nameWithOwner <<<"$CURRENT_PR")" = "$HEAD_REPOSITORY"
```

Return the PR number, head repository, head SHA, base SHA, workflow SHA, correlation ID, workflow URL, and result.
A changed head repository, head SHA, or base SHA invalidates the evidence and requires a new run.

## Select the Main Mode

| Request | Mode | `jobs` | `include_staging_brev_launchable` |
|---|---|---|---|
| “Run the E2E suite” | Ordinary | empty | `false` |
| “Run the Launchable E2E” | Launchable | `staging-brev-launchable` | `false` |
| “Run the full E2E suite” | Full | empty | `true` |
| “deploy pre-release full E2E” | Full | empty | `true` |
| “run pre-tag full E2E” | Full | empty | `true` |
| “run release-candidate E2E” | Full | empty | `true` |

A generic E2E request must not authorize the Brev Launchable path.
Do not infer full mode from words such as “all” or “complete.”
Ask for clarification only when the request contains conflicting mode phrases.

Ordinary mode selects every default-selected workflow E2E except `Exact staging Brev Launchable`.
Launchable mode runs only `Exact staging Brev Launchable`.
Full mode adds `Exact staging Brev Launchable` to the default E2E selection in the same workflow run.
The documented invocations for all three modes keep both hardware runner-queue flags set to `false`.

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
  -f allow_jetson_runner_queue=false \
  -f allow_dgx_spark_runner_queue=false \
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
  -f allow_jetson_runner_queue=false \
  -f allow_dgx_spark_runner_queue=false \
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
  -f allow_jetson_runner_queue=false \
  -f allow_dgx_spark_runner_queue=false \
  -f "correlation_id=${CORRELATION_ID}"
```

Do not set `jobs=staging-brev-launchable` for full mode.
Empty `jobs` and `targets` select every default-selected workflow E2E except `Exact staging Brev Launchable`.
The `include_staging_brev_launchable` input adds the Launchable E2E job to that same run.
The trusted `main` workflow verifies that the dispatching and rerunning actors have
repository `maintain` or `admin` permission before the Launchable path's source
checkout. That role check is the authorization.
A user permitted to dispatch this workflow may set
`allow_jetson_runner_queue=true` to add `jetson-nvmap-gpu` to an empty-selector
manual run or enable its explicit selection. Set it only after a repository
administrator confirms an online Jetson runner in the authoritative runner
inventory.
A permitted dispatcher may set `allow_dgx_spark_runner_queue=true` to add
`llama-cpp-dgx-spark-plan` and `llama-cpp-dgx-spark-qualification` to an
empty-selector manual run or enable explicit qualification selection. Set it
only after a repository administrator confirms an online DGX Spark runner in
the authoritative runner inventory.
If GitHub pauses the qualification job for the `approve-dgx-spark-image-qualification` environment, an authorized environment reviewer must approve it before qualification starts.
`Exact staging Brev Launchable` does not require environment approval.

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

For full-mode or release evidence, collect every attempt for the matrix-preserving ledger:

```bash
gh api --paginate --slurp \
  "repos/NVIDIA/NemoClaw/actions/runs/$RUN_ID/jobs?filter=all&per_page=100" \
  >"$EVIDENCE_DIR/jobs-$RUN_ID.json"
```

Reuse `run-$RUN_ID.json` and `jobs-$RUN_ID.json` as the `nemoclaw-maintainer-cut-release-tag` manifest inputs and as the full-mode validator inputs. Do not fetch the same run again. `jobs-latest-$RUN_ID.json` is only for ordinary and Launchable modes.

For ordinary and Launchable modes, require `run-$RUN_ID.json` to report:

- `head_sha` equal to `CANDIDATE_SHA`;
- `status` equal to `completed`; and
- `conclusion` equal to `success`.

For Launchable mode, also require `jobs-latest-$RUN_ID.json` to contain one completed, successful
`Exact staging Brev Launchable` job. Return the workflow and job URLs.

For full mode, select and download the Launchable E2E artifact for the latest successful Launchable job attempt:

```bash
EVIDENCE_ATTEMPT="$(jq -er '
  [.[] | .jobs[] |
   select(.name == "Exact staging Brev Launchable" and
          .status == "completed" and
          .conclusion == "success" and
          (.run_attempt | type) == "number") |
   .run_attempt] | unique | sort | last // error("no successful Launchable attempt")
' "$EVIDENCE_DIR/jobs-$RUN_ID.json")"
FULL_E2E_DIR="$EVIDENCE_DIR/full-$EVIDENCE_ATTEMPT"
install -d -m 0700 "$FULL_E2E_DIR"
gh run download "$RUN_ID" --repo NVIDIA/NemoClaw \
  --name "staging-brev-launchable-${CANDIDATE_SHA}-${RUN_ID}-${EVIDENCE_ATTEMPT}" \
  --dir "$FULL_E2E_DIR"
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-e2e/scripts/validate-full-e2e-evidence.mts \
  --candidate-sha "$CANDIDATE_SHA" \
  --run-json "$EVIDENCE_DIR/run-$RUN_ID.json" \
  --jobs-json "$EVIDENCE_DIR/jobs-$RUN_ID.json" \
  --dispatch-json "$FULL_E2E_DIR/dispatch.json" \
  --launchable-e2e-json "$FULL_E2E_DIR/launchable-e2e.json" \
  --cleanup-json "$FULL_E2E_DIR/cleanup.json"
```

The validator requires:

- the workflow run to succeed for the selected SHA;
- `dispatch.json` to bind the same run, empty selectors, `include_staging_brev_launchable=true`, `allowJetsonRunnerQueue: false`, `allowDgxSparkRunnerQueue: false`, and the selected successful Launchable job attempt;
- `Exact staging Brev Launchable` to conclude `success` in the selected current or earlier attempt of the same workflow run;
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
- selected successful Launchable job attempt;
- Launchable E2E identity; and
- cleanup result.

If the release candidate SHA changes, discard the earlier full run and dispatch full mode for the new SHA.
No release-note-only delta exception is currently defined.

When `nemoclaw-maintainer-cut-release-tag` invokes this skill, return the validated fields for its pre-tag E2E evidence ledger.
The trusted `dispatch.json` receipt proves that full mode used empty selectors, included `Exact staging Brev Launchable`, and disabled both optional hardware paths.
The release evidence ledger proves the result of each workflow E2E.
Do not ask for the release confirmation phrase in this skill.

## Access Failures

Follow the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).
Stop on authentication, authorization, remote-access, or permission failures.
