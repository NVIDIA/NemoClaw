<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Candidate Evidence

Candidate evidence is the release-specific evidence required for the planned candidate. Use the
exact version and candidate from `plan.json`. These are read-only checks. Run every section before
the general E2E decision. Keep the shell only until its evidence is copied into the release brief.

```bash
set -euo pipefail
PLAN_PATH="${PLAN_PATH:-../nemoclaw-release-vX.Y.Z/plan.json}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$(mktemp -d)}"
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
      "candidateCommit", "candidateSelection", "historicalCandidateException",
      "nextTag", "originMainCommit",
      "originMainHeadline", "previousTag", "previousTagCommit", "previousTagObject"
    ] and
    (.nextTag | test("^v(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$")) and
    (.candidateCommit | test("^[0-9a-f]{40}$")) and
    (.originMainCommit | test("^[0-9a-f]{40}$")) and
    (.previousTagCommit | test("^[0-9a-f]{40}$")) and
    (
      (.candidateSelection == "current-main" and
       .candidateCommit == .originMainCommit and
       .historicalCandidateException == "None") or
      (.candidateSelection == "historical" and
       .candidateCommit != .originMainCommit and
       (.historicalCandidateException | test("[^[:space:]]")))
    )
  then [
    .nextTag, .candidateCommit, .previousTagCommit,
    .candidateSelection, .historicalCandidateException
  ] | @tsv
  else error("release plan is invalid")
  end
' "$PLAN_PATH" >"$PLAN_FIELDS"
IFS=$'\t' read -r VERSION CANDIDATE_SHA PREVIOUS_TAG_SHA \
  CANDIDATE_SELECTION HISTORICAL_CANDIDATE_EXCEPTION <"$PLAN_FIELDS"
DOCS_PREFIX='automation/post-merge-docs-'
```

## Release Entry and Documentation Coverage

For a current-main plan, find exactly one target heading at the candidate. Save only that H2 section,
ending before the next H2, for the release brief. For a historical plan, record the plan's explicit
release-entry exception instead. Do not use the historical exception for a current-main plan.

```bash
if [[ "$CANDIDATE_SELECTION" == 'historical' ]]; then
  ENTRY_FILE="$EVIDENCE_DIR/release-entry.md"
  ENTRY_PATH='Historical candidate exception'
  printf '%s\n' \
    "Release entry exception: $HISTORICAL_CANDIDATE_EXCEPTION" >"$ENTRY_FILE"
else
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
fi
```

Read documentation coverage from Git history and GitHub PR state. Do not require another
`Docs / Post-Merge Catch-Up` run after the cumulative docs PR merges.

First, list every open managed docs PR. Preserve this JSON for the release brief.

```bash
OPEN_DOCS_PRS="$EVIDENCE_DIR/open-docs-prs.json"
run_or_stop "open documentation PR read" gh pr list --repo NVIDIA/NemoClaw --state open \
  --base main --limit 1000 \
  --json headRefName,headRefOid,headRepository,isDraft,number,title,url >"$OPEN_DOCS_PRS"
run_or_stop "open documentation PR selection" jq -c --arg prefix "$DOCS_PREFIX" '
  [.[] | select(
    (.headRefName | startswith($prefix)) and
    .headRepository.nameWithOwner == "NVIDIA/NemoClaw"
  )]
' "$OPEN_DOCS_PRS" >"$EVIDENCE_DIR/open-managed-docs-prs.json"
```

Next, list merged PRs and select the newest managed docs PR whose merge commit is an ancestor of
`CANDIDATE_SHA`. Do not select a PR only by merge time. If no such PR exists, report that state and
use `PREVIOUS_TAG_SHA` as the conservative coverage point.

