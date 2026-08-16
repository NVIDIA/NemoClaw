---
name: nemoclaw-maintainer-e2e
description: Dispatches and verifies trusted or administrator-authorized GitHub Actions E2E for NemoClaw maintainers, including manual PR E2E for the latest PR commit and staging Launchable image publication. Use for requests such as run E2E for PR #123, run native runtime qualification, run the E2E suite, publish the Launchable image, run the Launchable E2E, run the full E2E suite, deploy pre-release full E2E, run pre-tag full E2E, or run release-candidate E2E.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Maintainer E2E

Use `.github/workflows/e2e.yaml` from trusted `main` except for the narrow
administrator-only native runtime PR source-branch workflow path documented
below.
Each push to `main` selects catalogue targets and retained workflow jobs that own changed files.
Each trusted push also selects the CPU-only `jetson-nvmap-gpu` proof.
Push runs skip `llama-cpp-dgx-spark-plan` and `llama-cpp-dgx-spark-qualification` because push events cannot set the required workflow dispatch flag.
Manual Jetson runs remain opt-in through `allow_jetson_dispatch`, which defaults to `false`.
Push runs publish `Relevant E2E` and do not publish `Release qualification`.
Only the full `workflow_dispatch` mode, with or without an administrator-authorized job waiver, publishes `Release qualification`.
Do not substitute local `npm run test:live-e2e` unless the maintainer explicitly requests local execution.

## Manual PR E2E

Use this mode when the maintainer requests E2E for a pull request.
It normally runs an authorized E2E selection against the latest PR commit
while the workflow definition remains on `main`. The native runtime producer
also accepts the administrator-only source-branch workflow path below for an
open same-repository PR.
It is advisory and does not create a required PR check.

An empty-selector manual run exposes these values to candidate-controlled job processes:

- Long-lived API keys from repository secrets: `NVIDIA_INFERENCE_API_KEY`, `NVIDIA_API_KEY`, and `BRAVE_API_KEY`.
- Long-lived messaging credentials from repository secrets: `TELEGRAM_BOT_TOKEN_REAL`, `DISCORD_BOT_TOKEN_REAL`, `SLACK_BOT_TOKEN_REAL`, and `SLACK_APP_TOKEN_REAL`.
- The job-scoped `GITHUB_TOKEN` in the `token-rotation` and `openshell-gateway-upgrade` jobs. It has `checks: read`, `contents: read`, and `pull-requests: read` access. Candidate code can use it while either job runs. GitHub Actions invalidates it after the job.
- Messaging account and channel identifiers from repository secrets: `TELEGRAM_ALLOWED_IDS`, `TELEGRAM_AUTHORIZED_CHAT_IDS`, `TELEGRAM_CHAT_ID`, `TELEGRAM_CHAT_ID_E2E`, `DISCORD_CHANNEL_ID_E2E`, and `SLACK_CHANNEL_ID_E2E`.

The workflow does not rotate or revoke these API keys or messaging credentials. To remove later access, rotate or revoke every listed credential in the external service that issued it. The workflow cannot erase identifiers copied by candidate code. Review the complete candidate diff before dispatch.
Live targets can create external resources.
After a failure, inspect the artifacts and remove resources that target cleanup did not remove.

`Publish staging Brev Launchable image` reads this credential from repository Actions secrets:

- `NEMOCLAW_IMAGE_DISPATCH_TOKEN` is exposed as `GH_TOKEN` only to the trusted host script. It grants Actions read/write access to `brevdev/nemoclaw-image`, which the script uses to dispatch the image workflow, inspect its run, and download its handoff artifact.

This credential remains valid until it expires or an administrator revokes it in GitHub. Rotate or revoke it to remove later access.
The job does not receive `BREV_API_KEY`, `BREV_ORG_ID`, or `NVIDIA_INFERENCE_API_KEY`.
It does not install or authenticate the Brev CLI, create a workspace, or run inference.
This image-publication credential boundary applies only to trusted Launchable or full manual dispatches against `main`. It does not apply to `main` pushes or manual PR runs.

For `managed-image-protected-runtime`, the workflow supplies the long-lived `NVIDIA_API_KEY` repository secret only to the trusted qualification step. Trusted host code uses it for NGC login and passes it as `NGC_API_KEY` and `NIM_NGC_API_KEY` to the temporary NIM container. Candidate managed sandboxes receive generated local route tokens instead of this key. The live fixture removes the temporary NIM container only if its exact ID, name, requested image, immutable image ID, cohort owner, and provider kind match the recorded authority. The test fails if evidence is missing or ambiguous, a name is reused, authority drifts, removal is indeterminate, or the exact ID or name remains. A cleanup refusal can leave the container and its API key in place until runner teardown. The final workflow step removes the job's isolated Docker credential directory and fails if that removal does not complete. The workflow does not revoke the NVIDIA API key. Revoke it, or rotate it and disable the old value, in the issuing NVIDIA service. Verify that the exposed key is no longer valid.

