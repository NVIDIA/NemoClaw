<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Candidate Evidence

Candidate evidence is the release-specific evidence required for the planned candidate. Use the
exact version and candidate from `plan.json`. These are read-only checks. Run every section except
[Final Documentation Recheck](#final-documentation-recheck) before the general E2E decision. Keep
the first shell only until its evidence is copied into the release brief. It does not need to remain
open while waiting for tag confirmation.

```bash
set -euo pipefail
PLAN_PATH='../nemoclaw-release-vX.Y.Z/plan.json'
EVIDENCE_DIR="$(mktemp -d)"
chmod 700 "$EVIDENCE_DIR"
trap 'rm -rf "$EVIDENCE_DIR"' EXIT

run_or_stop() {
  local label="$1"
  local status
  shift
  if "$@"; then
    return 0
  else
    status=$?
    printf '%s failed with status %s\n' "$label" "$status" >&2
    exit "$status"
  fi
}

stop() {
  printf '%s\n' "$1" >&2
  exit 1
}

PLAN_FIELDS="$EVIDENCE_DIR/plan-fields.txt"
run_or_stop "release plan read" jq -er '
  if
    (keys | sort) == [
      "nextTag", "originMainCommit", "originMainHeadline",
      "previousTag", "previousTagCommit", "previousTagObject"
    ] and
    (.nextTag | test("^v(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$")) and
    (.originMainCommit | test("^[0-9a-f]{40}$"))
  then [.nextTag, .originMainCommit] | @tsv
  else error("release plan is invalid")
  end
' "$PLAN_PATH" >"$PLAN_FIELDS"
IFS=$'\t' read -r VERSION CANDIDATE_SHA <"$PLAN_FIELDS"
DOCS_BRANCH="automation/post-merge-docs-${CANDIDATE_SHA:0:12}"
```

## Release Entry and Pi Result

Find exactly one target heading at the candidate. Save only that H2 section, ending before the next
H2, for the release brief.

```bash
ENTRY_MATCHES="$EVIDENCE_DIR/release-entry-matches.txt"
VERSION_PATTERN="${VERSION//./[.]}"
run_or_stop "release-entry search" git grep -n -E "^## ${VERSION_PATTERN}$" \
  "$CANDIDATE_SHA" -- \
  'docs/changelog/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].mdx' >"$ENTRY_MATCHES"
ENTRY_MATCH_COUNT="$(awk 'END { print NR }' "$ENTRY_MATCHES")"
[[ "$ENTRY_MATCH_COUNT" == 1 ]] || stop "Expected one release entry; found $ENTRY_MATCH_COUNT"
IFS= read -r ENTRY_MATCH <"$ENTRY_MATCHES"
ENTRY_PATH="${ENTRY_MATCH#*:}"
ENTRY_PATH="${ENTRY_PATH%%:*}"
ENTRY_SOURCE="$EVIDENCE_DIR/changelog.mdx"
ENTRY_FILE="$EVIDENCE_DIR/release-entry.md"
run_or_stop "release-entry read" git show "${CANDIDATE_SHA}:${ENTRY_PATH}" >"$ENTRY_SOURCE"
run_or_stop "release-entry extraction" awk -v heading="## $VERSION" '
  $0 == heading { in_entry = 1 }
  in_entry && emitted && /^##[[:space:]]/ { exit }
  in_entry { print; emitted = 1 }
' "$ENTRY_SOURCE" >"$ENTRY_FILE"
[[ -s "$ENTRY_FILE" ]] || stop "The release entry is empty"
run_or_stop "release-entry detail validation" awk '
  /^-[[:space:]]/ { detailed = 1 }
  END { exit(detailed ? 0 : 1) }
' "$ENTRY_FILE"
```

Read the newest exact-candidate `Docs / Post-Merge Catch-Up` run. Require its one publish job to pass:

```bash
DOCS_RUNS_FILE="$EVIDENCE_DIR/docs-runs.json"
run_or_stop "documentation run list" gh run list --repo NVIDIA/NemoClaw \
  --workflow post-merge-docs.yaml --event push --branch main --commit "$CANDIDATE_SHA" \
  --limit 100 --json databaseId,headSha,status,conclusion,url,createdAt >"$DOCS_RUNS_FILE"
DOCS_RUN_ID_FILE="$EVIDENCE_DIR/docs-run-id"
run_or_stop "documentation run selection" jq -er --arg sha "$CANDIDATE_SHA" \
  '[.[] | select(.headSha == $sha)] | sort_by(.createdAt) | last | .databaseId' \
  "$DOCS_RUNS_FILE" >"$DOCS_RUN_ID_FILE"
IFS= read -r DOCS_RUN_ID <"$DOCS_RUN_ID_FILE"
DOCS_RUN_FILE="$EVIDENCE_DIR/docs-run.json"
run_or_stop "documentation run read" gh run view "$DOCS_RUN_ID" --repo NVIDIA/NemoClaw \
  --json attempt,headSha,status,conclusion,url,jobs >"$DOCS_RUN_FILE"
run_or_stop "documentation run validation" jq -e --arg sha "$CANDIDATE_SHA" '
  .headSha == $sha and .status == "completed" and .conclusion == "success" and
  ([.jobs[] | select(.name == "Publish documentation catch-up")] | length == 1) and
  ([.jobs[] | select(.name == "Publish documentation catch-up")][0] |
    .status == "completed" and .conclusion == "success")
' "$DOCS_RUN_FILE" >/dev/null
DOCS_RUN_FIELDS_FILE="$EVIDENCE_DIR/docs-run-fields.txt"
run_or_stop "documentation run field read" jq -er '
  [.attempt, .url, ([.jobs[] | select(.name == "Publish documentation catch-up")][0].url)] |
  .[]
' "$DOCS_RUN_FILE" >"$DOCS_RUN_FIELDS_FILE"
{
  IFS= read -r DOCS_RUN_ATTEMPT
  IFS= read -r DOCS_RUN_URL
  IFS= read -r DOCS_PUBLISH_JOB_URL
} <"$DOCS_RUN_FIELDS_FILE"
```

Download that run's reviewed patch. A successful publish job is release evidence only when the
review covers this candidate and the approved patch is empty.

```bash
DOCS_ARTIFACT='post-merge-docs-approved'
DOCS_ARTIFACT_DIR="$EVIDENCE_DIR/docs-approved"
mkdir "$DOCS_ARTIFACT_DIR"
run_or_stop "documentation artifact download" gh run download "$DOCS_RUN_ID" \
  --repo NVIDIA/NemoClaw --name "$DOCS_ARTIFACT" --dir "$DOCS_ARTIFACT_DIR"
DOCS_PATCH="$DOCS_ARTIFACT_DIR/docs.patch"
DOCS_REVIEW="$DOCS_ARTIFACT_DIR/review.json"
[[ -f "$DOCS_PATCH" && -f "$DOCS_REVIEW" ]] || stop "The documentation artifact is incomplete"
[[ ! -s "$DOCS_PATCH" ]] || stop "The approved documentation patch is not empty"
EMPTY_PATCH_SHA256='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
run_or_stop "documentation review validation" jq -e --arg sha "$CANDIDATE_SHA" \
  --arg digest "$EMPTY_PATCH_SHA256" '
  type == "object" and
  (keys | sort) == ["mainSha", "outcome", "patchSha256", "repository", "version"] and
  .version == 1 and .repository == "NVIDIA/NemoClaw" and .mainSha == $sha and
  .patchSha256 == $digest and .outcome == "approved"
' "$DOCS_REVIEW" >/dev/null
DOCS_REVIEW_NORMALIZED="$EVIDENCE_DIR/docs-review-normalized.json"
run_or_stop "documentation review normalization" jq -cS . "$DOCS_REVIEW" >"$DOCS_REVIEW_NORMALIZED"
IFS= read -r DOCS_REVIEW_JSON <"$DOCS_REVIEW_NORMALIZED"
```

Record these values in the release brief:

- `DOCS_RUN_ID`;
- `DOCS_RUN_ATTEMPT`;
- `DOCS_RUN_URL`;
- `DOCS_PUBLISH_JOB_URL`;
- the artifact name; and
- `DOCS_REVIEW_JSON`.

The signed tag annotation then retains the exact candidate and approved-empty patch digest after the
workflow artifact expires.

Require no managed PR or branch for this candidate. A PR or branch for a later candidate does not
invalidate this one.

```bash
DOCS_PRS_FILE="$EVIDENCE_DIR/docs-prs.json"
DOCS_BRANCH_FILE="$EVIDENCE_DIR/docs-branch.txt"
run_or_stop "candidate documentation PR read" gh pr list --repo NVIDIA/NemoClaw --state open \
  --head "$DOCS_BRANCH" --limit 100 --json number >"$DOCS_PRS_FILE"
run_or_stop "candidate documentation PR validation" jq -e 'length == 0' "$DOCS_PRS_FILE" >/dev/null
run_or_stop "candidate documentation branch read" git ls-remote --heads origin \
  "refs/heads/$DOCS_BRANCH" >"$DOCS_BRANCH_FILE"
[[ ! -s "$DOCS_BRANCH_FILE" ]] || stop "The candidate documentation branch still exists"
```

This is the initial pending-state check. Do not repeat it before showing the release brief. Run the
self-contained final recheck below only after the maintainer confirms the tag.

## Image and Launchable Evidence

Query the candidate's check runs once and select the newest successful check for each required job.
Then inspect only the one or two workflow run attempts that own those checks. The
`base-image-publication` job runs the checked-in applicable-publication verifier, including every
required publisher and immutable Deep Agents Code base contract. Trust the aggregate instead of
repeating its publisher queries. `Exact staging Brev Launchable` builds the candidate image, boots
that exact image, verifies the baked runtime, runs full E2E, and verifies workspace cleanup.

```bash
CHECK_RUNS_FILE="$EVIDENCE_DIR/candidate-check-runs.json"
run_or_stop "candidate check-run list" gh api --paginate --slurp \
  -H "Accept: application/vnd.github+json" \
  "repos/NVIDIA/NemoClaw/commits/${CANDIDATE_SHA}/check-runs?filter=all&per_page=100" \
  >"$CHECK_RUNS_FILE"
SELECTED_CHECKS_FILE="$EVIDENCE_DIR/selected-image-checks.json"
run_or_stop "image check-run selection" jq -er '
  def successful_check($name):
    ([.[].check_runs[]? |
      select(.name == $name and .status == "completed" and .conclusion == "success")] |
      sort_by(.completed_at) | last) as $check |
    if $check == null then
      error("No successful candidate check run named \($name) was found")
    else
      ($check | (.details_url // .html_url // "") |
        capture("/actions/runs/(?<runId>[0-9]+)/job/(?<jobId>[0-9]+)(?:[?].*)?$")) as $owner |
      {
        name: $check.name,
        runId: ($owner.runId | tonumber),
        jobId: ($owner.jobId | tonumber),
        jobUrl: ($check.html_url // $check.details_url),
        completedAt: $check.completed_at
      }
    end;
  {
    base: successful_check("base-image-publication"),
    launchable: successful_check("Exact staging Brev Launchable")
  }
' "$CHECK_RUNS_FILE" >"$SELECTED_CHECKS_FILE"
SELECTED_CHECK_FIELDS_FILE="$EVIDENCE_DIR/selected-image-check-fields.txt"
run_or_stop "image check-run field read" jq -er '
  [.base.runId, .base.jobId, .launchable.runId, .launchable.jobId] | .[]
' "$SELECTED_CHECKS_FILE" >"$SELECTED_CHECK_FIELDS_FILE"
{
  IFS= read -r BASE_IMAGE_RUN_ID
  IFS= read -r BASE_IMAGE_JOB_ID
  IFS= read -r LAUNCHABLE_RUN_ID
  IFS= read -r LAUNCHABLE_JOB_ID
} <"$SELECTED_CHECK_FIELDS_FILE"

BASE_IMAGE_JOB_FILE="$EVIDENCE_DIR/base-image-job.json"
LAUNCHABLE_JOB_FILE="$EVIDENCE_DIR/launchable-job.json"
run_or_stop "base image job read" gh api \
  "repos/NVIDIA/NemoClaw/actions/jobs/${BASE_IMAGE_JOB_ID}" >"$BASE_IMAGE_JOB_FILE"
run_or_stop "Launchable job read" gh api \
  "repos/NVIDIA/NemoClaw/actions/jobs/${LAUNCHABLE_JOB_ID}" >"$LAUNCHABLE_JOB_FILE"
run_or_stop "base image job validation" jq -e --arg sha "$CANDIDATE_SHA" \
  --argjson run "$BASE_IMAGE_RUN_ID" --argjson job "$BASE_IMAGE_JOB_ID" '
  .id == $job and .run_id == $run and
  (.run_attempt | type) == "number" and .run_attempt >= 1 and
  .run_attempt == (.run_attempt | floor) and .head_sha == $sha and
  .name == "base-image-publication" and
  .status == "completed" and .conclusion == "success"
' "$BASE_IMAGE_JOB_FILE" >/dev/null
run_or_stop "Launchable job validation" jq -e --arg sha "$CANDIDATE_SHA" \
  --argjson run "$LAUNCHABLE_RUN_ID" --argjson job "$LAUNCHABLE_JOB_ID" '
  .id == $job and .run_id == $run and
  (.run_attempt | type) == "number" and .run_attempt >= 1 and
  .run_attempt == (.run_attempt | floor) and .head_sha == $sha and
  .name == "Exact staging Brev Launchable" and
  .status == "completed" and .conclusion == "success"
' "$LAUNCHABLE_JOB_FILE" >/dev/null
IMAGE_JOB_FIELDS_FILE="$EVIDENCE_DIR/image-job-fields.txt"
run_or_stop "base image job field read" jq -er '[.run_attempt, .html_url] | .[]' \
  "$BASE_IMAGE_JOB_FILE" >"$IMAGE_JOB_FIELDS_FILE"
{
  IFS= read -r BASE_IMAGE_ATTEMPT
  IFS= read -r BASE_IMAGE_JOB_URL
} <"$IMAGE_JOB_FIELDS_FILE"
run_or_stop "Launchable job field read" jq -er '[.run_attempt, .html_url] | .[]' \
  "$LAUNCHABLE_JOB_FILE" >"$IMAGE_JOB_FIELDS_FILE"
{
  IFS= read -r LAUNCHABLE_ATTEMPT
  IFS= read -r LAUNCHABLE_JOB_URL
} <"$IMAGE_JOB_FIELDS_FILE"

OWNING_RUNS_FILE="$EVIDENCE_DIR/image-owning-runs.txt"
run_or_stop "image owning run selection" jq -nr \
  --arg baseRun "$BASE_IMAGE_RUN_ID" --arg baseAttempt "$BASE_IMAGE_ATTEMPT" \
  --arg launchableRun "$LAUNCHABLE_RUN_ID" --arg launchableAttempt "$LAUNCHABLE_ATTEMPT" '
  [[$baseRun, $baseAttempt], [$launchableRun, $launchableAttempt]] | unique | .[] | @tsv
' >"$OWNING_RUNS_FILE"
while IFS=$'\t' read -r RUN_ID RUN_ATTEMPT; do
  RUN_FILE="$EVIDENCE_DIR/e2e-run-${RUN_ID}-${RUN_ATTEMPT}.json"
  run_or_stop "E2E run $RUN_ID attempt $RUN_ATTEMPT read" gh api \
    "repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}" >"$RUN_FILE"
done <"$OWNING_RUNS_FILE"
BASE_IMAGE_RUN_FILE="$EVIDENCE_DIR/e2e-run-${BASE_IMAGE_RUN_ID}-${BASE_IMAGE_ATTEMPT}.json"
LAUNCHABLE_RUN_FILE="$EVIDENCE_DIR/e2e-run-${LAUNCHABLE_RUN_ID}-${LAUNCHABLE_ATTEMPT}.json"
run_or_stop "base image run validation" jq -e --arg sha "$CANDIDATE_SHA" \
  --argjson attempt "$BASE_IMAGE_ATTEMPT" '
  .head_sha == $sha and .run_attempt == $attempt and
  .path == ".github/workflows/e2e.yaml" and .head_branch == "main" and
  (.event == "push" or .event == "workflow_dispatch")
' "$BASE_IMAGE_RUN_FILE" >/dev/null
run_or_stop "Launchable run validation" jq -e --arg sha "$CANDIDATE_SHA" \
  --argjson attempt "$LAUNCHABLE_ATTEMPT" '
  .head_sha == $sha and .run_attempt == $attempt and
  .path == ".github/workflows/e2e.yaml" and .head_branch == "main" and
  .event == "workflow_dispatch"
' "$LAUNCHABLE_RUN_FILE" >/dev/null
IMAGE_RUN_FIELDS_FILE="$EVIDENCE_DIR/image-run-fields.txt"
run_or_stop "base image run field read" jq -er '.html_url' \
  "$BASE_IMAGE_RUN_FILE" >"$IMAGE_RUN_FIELDS_FILE"
IFS= read -r BASE_IMAGE_RUN_URL <"$IMAGE_RUN_FIELDS_FILE"
run_or_stop "Launchable run field read" jq -er '.html_url' \
  "$LAUNCHABLE_RUN_FILE" >"$IMAGE_RUN_FIELDS_FILE"
IFS= read -r LAUNCHABLE_RUN_URL <"$IMAGE_RUN_FIELDS_FILE"
```

Record these values:

- `BASE_IMAGE_RUN_ID`;
- `BASE_IMAGE_ATTEMPT`;
- `BASE_IMAGE_RUN_URL`;
- `BASE_IMAGE_JOB_URL`;
- `LAUNCHABLE_RUN_ID`;
- `LAUNCHABLE_ATTEMPT`;
- `LAUNCHABLE_RUN_URL`; and
- `LAUNCHABLE_JOB_URL`.

Download only that run's private receipts and bind them to the candidate:

```bash
LAUNCHABLE_ARTIFACT_DIR="$EVIDENCE_DIR/launchable"
mkdir "$LAUNCHABLE_ARTIFACT_DIR"
ARTIFACT="staging-brev-launchable-${CANDIDATE_SHA}-${LAUNCHABLE_RUN_ID}-${LAUNCHABLE_ATTEMPT}"
run_or_stop "Launchable artifact download" gh run download "$LAUNCHABLE_RUN_ID" \
  --repo NVIDIA/NemoClaw --name "$ARTIFACT" --dir "$LAUNCHABLE_ARTIFACT_DIR"
LAUNCHABLE_RECEIPT="$LAUNCHABLE_ARTIFACT_DIR/launchable-e2e.json"
FULL_E2E_LOG="$LAUNCHABLE_ARTIFACT_DIR/full-e2e.log"
CLEANUP_RECEIPT="$LAUNCHABLE_ARTIFACT_DIR/cleanup.json"
[[ -f "$LAUNCHABLE_RECEIPT" && -s "$FULL_E2E_LOG" && -f "$CLEANUP_RECEIPT" ]] || \
  stop "The successful Launchable evidence is incomplete"
run_or_stop "full E2E log validation" grep -Fxq 'NEMOCLAW_FULL_E2E_PASSED' "$FULL_E2E_LOG"
run_or_stop "Launchable receipt validation" jq -e --arg sha "$CANDIDATE_SHA" '
  .candidateSha == $sha and
  (.producer.runId | type) == "string" and (.producer.runId | test("^[0-9]+$")) and
  .producer.status == "success" and
  (.boot.bootImage | type) == "string" and (.boot.bootImage | length) > 0 and
  .boot.schemaVersion == 1 and .boot.sourceRepository == "NVIDIA/NemoClaw" and
  .boot.sourcePath == "/opt/nemoclaw-image/NemoClaw" and
  .boot.repoSha == $sha and .boot.provisionSha == $sha and
  (.boot.imageRepositorySha | test("^[0-9a-f]{40}$")) and
  .boot.repoClean == true and .boot.runtimeOverrides == false and
  (.workspace.name | type) == "string" and (.workspace.name | length) > 0 and
  (.workspace.id | type) == "string" and (.workspace.id | length) > 0 and
  .fullE2e == "passed"
' "$LAUNCHABLE_RECEIPT" >/dev/null
run_or_stop "Launchable cleanup validation" jq -e --slurpfile launchable "$LAUNCHABLE_RECEIPT" '
  .workspaceName == $launchable[0].workspace.name and
  .workspaceId == $launchable[0].workspace.id and .status == "ABSENT" and
  (.verifiedAt | type) == "string" and
  (.verifiedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
' "$CLEANUP_RECEIPT" >/dev/null
PRODUCER_RUN_ID_FILE="$EVIDENCE_DIR/producer-run-id"
BOOT_IMAGE_FILE="$EVIDENCE_DIR/boot-image"
IMAGE_REPOSITORY_SHA_FILE="$EVIDENCE_DIR/image-repository-sha"
WORKSPACE_NAME_FILE="$EVIDENCE_DIR/launchable-workspace-name"
WORKSPACE_ID_FILE="$EVIDENCE_DIR/launchable-workspace-id"
CLEANUP_TIME_FILE="$EVIDENCE_DIR/launchable-cleanup-time"
run_or_stop "producer run read" jq -er '.producer.runId' "$LAUNCHABLE_RECEIPT" \
  >"$PRODUCER_RUN_ID_FILE"
run_or_stop "boot image read" jq -er '.boot.bootImage' "$LAUNCHABLE_RECEIPT" >"$BOOT_IMAGE_FILE"
run_or_stop "image repository SHA read" jq -er '.boot.imageRepositorySha' \
  "$LAUNCHABLE_RECEIPT" \
  >"$IMAGE_REPOSITORY_SHA_FILE"
run_or_stop "Launchable workspace name read" jq -er '.workspace.name' "$LAUNCHABLE_RECEIPT" \
  >"$WORKSPACE_NAME_FILE"
run_or_stop "Launchable workspace read" jq -er '.workspace.id' "$LAUNCHABLE_RECEIPT" \
  >"$WORKSPACE_ID_FILE"
run_or_stop "Launchable cleanup time read" jq -er '.verifiedAt' "$CLEANUP_RECEIPT" \
  >"$CLEANUP_TIME_FILE"
IFS= read -r PRODUCER_RUN_ID <"$PRODUCER_RUN_ID_FILE"
IFS= read -r BOOT_IMAGE <"$BOOT_IMAGE_FILE"
IFS= read -r IMAGE_REPOSITORY_SHA <"$IMAGE_REPOSITORY_SHA_FILE"
IFS= read -r LAUNCHABLE_WORKSPACE_NAME <"$WORKSPACE_NAME_FILE"
IFS= read -r LAUNCHABLE_WORKSPACE_ID <"$WORKSPACE_ID_FILE"
IFS= read -r LAUNCHABLE_CLEANUP_TIME <"$CLEANUP_TIME_FILE"
PRODUCER_URL="https://github.com/brevdev/nemoclaw-image/actions/runs/${PRODUCER_RUN_ID}"
```

Record these values:

- `ARTIFACT`;
- the workflow and job URLs;
- the producer run URL;
- the concrete boot image;
- the image-repository SHA;
- the workspace name and ID;
- the full E2E result; and
- the verified cleanup time.

This exact job is the nonwaivable Launchable requirement. The rest of the general E2E suite remains
maintainer context.

If Launchable evidence is missing or failed and the planned candidate still equals `origin/main`,
load `nemoclaw-maintainer-e2e` and request Launchable mode. A new dispatch always tests current
`origin/main`; it cannot create evidence for an older planned candidate. After `main` advances,
either use existing exact-candidate evidence or prepare and plan a new documented candidate before
dispatching. If the base-image aggregate is missing or failed, repair or rerun the affected
publisher workflow and verifier. Neither result can be replaced by the general E2E decision.

## Final Documentation Recheck

Run this block only after the maintainer supplies the exact confirmation phrase. It reads the
candidate from the immutable plan again and does not depend on the earlier evidence shell. If both
checks pass, call the cutter immediately without another wait.

```bash
set -euo pipefail
PLAN_PATH='../nemoclaw-release-vX.Y.Z/plan.json'
FINAL_DOCS_DIR="$(mktemp -d)"
chmod 700 "$FINAL_DOCS_DIR"
trap 'rm -rf "$FINAL_DOCS_DIR"' EXIT

run_or_stop() {
  local label="$1"
  local status
  shift
  if "$@"; then
    return 0
  else
    status=$?
    printf '%s failed with status %s\n' "$label" "$status" >&2
    exit "$status"
  fi
}

stop() {
  printf '%s\n' "$1" >&2
  exit 1
}

FINAL_CANDIDATE_FILE="$FINAL_DOCS_DIR/candidate.txt"
run_or_stop "final release plan read" jq -er '
  if
    (keys | sort) == [
      "nextTag", "originMainCommit", "originMainHeadline",
      "previousTag", "previousTagCommit", "previousTagObject"
    ] and
    (.originMainCommit | test("^[0-9a-f]{40}$"))
  then .originMainCommit
  else error("release plan is invalid")
  end
' "$PLAN_PATH" >"$FINAL_CANDIDATE_FILE"
IFS= read -r CANDIDATE_SHA <"$FINAL_CANDIDATE_FILE"
DOCS_BRANCH="automation/post-merge-docs-${CANDIDATE_SHA:0:12}"

FINAL_DOCS_PRS_FILE="$FINAL_DOCS_DIR/docs-prs.json"
FINAL_DOCS_BRANCH_FILE="$FINAL_DOCS_DIR/docs-branch.txt"
run_or_stop "final candidate documentation PR read" gh pr list --repo NVIDIA/NemoClaw --state open \
  --head "$DOCS_BRANCH" --limit 100 --json number >"$FINAL_DOCS_PRS_FILE"
run_or_stop "final candidate documentation PR validation" jq -e 'length == 0' \
  "$FINAL_DOCS_PRS_FILE" >/dev/null
run_or_stop "final candidate documentation branch read" git ls-remote --heads origin \
  "refs/heads/$DOCS_BRANCH" >"$FINAL_DOCS_BRANCH_FILE"
[[ ! -s "$FINAL_DOCS_BRANCH_FILE" ]] || stop "The candidate documentation branch still exists"
```

Treat the confirmation as consumed if a read fails or pending state appears. Resolve that state and
request a new confirmation.