```bash
MERGED_DOCS_PRS="$EVIDENCE_DIR/merged-docs-prs.json"
run_or_stop "merged documentation PR read" gh pr list --repo NVIDIA/NemoClaw --state merged \
  --base main --limit 1000 \
  --json headRefName,headRefOid,headRepository,mergeCommit,mergedAt,number,reviewDecision,statusCheckRollup,title,url \
  >"$MERGED_DOCS_PRS"
run_or_stop "merged documentation PR selection" jq -c --arg prefix "$DOCS_PREFIX" '
  [.[] | select(
    (.headRefName | startswith($prefix)) and
    .headRepository.nameWithOwner == "NVIDIA/NemoClaw" and
    (.mergeCommit.oid | test("^[0-9a-f]{40}$"))
  )] | sort_by(.mergedAt) | reverse | .[]
' "$MERGED_DOCS_PRS" >"$EVIDENCE_DIR/managed-docs-pr-candidates.jsonl"
```

For each candidate PR in order, test its merge commit against `CANDIDATE_SHA`. Keep the first
ancestor. Stop on an ancestry-check error. Record the selected PR as JSON and assign every field
before a later command reads it. If there is no match, record `null`, assign `None` to the PR
fields, and use `PREVIOUS_TAG_SHA` as the conservative coverage point.

```bash
SELECTED_DOCS_PR="$EVIDENCE_DIR/selected-docs-pr.json"
: >"$SELECTED_DOCS_PR"
while IFS= read -r DOCS_PR_CANDIDATE; do
  DOCS_PR_MERGE_SHA="$(printf '%s\n' "$DOCS_PR_CANDIDATE" | jq -er '.mergeCommit.oid')"
  if git merge-base --is-ancestor "$DOCS_PR_MERGE_SHA" "$CANDIDATE_SHA"; then
    printf '%s\n' "$DOCS_PR_CANDIDATE" >"$SELECTED_DOCS_PR"
    break
  else
    ANCESTRY_STATUS=$?
    [[ "$ANCESTRY_STATUS" == 1 ]] || stop \
      "documentation PR ancestry check failed with status $ANCESTRY_STATUS"
  fi
done <"$EVIDENCE_DIR/managed-docs-pr-candidates.jsonl"

DOCS_PR_FIELDS="$EVIDENCE_DIR/selected-docs-pr-fields.tsv"
if [[ -s "$SELECTED_DOCS_PR" ]]; then
  run_or_stop "selected documentation PR read" jq -er '
    [
      (.number | tostring),
      .url,
      .mergeCommit.oid,
      .headRefOid,
      (.reviewDecision // "None")
    ] | @tsv
  ' "$SELECTED_DOCS_PR" >"$DOCS_PR_FIELDS"
  IFS=$'\t' read -r DOCS_PR_NUMBER DOCS_PR_URL DOCS_PR_MERGE_SHA \
    DOCS_PR_HEAD_SHA DOCS_PR_REVIEW_DECISION <"$DOCS_PR_FIELDS"
else
  printf 'null\n' >"$SELECTED_DOCS_PR"
  DOCS_PR_NUMBER='None'
  DOCS_PR_URL='None'
  DOCS_PR_MERGE_SHA='None'
  DOCS_PR_HEAD_SHA='None'
  DOCS_PR_REVIEW_DECISION='None'
  DOCS_COVERAGE_SHA="$PREVIOUS_TAG_SHA"
  printf 'None\tNone\tNone\tNone\tNone\n' >"$DOCS_PR_FIELDS"
fi
```

Only when a PR was selected, read all of its commits and files and derive its coverage point.
Otherwise, preserve empty API evidence and the previous-release coverage point without making a
selected-PR API request.