Resolve the current PR and trusted workflow identities:

```bash
set -euo pipefail
PR_NUMBER=123
git fetch --prune origin main
MAIN_WORKFLOW_SHA="$(git rev-parse origin/main)"
PR_JSON="$(gh api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}")"
test "$(jq -r .state <<<"$PR_JSON")" = open
HEAD_SHA="$(jq -r .head.sha <<<"$PR_JSON")"
BASE_SHA="$(jq -r .base.sha <<<"$PR_JSON")"
HEAD_REPOSITORY="$(jq -r .head.repo.full_name <<<"$PR_JSON")"
HEAD_REF="$(jq -r .head.ref <<<"$PR_JSON")"
test "$(jq -r .base.ref <<<"$PR_JSON")" = main
test "$(jq -r .base.repo.full_name <<<"$PR_JSON")" = NVIDIA/NemoClaw
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$MAIN_WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]]
test -n "$HEAD_REF"
```

Require a review reason containing 10 to 500 printable characters.

Choose exactly one mode:

- For a PR revision run, leave `E2E_JOBS` empty. The run selects:
  - every default-selected free-standing workflow E2E except `Publish staging Brev Launchable image`;
  - every shared credential-free test; and
  - these controller-selected registry targets: `ubuntu-policy-custom-missing-presets-negative`, `ubuntu-repo-cloud-langchain-deepagents-code`, `ubuntu-repo-cloud-openclaw`, and `ubuntu-repo-docker-post-reboot-recovery`.
  The run skips `jetson-nvmap-gpu` unless `allow_jetson_dispatch` is `true`.
  It skips `llama-cpp-dgx-spark-plan` and `llama-cpp-dgx-spark-qualification` unless their runner-queue flag is `true`.
- For protected managed-image runtime qualification, set `E2E_JOBS=managed-image-protected-runtime`. The commit under review must contain `ci/protected-managed-image-multiarch-activation-v1.json` and `ci/protected-managed-image-runtime-activation-v1.json`.
- For native-runtime qualification evidence, set `E2E_JOBS=native-runtime-qualification-producer`. Use a same-repository open PR and the first workflow attempt. Choose either the trusted `main` workflow at the PR-recorded base commit or, after a repository administrator authorizes the commit under review as the workflow commit, the PR source-branch workflow at that commit. The workflow runs each case under a credential-free candidate account on a reviewed ephemeral runner. The commit under review must contain `test/e2e/live/native-runtime-qualification-case.test.ts` before the selector can pass.

For the administrator-authorized source-branch path, record the authorization and
select it explicitly before running the dispatch block:

```bash
NATIVE_RUNTIME_WORKFLOW_MODE=administrator-source-branch
```

Use `NATIVE_RUNTIME_WORKFLOW_MODE=trusted-main` for the trusted `main` native
runtime path. Do not set either value for another job selector.

Leave `targets` empty and keep Launchable disabled:

```bash
E2E_JOBS="${E2E_JOBS:-}"
case "$E2E_JOBS" in
  "" | managed-image-protected-runtime | native-runtime-qualification-producer) ;;
  *) echo "Unsupported manual PR E2E job selector" >&2; exit 1 ;;
esac
WORKFLOW_REF=main
WORKFLOW_SHA="$MAIN_WORKFLOW_SHA"
if [[ "$E2E_JOBS" == "native-runtime-qualification-producer" ]]; then
  case "${NATIVE_RUNTIME_WORKFLOW_MODE:-trusted-main}" in
    trusted-main)
      test "$MAIN_WORKFLOW_SHA" = "$BASE_SHA" || {
        echo "Trusted-main native runtime qualification requires origin/main to equal the PR-recorded base SHA" >&2
        exit 1
      }
      WORKFLOW_SHA="$BASE_SHA"
      ;;
    administrator-source-branch)
      test "$HEAD_REPOSITORY" = "NVIDIA/NemoClaw" || {
        echo "Administrator source-branch qualification requires a same-repository PR" >&2
        exit 1
      }
      WORKFLOW_REF="$HEAD_REF"
      WORKFLOW_SHA="$HEAD_SHA"
      ;;
    *) echo "Unsupported native runtime workflow mode" >&2; exit 1 ;;
  esac
fi
REVIEW_REASON='Reviewed the commit under review and selected E2E boundary.'
CORRELATION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
INFERENCE_MODE=mock
ALLOW_JETSON_DISPATCH=false
ALLOW_DGX_SPARK_RUNNER_QUEUE=false
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref "$WORKFLOW_REF" \
  -f targets= \
  -f "jobs=${E2E_JOBS}" \
  -f "inference_mode=${INFERENCE_MODE}" \
  -f include_staging_brev_launchable=false \
  -f "allow_jetson_dispatch=${ALLOW_JETSON_DISPATCH}" \
  -f "allow_dgx_spark_runner_queue=${ALLOW_DGX_SPARK_RUNNER_QUEUE}" \
  -f "pr_number=${PR_NUMBER}" \
  -f "checkout_sha=${HEAD_SHA}" \
  -f "checkout_repository=${HEAD_REPOSITORY}" \
  -f "base_sha=${BASE_SHA}" \
  -f "workflow_sha=${WORKFLOW_SHA}" \
  -f "review_reason=${REVIEW_REASON}" \
  -f "correlation_id=${CORRELATION_ID}"
```