```bash
DOCS_PR_COMMITS="$EVIDENCE_DIR/docs-pr-commits.json"
DOCS_PR_FILES="$EVIDENCE_DIR/docs-pr-files.json"
if [[ "$DOCS_PR_NUMBER" != 'None' ]]; then
  run_or_stop "documentation PR commit read" gh api --paginate --slurp \
    "repos/NVIDIA/NemoClaw/pulls/${DOCS_PR_NUMBER}/commits?per_page=100" >"$DOCS_PR_COMMITS"
  run_or_stop "documentation PR file read" gh api --paginate --slurp \
    "repos/NVIDIA/NemoClaw/pulls/${DOCS_PR_NUMBER}/files?per_page=100" >"$DOCS_PR_FILES"
  run_or_stop "documentation PR final commit verification" jq -er \
    --arg expected "$DOCS_PR_HEAD_SHA" '
    [.[][]] as $commits |
    if
      ($commits | length) > 0 and
      $commits[-1].sha == $expected
    then $commits[-1].sha
    else error("documentation PR final commit does not match headRefOid")
    end
  ' "$DOCS_PR_COMMITS" >"$EVIDENCE_DIR/docs-pr-final-sha"
  run_or_stop "documentation PR check rollup read" jq -ce '
    if (.statusCheckRollup | type) == "array"
    then .statusCheckRollup
    else error("documentation PR check rollup is missing")
    end
  ' "$SELECTED_DOCS_PR" >"$EVIDENCE_DIR/docs-pr-checks.json"
  run_or_stop "documentation coverage commit selection" jq -er \
    --arg message $'docs: catch up after main\n\nSigned-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>' '
    [.[][] | select(
      .commit.message == $message and
      .commit.author.email == "41898282+github-actions[bot]@users.noreply.github.com" and
      .commit.verification.verified == true and
      ((.parents | length) == 1 or (.parents | length) == 2)
    )] | last | .parents[-1].sha
  ' "$DOCS_PR_COMMITS" >"$EVIDENCE_DIR/docs-coverage-sha"
  IFS= read -r DOCS_COVERAGE_SHA <"$EVIDENCE_DIR/docs-coverage-sha"
  run_or_stop "documentation coverage ancestry" git merge-base --is-ancestor \
    "$DOCS_COVERAGE_SHA" "$CANDIDATE_SHA"
  run_or_stop "documentation changed-path read" jq -r '.[].[] | .filename' \
    "$DOCS_PR_FILES" >"$EVIDENCE_DIR/docs-changed-paths.txt"
else
  printf '[]\n' >"$DOCS_PR_COMMITS"
  printf '[]\n' >"$DOCS_PR_FILES"
  printf 'None\n' >"$EVIDENCE_DIR/docs-pr-final-sha"
  printf '[]\n' >"$EVIDENCE_DIR/docs-pr-checks.json"
  printf '%s\n' "$DOCS_COVERAGE_SHA" >"$EVIDENCE_DIR/docs-coverage-sha"
  : >"$EVIDENCE_DIR/docs-changed-paths.txt"
fi
```

Confirm that every changed path is under `docs/**`, `fern/docs.yml`, or `fern/assets/**`. Report
the result instead of converting it into an automatic tag gate. The selected PR's final commit must
match its recorded `headRefOid`; show its review decision and every completed, failed, pending, or
skipped check.

List all first-parent commits after the coverage point through the candidate:

```bash
run_or_stop "documentation coverage gap read" git log --first-parent \
  --format='%H%x09%s' "${DOCS_COVERAGE_SHA}..${CANDIDATE_SHA}" \
  >"$EVIDENCE_DIR/docs-coverage-gap.tsv"
```

For each commit in that file, read `repos/NVIDIA/NemoClaw/commits/<sha>/pulls` with the GitHub
`groot-preview` media type. Show the associated merged PR number, title, and URL. The docs PR merge
itself can appear in this range; identify any other merge as work after the final automated refresh.

Record all of this evidence in the release brief:

- target tag and candidate commit;
- latest included cumulative docs PR, its final PR commit, and its merge commit, or `None`;
- the final automated refresh coverage commit, or the previous release commit when none exists;
- every commit and merged PR after that coverage point through the candidate;
- whether the docs PR changed only allowed documentation paths;
- the docs PR review decision and complete check state;
- every open managed docs PR; and
- the canonical release entry and path for a current-main plan; or
- the plan-bound release-entry exception for a historical plan.

Then offer exactly these choices:

1. Proceed with the candidate as shown.
2. Create or update a docs PR for the uncovered range.
3. Stop tagging.

If the maintainer selects option 1, add this exact line to the signed release brief:

```text
- Maintainer decision: Proceed with the candidate as shown.
```

If the maintainer selects option 2 or 3, stop before the E2E decision and tag confirmation.
If documentation work changes the intended candidate, generate a new immutable release plan.

## Image Evidence

Query the candidate's check runs once and select the newest successful `base-image-publication`
check. Then inspect the workflow run attempt that owns it. The
`base-image-publication` job runs the checked-in applicable-publication verifier, including every
required publisher and immutable Deep Agents Code base contract. Trust the aggregate instead of
repeating its publisher queries.

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
  {base: successful_check("base-image-publication")}