The trusted `main` pre-checkout path requires current `maintain` or `admin`
permission. The native runtime PR source-branch workflow path requires `admin`
permission for the actor and, when different, the triggering actor. Both paths
validate the actor, open PR, repository, latest PR commit SHA, base SHA, workflow
SHA, review reason, and allowed jobs, targets, and Launchable combination.
A second validation after checkout rejects a changed PR identity before preparation.

The native-runtime producer binds the open PR, candidate commit, base commit,
executing workflow commit, and first workflow attempt. Candidate workflow code
controls the administrator check that the source-branch workflow runs. NemoClaw
repository policy permits only a repository administrator to dispatch this path.
The administrator check is defense in depth, not an independent authorization
boundary. Before dispatch, the administrator must review and authorize the exact
commit, including the workflow and every action or script that the commit loads.

The candidate workflow commit can access each repository secret granted to the
workflow. The runner-only privileged preparation step receives the long-lived
`NVIDIA_API_KEY` repository secret in its environment. It uses the key
to create runner-local registry authentication and pull pinned GPU images. The
step then deletes the registry authentication and unsets the environment
variable before it downloads public model files or runs candidate code. These
actions remove runner-local access but do not revoke the key. The key remains
valid in the issuing NVIDIA service until it expires or that service revokes it.
If exposure occurs or cleanup cannot be confirmed, revoke or rotate the key in
the issuing NVIDIA service. Verify that the old value is invalid.

The unprivileged installer and live-test processes run with `env -i`, receive
no GitHub, model-provider, API, or messaging credential, and run with Docker
unavailable. Configure
`NATIVE_RUNTIME_EPHEMERAL_RUNNER_POOL=enabled` before dispatch. The ARM64 GPU
cases also require `NATIVE_RUNTIME_ARM64_GPU_RUNNER_LABEL`; the workflow provides
no fallback runner. The qualification neither registers nor selects production
Podman and does not establish public Podman support.

The producer stops Docker, masks its service and socket, removes Docker sockets, and rejects a usable `docker` command before candidate execution. It runs the candidate case under a temporary unprivileged account and uploads one evidence artifact for each planned case. Cleanup terminates processes owned by the candidate account and removes that account. If cleanup fails or the runner becomes unavailable, inspect the host and remove the ephemeral runner from service. Recover or replace the runner before dispatching a new run. Do not rerun the same workflow attempt; the producer rejects attempts after the first.

Find and verify the correlated run with bounded GitHub reads:

```bash
RUN_TITLE="E2E PR #${PR_NUMBER} (${CORRELATION_ID})"
MATCHES='[]'
for POLL_INDEX in $(seq 1 30); do
  RUNS="$(gh run list --repo NVIDIA/NemoClaw --workflow e2e.yaml \
    --event workflow_dispatch --branch "$WORKFLOW_REF" --limit 50 \
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
RUN_ID="$(jq -r '.[0].databaseId' <<<"$MATCHES")"
RUN_URL="$(jq -r '.[0].url' <<<"$MATCHES")"
gh run watch "$RUN_ID" --repo NVIDIA/NemoClaw --exit-status
RUN_JSON="$(gh api "repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}")"
jq -e \
  --argjson runId "$RUN_ID" \
  --arg branch "$WORKFLOW_REF" \
  --arg sha "$WORKFLOW_SHA" '
  .id == $runId and
  .event == "workflow_dispatch" and
  .head_sha == $sha and
  .head_branch == $branch and
  .path == ".github/workflows/e2e.yaml" and
  .repository.full_name == "NVIDIA/NemoClaw" and
  .run_attempt == 1 and
  .status == "completed" and
  .conclusion == "success"
' <<<"$RUN_JSON" >/dev/null
CURRENT_PR="$(gh api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}")"
test "$(jq -r .state <<<"$CURRENT_PR")" = open
test "$(jq -r .head.sha <<<"$CURRENT_PR")" = "$HEAD_SHA"
test "$(jq -r .base.sha <<<"$CURRENT_PR")" = "$BASE_SHA"
test "$(jq -r .head.repo.full_name <<<"$CURRENT_PR")" = "$HEAD_REPOSITORY"
test "$(jq -r .head.ref <<<"$CURRENT_PR")" = "$HEAD_REF"
test "$(jq -r .base.ref <<<"$CURRENT_PR")" = main
test "$(jq -r .base.repo.full_name <<<"$CURRENT_PR")" = NVIDIA/NemoClaw
```