' "$CHECK_RUNS_FILE" >"$SELECTED_CHECKS_FILE"
SELECTED_CHECK_FIELDS_FILE="$EVIDENCE_DIR/selected-image-check-fields.txt"
run_or_stop "image check-run field read" jq -er '
  [.base.runId, .base.jobId] | .[]
' "$SELECTED_CHECKS_FILE" >"$SELECTED_CHECK_FIELDS_FILE"
{
  IFS= read -r BASE_IMAGE_RUN_ID
  IFS= read -r BASE_IMAGE_JOB_ID
} <"$SELECTED_CHECK_FIELDS_FILE"

BASE_IMAGE_JOB_FILE="$EVIDENCE_DIR/base-image-job.json"
run_or_stop "base image job read" gh api \
  "repos/NVIDIA/NemoClaw/actions/jobs/${BASE_IMAGE_JOB_ID}" >"$BASE_IMAGE_JOB_FILE"
run_or_stop "base image job validation" jq -e --arg sha "$CANDIDATE_SHA" \
  --argjson run "$BASE_IMAGE_RUN_ID" --argjson job "$BASE_IMAGE_JOB_ID" '
  .id == $job and .run_id == $run and
  (.run_attempt | type) == "number" and .run_attempt >= 1 and
  .run_attempt == (.run_attempt | floor) and .head_sha == $sha and
  .name == "base-image-publication" and
  .status == "completed" and .conclusion == "success"
' "$BASE_IMAGE_JOB_FILE" >/dev/null
IMAGE_JOB_FIELDS_FILE="$EVIDENCE_DIR/image-job-fields.txt"
run_or_stop "base image job field read" jq -er '[.run_attempt, .html_url] | .[]' \
  "$BASE_IMAGE_JOB_FILE" >"$IMAGE_JOB_FIELDS_FILE"
{
  IFS= read -r BASE_IMAGE_ATTEMPT
  IFS= read -r BASE_IMAGE_JOB_URL
} <"$IMAGE_JOB_FIELDS_FILE"
BASE_IMAGE_RUN_FILE="$EVIDENCE_DIR/e2e-run-${BASE_IMAGE_RUN_ID}-${BASE_IMAGE_ATTEMPT}.json"
run_or_stop "base image run read" gh api \
  "repos/NVIDIA/NemoClaw/actions/runs/${BASE_IMAGE_RUN_ID}/attempts/${BASE_IMAGE_ATTEMPT}" \
  >"$BASE_IMAGE_RUN_FILE"
run_or_stop "base image run validation" jq -e --arg sha "$CANDIDATE_SHA" \
  --argjson attempt "$BASE_IMAGE_ATTEMPT" '
  .head_sha == $sha and .run_attempt == $attempt and
  .path == ".github/workflows/e2e.yaml" and .head_branch == "main" and
  (.event == "push" or .event == "workflow_dispatch")
' "$BASE_IMAGE_RUN_FILE" >/dev/null
IMAGE_RUN_FIELDS_FILE="$EVIDENCE_DIR/image-run-fields.txt"
run_or_stop "base image run field read" jq -er '.html_url' \
  "$BASE_IMAGE_RUN_FILE" >"$IMAGE_RUN_FIELDS_FILE"
IFS= read -r BASE_IMAGE_RUN_URL <"$IMAGE_RUN_FIELDS_FILE"
```

Record these values:

- `BASE_IMAGE_RUN_ID`;
- `BASE_IMAGE_ATTEMPT`;
- `BASE_IMAGE_RUN_URL`;
- `BASE_IMAGE_JOB_URL`.

## Optional Launchable E2E Evidence

Skip this section unless the maintainer requests or cites a Launchable result in the E2E decision.
When used, validate its cleanup receipts because the Brev workspace receives credentials.

```bash
SELECTED_LAUNCHABLE_CHECK_FILE="$EVIDENCE_DIR/selected-launchable-check.json"
run_or_stop "Launchable check-run selection" jq -er '
  ([.[].check_runs[]? |
    select(.name == "Exact staging Brev Launchable" and
      .status == "completed" and .conclusion == "success")] |
    sort_by(.completed_at) | last) as $check |
  if $check == null then
    error("No successful candidate Launchable check run was found")
  else
    ($check | (.details_url // .html_url // "") |
      capture("/actions/runs/(?<runId>[0-9]+)/job/(?<jobId>[0-9]+)(?:[?].*)?$")) as $owner |
    {runId: ($owner.runId | tonumber), jobId: ($owner.jobId | tonumber)}
  end
' "$CHECK_RUNS_FILE" >"$SELECTED_LAUNCHABLE_CHECK_FILE"
LAUNCHABLE_CHECK_FIELDS_FILE="$EVIDENCE_DIR/selected-launchable-check-fields.txt"
run_or_stop "Launchable check-run field read" jq -er '[.runId, .jobId] | .[]' \
  "$SELECTED_LAUNCHABLE_CHECK_FILE" >"$LAUNCHABLE_CHECK_FIELDS_FILE"
{
  IFS= read -r LAUNCHABLE_RUN_ID
  IFS= read -r LAUNCHABLE_JOB_ID
} <"$LAUNCHABLE_CHECK_FIELDS_FILE"

LAUNCHABLE_JOB_FILE="$EVIDENCE_DIR/launchable-job.json"
run_or_stop "Launchable job read" gh api \
  "repos/NVIDIA/NemoClaw/actions/jobs/${LAUNCHABLE_JOB_ID}" >"$LAUNCHABLE_JOB_FILE"
run_or_stop "Launchable job validation" jq -e --arg sha "$CANDIDATE_SHA" \
  --argjson run "$LAUNCHABLE_RUN_ID" --argjson job "$LAUNCHABLE_JOB_ID" '
  .id == $job and .run_id == $run and .head_sha == $sha and
  .name == "Exact staging Brev Launchable" and
  .status == "completed" and .conclusion == "success"
' "$LAUNCHABLE_JOB_FILE" >/dev/null
LAUNCHABLE_JOB_FIELDS_FILE="$EVIDENCE_DIR/launchable-job-fields.txt"
run_or_stop "Launchable job field read" jq -er '[.run_attempt, .html_url] | .[]' \
  "$LAUNCHABLE_JOB_FILE" >"$LAUNCHABLE_JOB_FIELDS_FILE"
{
  IFS= read -r LAUNCHABLE_ATTEMPT
  IFS= read -r LAUNCHABLE_JOB_URL
} <"$LAUNCHABLE_JOB_FIELDS_FILE"
LAUNCHABLE_RUN_FILE="$EVIDENCE_DIR/e2e-run-${LAUNCHABLE_RUN_ID}-${LAUNCHABLE_ATTEMPT}.json"
run_or_stop "Launchable run read" gh api \
  "repos/NVIDIA/NemoClaw/actions/runs/${LAUNCHABLE_RUN_ID}/attempts/${LAUNCHABLE_ATTEMPT}" \
  >"$LAUNCHABLE_RUN_FILE"
run_or_stop "Launchable run validation" jq -e --arg sha "$CANDIDATE_SHA" \
  --argjson attempt "$LAUNCHABLE_ATTEMPT" '
  .head_sha == $sha and .run_attempt == $attempt and
  .path == ".github/workflows/e2e.yaml" and .head_branch == "main" and
  .event == "workflow_dispatch"
' "$LAUNCHABLE_RUN_FILE" >/dev/null
run_or_stop "Launchable run field read" jq -er '.html_url' \
  "$LAUNCHABLE_RUN_FILE" >"$IMAGE_RUN_FIELDS_FILE"
IFS= read -r LAUNCHABLE_RUN_URL <"$IMAGE_RUN_FIELDS_FILE"
```

Download that run's private receipts and bind them to the candidate:

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

If Launchable cleanup fails, report the workspace and follow the cleanup and credential-remediation
boundary in `nemoclaw-maintainer-e2e`. This remains operational follow-up, not a tag gate.

If the base-image aggregate is missing or failed, repair or rerun the affected publisher workflow
and verifier. The general E2E decision cannot replace required image evidence.