For native runtime qualification, workflow success is not sufficient. Resolve
the exact aggregate job and artifact, verify the downloaded archive digest and
exact file inventory, then run the canonical evidence consumer from the exact
workflow checkout. This validates all 24 case identities and every declared
installer, runtime, operation, and NVIDIA CDI receipt digest. The four additional
installer identity receipts are required in each case and reported with their
downloaded SHA-256 digests. This is underlying evidence validation; it is not a
substitute for any separately required collector authority receipt.

```bash
if [[ "$E2E_JOBS" == "native-runtime-qualification-producer" ]]; then
  RUN_ATTEMPT="$(jq -er '.run_attempt | select(. == 1)' <<<"$RUN_JSON")"
  JOBS_JSON="$(gh api --method GET \
    "repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}/jobs" \
    -f per_page=100)"
  jq -e '
    .total_count == (.jobs | length) and
    .total_count >= 1 and
    .total_count <= 100
  ' <<<"$JOBS_JSON" >/dev/null
  AGGREGATE_JOB_ID="$(jq -er \
    --arg name 'Aggregate native runtime qualification evidence' \
    --argjson runId "$RUN_ID" \
    --argjson attempt "$RUN_ATTEMPT" \
    --arg workflowSha "$WORKFLOW_SHA" '
      [.jobs[] | select(
        .name == $name and
        .run_id == $runId and
        .run_attempt == $attempt and
        .head_sha == $workflowSha and
        .status == "completed" and
        .conclusion == "success"
      )] |
      select(length == 1) |
      .[0].id
    ' <<<"$JOBS_JSON")"

  ARTIFACT_NAME="native-runtime-qualification-${HEAD_SHA}"
  ARTIFACTS_JSON="$(gh api --method GET \
    "repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}/artifacts" -f per_page=100)"
  jq -e '
    .total_count == (.artifacts | length) and
    .total_count >= 1 and
    .total_count <= 100
  ' <<<"$ARTIFACTS_JSON" >/dev/null
  ARTIFACT_JSON="$(jq -ec \
    --arg name "$ARTIFACT_NAME" \
    --argjson runId "$RUN_ID" \
    --arg workflowSha "$WORKFLOW_SHA" '
      [.artifacts[] | select(
        .name == $name and
        .expired == false and
        (.size_in_bytes | type) == "number" and
        .size_in_bytes >= 1 and
        .size_in_bytes <= 4194304 and
        .workflow_run.id == $runId and
        .workflow_run.head_sha == $workflowSha and
        (.digest | test("^sha256:[a-f0-9]{64}$"))
      )] |
      select(length == 1) |
      .[0]
    ' <<<"$ARTIFACTS_JSON")"
  ARTIFACT_ID="$(jq -er '.id | select(type == "number" and . >= 1)' <<<"$ARTIFACT_JSON")"
  ARTIFACT_DIGEST="$(jq -er '.digest' <<<"$ARTIFACT_JSON")"
  ARTIFACT_SIZE="$(jq -er '.size_in_bytes' <<<"$ARTIFACT_JSON")"

  EVIDENCE_DIR="$(mktemp -d)"
  chmod 700 "$EVIDENCE_DIR"
  trap 'rm -rf "$EVIDENCE_DIR"' EXIT
  ARCHIVE_PATH="$EVIDENCE_DIR/native-runtime-qualification.zip"
  export ARCHIVE_PATH ARTIFACT_ID
  node --input-type=module <<'DOWNLOAD'
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const limit = 4 * 1024 * 1024;
const artifactId = process.env.ARTIFACT_ID;
const archivePath = process.env.ARCHIVE_PATH;
if (!artifactId || !archivePath) throw new Error("Artifact download identity is missing");
const result = spawnSync(
  "gh",
  ["api", `repos/NVIDIA/NemoClaw/actions/artifacts/${artifactId}/zip`],
  { encoding: null, maxBuffer: limit, timeout: 120_000 },
);
if (
  result.error ||
  result.status !== 0 ||
  !Buffer.isBuffer(result.stdout) ||
  result.stdout.length < 1 ||
  result.stdout.length > limit
) {
  throw new Error("Bounded aggregate artifact download failed");
}
fs.writeFileSync(archivePath, result.stdout, { flag: "wx", mode: 0o600 });
DOWNLOAD
  DOWNLOADED_SIZE="$(wc -c <"$ARCHIVE_PATH" | tr -d '[:space:]')"
  [[ "$DOWNLOADED_SIZE" =~ ^[1-9][0-9]*$ ]] &&
    (( DOWNLOADED_SIZE <= 4194304 ))
  ACTUAL_ARCHIVE_DIGEST="sha256:$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
  test "$ACTUAL_ARCHIVE_DIGEST" = "$ARTIFACT_DIGEST"

  CONFIRMED_ARTIFACT="$(gh api "repos/NVIDIA/NemoClaw/actions/artifacts/${ARTIFACT_ID}")"
  jq -e \
    --argjson id "$ARTIFACT_ID" \
    --arg name "$ARTIFACT_NAME" \
    --arg digest "$ARTIFACT_DIGEST" \
    --argjson size "$ARTIFACT_SIZE" \
    --argjson runId "$RUN_ID" \
    --arg workflowSha "$WORKFLOW_SHA" '
      .id == $id and
      .name == $name and
      .digest == $digest and
      .size_in_bytes == $size and
      .expired == false and
      .workflow_run.id == $runId and
      .workflow_run.head_sha == $workflowSha
    ' <<<"$CONFIRMED_ARTIFACT" >/dev/null

  test -z "$(git status --porcelain=v1 --untracked-files=all)"
  git fetch --no-tags origin "$WORKFLOW_REF"
  test "$(git rev-parse FETCH_HEAD)" = "$WORKFLOW_SHA"
  git switch --detach "$WORKFLOW_SHA"
  test "$(git rev-parse HEAD)" = "$WORKFLOW_SHA"
  test -z "$(git status --porcelain=v1 --untracked-files=all)"
  export ARCHIVE_PATH ARTIFACT_DIGEST ARTIFACT_ID ARTIFACT_NAME ARTIFACT_SIZE
  export AGGREGATE_JOB_ID BASE_SHA HEAD_REPOSITORY HEAD_SHA PR_NUMBER
  export RUN_ATTEMPT RUN_ID WORKFLOW_SHA
  node --experimental-strip-types --no-warnings --input-type=module <<'NODE'
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  listValidatedArtifactZipEntries,
  readValidatedArtifactZipEntryBytes,
} from "./scripts/scorecard/read-artifact-zip.mts";
import {
  consumeNativeRuntimeQualificationEvidence,
  PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION,
} from "./test/e2e/registry/native-runtime-qualification.ts";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const descriptor = fs.openSync(
  required("ARCHIVE_PATH"),
  fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
);
let archive;
try {
  const before = fs.fstatSync(descriptor);
  if (!before.isFile() || before.size < 1 || before.size > 4 * 1024 * 1024) {
    throw new Error("Aggregate artifact archive is oversized or invalid");
  }
  archive = fs.readFileSync(descriptor);
  const after = fs.fstatSync(descriptor);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    archive.length !== before.size
  ) {
    throw new Error("Aggregate artifact archive changed while reading");
  }
} finally {
  fs.closeSync(descriptor);
}
const actualArchiveDigest =
  `sha256:${createHash("sha256").update(archive).digest("hex")}`;
if (actualArchiveDigest !== required("ARTIFACT_DIGEST")) {
  throw new Error("Aggregate artifact digest does not match the consumed bytes");
}
const entries = listValidatedArtifactZipEntries(archive, { maxEntries: 512 });
if (!entries) throw new Error("Aggregate artifact ZIP structure is invalid");
const readReceipt = (receiptPath) =>
  readValidatedArtifactZipEntryBytes(archive, receiptPath, {
    maxBytes: 524_288,
    maxEntries: 512,
  });
const evidencePath = "native-runtime-qualification-evidence.json";
const evidenceBytes = readReceipt(evidencePath);
if (!evidenceBytes) throw new Error("Aggregate evidence envelope is missing");
const evidence = JSON.parse(evidenceBytes.toString("utf8"));
const expectedSource = {
  repository: "NVIDIA/NemoClaw",
  workflow: ".github/workflows/e2e.yaml",
  pullRequestNumber: Number(required("PR_NUMBER")),
  candidateRepository: required("HEAD_REPOSITORY"),
  headSha: required("HEAD_SHA"),
  baseRef: "main",
  baseSha: required("BASE_SHA"),
  runId: Number(required("RUN_ID")),
  attempt: Number(required("RUN_ATTEMPT")),
  jobId: Number(required("AGGREGATE_JOB_ID")),
  artifact: {
    id: Number(required("ARTIFACT_ID")),
    name: required("ARTIFACT_NAME"),
    digest: required("ARTIFACT_DIGEST"),
  },
};
const authority = consumeNativeRuntimeQualificationEvidence(
  PODMAN_PROTECTED_HOST_LOCAL_INFERENCE_QUALIFICATION,
  evidence,
  expectedSource,
  (receiptPath) => readReceipt(receiptPath),
);
const installerNames = [
  "architecture.json",
  "candidate-source.json",
  "docker-absence.json",
  "installed-source.json",
  "installer.sh",
  "invocation.json",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const receipt = (receiptPath) => {
  const bytes = readReceipt(receiptPath);
  if (!bytes) throw new Error(`Missing receipt ${receiptPath}`);
  return { path: receiptPath, sha256: digest(bytes) };
};
const cases = evidence.cases.map((entry) => ({
  caseId: entry.caseId,
  installerReceipts: installerNames.map((name) =>
    receipt(`receipts/${entry.caseId}/installer/${name}`),
  ),
  executionReceipts: [
    receipt(entry.runtime.result.path),
    ...entry.operations.map(({ artifact }) => receipt(artifact.path)),
    ...(entry.nvidiaCdi ? [receipt(entry.nvidiaCdi.artifact.path)] : []),
  ],
}));
const expectedEntries = [
  evidencePath,
  ...cases.flatMap((entry) => [
    ...entry.installerReceipts.map(({ path }) => path),
    ...entry.executionReceipts.map(({ path }) => path),
  ]),
].sort();
if (
  cases.length !== 24 ||
  new Set(cases.map(({ caseId }) => caseId)).size !== 24 ||
  JSON.stringify(entries) !== JSON.stringify(expectedEntries)
) {
  throw new Error("Aggregate artifact does not contain the exact 24-case receipt cohort");
}
console.log(JSON.stringify({
  caseCount: cases.length,
  workflowSha: required("WORKFLOW_SHA"),
  authority: authority.source,
  cases,
}, null, 2));
NODE

  CONFIRMED_PR="$(gh api "repos/NVIDIA/NemoClaw/pulls/${PR_NUMBER}")"
  test "$(jq -r .state <<<"$CONFIRMED_PR")" = open
  test "$(jq -r .head.sha <<<"$CONFIRMED_PR")" = "$HEAD_SHA"
  test "$(jq -r .base.sha <<<"$CONFIRMED_PR")" = "$BASE_SHA"
  test "$(jq -r .head.repo.full_name <<<"$CONFIRMED_PR")" = "$HEAD_REPOSITORY"
  test "$(jq -r .head.ref <<<"$CONFIRMED_PR")" = "$HEAD_REF"
  test "$(jq -r .base.ref <<<"$CONFIRMED_PR")" = main
  test "$(jq -r .base.repo.full_name <<<"$CONFIRMED_PR")" = NVIDIA/NemoClaw
  CONFIRMED_RUN="$(gh api "repos/NVIDIA/NemoClaw/actions/runs/${RUN_ID}")"
  jq -e \
    --argjson runId "$RUN_ID" \
    --argjson attempt "$RUN_ATTEMPT" \
    --arg branch "$WORKFLOW_REF" \
    --arg sha "$WORKFLOW_SHA" '
      .id == $runId and
      .event == "workflow_dispatch" and
      .head_sha == $sha and
      .head_branch == $branch and
      .path == ".github/workflows/e2e.yaml" and
      .repository.full_name == "NVIDIA/NemoClaw" and
      .run_attempt == $attempt and
      .status == "completed" and
      .conclusion == "success"
    ' <<<"$CONFIRMED_RUN" >/dev/null
  CONFIRMED_ARTIFACT="$(gh api "repos/NVIDIA/NemoClaw/actions/artifacts/${ARTIFACT_ID}")"
  jq -e \
    --argjson id "$ARTIFACT_ID" \
    --arg name "$ARTIFACT_NAME" \
    --arg digest "$ARTIFACT_DIGEST" \
    --argjson size "$ARTIFACT_SIZE" \
    --argjson runId "$RUN_ID" \
    --arg workflowSha "$WORKFLOW_SHA" '
      .id == $id and
      .name == $name and
      .digest == $digest and
      .size_in_bytes == $size and
      .expired == false and
      .workflow_run.id == $runId and
      .workflow_run.head_sha == $workflowSha
    ' <<<"$CONFIRMED_ARTIFACT" >/dev/null
fi
```

Return the PR number, PR source repository, latest PR commit SHA, base SHA, workflow ref and SHA,
correlation ID, run ID, run attempt, workflow URL, and result. For native runtime
qualification, also return the aggregate job ID, artifact ID/name/digest, the
24 case IDs, and each case's installer and execution receipt paths and SHA-256
digests.
A changed PR source repository, latest PR commit SHA, or base SHA invalidates the evidence and requires a new run.

## Select the Main Mode

| Request | Mode | `jobs` | `include_staging_brev_launchable` |
|---|---|---|---|
| “Run the E2E suite” | Ordinary | empty | `false` |
| “Publish the Launchable image” | Launchable image | `staging-brev-launchable` | `false` |
| “Run the Launchable E2E” | Clarify before dispatch | not applicable | not applicable |
| “Run the full E2E suite” | Full | empty | `true` |
| “deploy pre-release full E2E” | Full | empty | `true` |
| “run pre-tag full E2E” | Full | empty | `true` |
| “run release-candidate E2E” | Full | empty | `true` |
| “run pre-tag E2E with an administrator job waiver” | Administrator-waived full | empty | `true` |

A generic E2E request must not authorize the Brev Launchable path.
For “Run the Launchable E2E,” explain that issue #8924 blocks automated deployment, runtime, and inference validation.
Ask whether the maintainer wants image publication or advisory validation through `nemoclaw-maintainer-validate-launchable` against one deployed instance.
Do not dispatch until the maintainer selects one of those operations.
Do not infer full mode from words such as “all” or “complete.”
Ask for clarification when the request uses the legacy Launchable E2E phrase or contains conflicting mode phrases.

Ordinary mode selects every default-selected workflow E2E except `Publish staging Brev Launchable image`.
Launchable image mode runs only `Publish staging Brev Launchable image`.
Full mode adds `Publish staging Brev Launchable image` to the default E2E selection in the same workflow run.
The Launchable image job stops after exact image-publication evidence and does not deploy a workspace or run inference.
Administrator-waived full mode runs the full suite but omits the approved execution jobs from release qualification.
Every waived job still runs.
Use this mode only when a repository administrator explicitly authorizes the job IDs and supplies the reason.
The documented invocations for all four modes keep the Jetson dispatch and DGX Spark runner-queue flags set to `false`.

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
  -f allow_jetson_dispatch=false \
  -f allow_dgx_spark_runner_queue=false \
  -f "correlation_id=${CORRELATION_ID}"
```

For Launchable image mode:

```bash
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f jobs=staging-brev-launchable \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=false \
  -f allow_jetson_dispatch=false \
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
  -f allow_jetson_dispatch=false \
  -f allow_dgx_spark_runner_queue=false \
  -f "correlation_id=${CORRELATION_ID}"
```

For administrator-waived full mode, set the approved job IDs and a reason.
The reason must begin with an ASCII letter or digit and contain 10-500 characters chosen from ASCII letters, digits, spaces, and `.,:;/_()'-`.

```bash
RELEASE_QUALIFICATION_WAIVED_JOBS='staging-brev-launchable'
RELEASE_QUALIFICATION_WAIVER_REASON='Repository administrator waived Brev qualification while a Brev administrator replaces an expired credential.'
gh workflow run .github/workflows/e2e.yaml \
  --repo NVIDIA/NemoClaw \
  --ref main \
  -f targets= \
  -f jobs= \
  -f inference_mode=mock \
  -f include_staging_brev_launchable=true \
  -f "release_qualification_waived_jobs=${RELEASE_QUALIFICATION_WAIVED_JOBS}" \
  -f "release_qualification_waiver_reason=${RELEASE_QUALIFICATION_WAIVER_REASON}" \
  -f allow_jetson_dispatch=false \
  -f allow_dgx_spark_runner_queue=false \
  -f "correlation_id=${CORRELATION_ID}"
```

Do not set `jobs=staging-brev-launchable` for full mode.
Empty `jobs` and `targets` select every default-selected workflow E2E except `Publish staging Brev Launchable image`.
The `include_staging_brev_launchable` input adds the Launchable image-publication job to that same run.
The trusted `main` workflow verifies that the dispatching and rerunning actors have
repository `maintain` or `admin` permission before the Launchable path's source
checkout. That role check is the authorization.
For administrator-waived full mode, both `github.actor` and `github.triggering_actor` must have repository `admin` permission.
Both waiver inputs must be nonempty, or both inputs must be empty.
The trusted planner validates the comma-separated IDs against the release-required E2E execution jobs.
It rejects unknown, duplicate, and non-release-required IDs.
Trusted controller jobs cannot be waived.
The planner removes only the approved IDs from `release_required_jobs` and emits canonical waived-job JSON.
The `generate-matrix` dispatch receipt is written after waiver authorization and before that job's source checkout.
It records the requested job IDs, reason, both actor identities, and candidate SHA.
After trusted planner validation, the `Release qualification` summary and waiver artifact record the canonical job IDs and each waived job's completed outcome.
A user permitted to dispatch this workflow may set `allow_jetson_dispatch=true`
to add `jetson-nvmap-gpu` to an empty-selector manual run or enable its explicit
selection. Set it only after the operator-owned service is available and
compatible with HTTP contract
version `1.0.0`, and `JETSON_DISPATCH_URL` contains its verified HTTPS origin.
See [Jetson Dispatch Controller](../../../test/e2e/docs/jetson-dispatch.md).
Require the uploaded Jetson receipt to report `cleanup: "succeeded"`.
A permitted dispatcher may set `allow_dgx_spark_runner_queue=true` to add
`llama-cpp-dgx-spark-plan` and `llama-cpp-dgx-spark-qualification` to an
empty-selector manual run or enable explicit qualification selection. Set it
only after a repository administrator confirms an online DGX Spark runner in
the authoritative runner inventory.
If GitHub pauses the qualification job for the `approve-dgx-spark-image-qualification` environment, an authorized environment reviewer must approve it before qualification starts.
`Publish staging Brev Launchable image` does not require environment approval.

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
gh run watch "$RUN_ID" --repo NVIDIA/NemoClaw
```

Launchable image and full modes can wait in the non-cancelling Launchable concurrency queue.
Queued, waiting, or accepted dispatch state is not success.
Classify the completed workflow and `Release qualification` job with the checks below.

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

Require `run-$RUN_ID.json` to report:

- `head_sha` equal to `CANDIDATE_SHA`;
- `status` equal to `completed`.

For ordinary, Launchable image, and unwaived full modes, require `conclusion` equal to `success`.
For administrator-waived full mode, permit `conclusion` equal to `success` or `failure`.
A `failure` conclusion is acceptable only when one completed, successful `Release qualification` job and a valid exact-run waiver artifact with at least one canonical waived job failure both exist.

For Launchable image mode, also require `jobs-latest-$RUN_ID.json` to contain one completed, successful
`Publish staging Brev Launchable image` job. Return the workflow and job URLs.
Require its artifact to contain `launchable-image.json` for the selected candidate SHA and concrete staging image URI.

For a full run, with or without a job waiver, require `jobs-latest-$RUN_ID.json` to contain one completed, successful
`Release qualification` job. Return its job URL with the workflow URL.
In full mode, that job waits for every default-required result, including `Publish staging Brev Launchable image`.
The Launchable image job verifies only the exact candidate image producer receipt and staging-family publication.
Its `launchable-image.json` artifact records Launchable, runtime, and inference validation as not run.
A skipped, cancelled, queued, or failed `Release qualification` job is not evidence.
A Launchable image-only run is not full-mode or pre-tag release evidence.

For administrator-waived full mode, the job waits for every unwaived release-required result.
A waived execution job may fail without failing `Release qualification`.
For a failed workflow, require the waiver artifact to bind at least one canonical waived job failure to the candidate SHA, run ID and attempt, actors, and reason.
Return the canonical waived-job IDs, their outcomes, reason, both actor identities, and candidate SHA with the workflow and job URLs.

## Bind Release Evidence

If no release plan exists, label a full run with a successful `Release qualification` job against `origin/main` as provisional release evidence.
Return:

- candidate SHA;
- workflow run URL and conclusion;
- `Release qualification` job URL; and
- workflow run attempt.

If the release candidate SHA changes, discard the earlier pre-tag run and dispatch the authorized mode for the new SHA.
No release-note-only delta exception is currently defined.

When `nemoclaw-maintainer-cut-release-tag` invokes this skill, return the exact-SHA workflow and `Release qualification` job URLs.
The stable check is provisional pre-tag E2E evidence until `scripts/release-cut-tag.sh` verifies the canonical GitHub job at the planned commit.
Do not build a second general status ledger from artifacts.
The waiver artifact is narrow binding evidence for a failed workflow, not a replacement for the `Release qualification` result.
Do not ask for the release confirmation phrase in this skill.

## Access Failures

Follow the shared [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md).
Stop on authentication, authorization, remote-access, or permission failures.
