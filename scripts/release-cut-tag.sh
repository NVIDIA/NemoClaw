#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

PLAN_PATH=""
CONFIRMATION="${RELEASE_CONFIRMATION:-}"
PREFLIGHT_ONLY=false
SCHEDULED=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)
      PLAN_PATH="${2:-}"
      shift 2
      ;;
    --confirm)
      CONFIRMATION="${2:-}"
      shift 2
      ;;
    --preflight-only)
      PREFLIGHT_ONLY=true
      shift
      ;;
    --scheduled)
      SCHEDULED=true
      shift
      ;;
    --help | -h)
      cat <<'USAGE'
Usage:
  scripts/release-cut-tag.sh --plan PATH --preflight-only
  scripts/release-cut-tag.sh --plan PATH --confirm "CONFIRM RELEASE vX.Y.Z <sha>"
  scripts/release-cut-tag.sh --plan PATH --scheduled

Preflight mode verifies that Git can create a signed annotated semver tag with the configured signer.
Confirmed mode cuts a manual plan or recovers a frozen scheduled plan.
Scheduled mode is accepted only in the canonical 4 AM workflow and never consults E2E state.
USAGE
      exit 0
      ;;
    *)
      echo "release-cut-tag: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

fail() {
  echo "release-cut-tag: $*" >&2
  exit 1
}

[[ -n "$PLAN_PATH" ]] || fail "--plan is required"
[[ -f "$PLAN_PATH" ]] || fail "Plan file not found: $PLAN_PATH"
if [[ "$PREFLIGHT_ONLY" != true && "$SCHEDULED" != true ]]; then
  [[ -n "$CONFIRMATION" ]] || fail "--confirm is required"
fi
[[ "$PREFLIGHT_ONLY" != true || "$SCHEDULED" != true ]] || fail "--scheduled and --preflight-only are mutually exclusive"

json_field() {
  node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const path=process.argv[2].split("."); let value=data; for (const key of path) value=value?.[key]; if (value == null) process.exit(1); process.stdout.write(String(value));' "$PLAN_PATH" "$1"
}

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

status="$(git status --short)"
[[ -z "$status" ]] || fail "Release tagging requires a clean worktree"

node -e '
const fs=require("fs"); const crypto=require("crypto");
const data=JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const semver=/^v\d+\.\d+\.\d+$/; const sha=/^[0-9a-f]{40}$/; const hash=/^[0-9a-f]{64}$/;
if (data.schemaVersion !== 2) throw new Error("schemaVersion must be 2");
if (data.mode !== "tag-only") throw new Error("mode must be tag-only");
if (data.status !== "ready" && data.status !== "no-changes") throw new Error("invalid plan status");
if (!semver.test(data.previousTag) || !semver.test(data.nextTag)) throw new Error("release tags must be semver");
if (!sha.test(data.originMainAtPlanning) || !sha.test(data.candidateCommit)) throw new Error("plan commits must be full SHAs");
if (!Number.isSafeInteger(data.untaggedCommitCount) || data.untaggedCommitCount < 0) throw new Error("untaggedCommitCount must be a nonnegative integer");
if (data.status === "ready" && (typeof data.changelogEntry !== "string" || data.changelogEntry.length === 0)) throw new Error("ready plans require changelogEntry");
if (data.status === "no-changes" && data.untaggedCommitCount !== 0) throw new Error("no-changes plans require zero untagged commits");
if (data.authorization?.type !== "maintainer-confirmation" && data.authorization?.type !== "scheduled-workflow") throw new Error("invalid release authorization");
if (data.authorization.type === "scheduled-workflow") {
  if (data.authorization.repository !== "NVIDIA/NemoClaw") throw new Error("invalid scheduled repository");
  if (data.authorization.plannerWorkflow !== ".github/workflows/release-edition-close.yaml") throw new Error("invalid planner workflow");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.authorization.editionDate)) throw new Error("invalid edition date");
  if (typeof data.authorization.cutoffAt !== "string" || Number.isNaN(Date.parse(data.authorization.cutoffAt))) throw new Error("invalid edition cutoff");
  const source=data.authorization.candidateSource;
  if (source?.type !== "github-actions-push-run") throw new Error("invalid candidate source type");
  if (source.workflow !== ".github/workflows/post-merge-agent-review.yaml") throw new Error("invalid candidate source workflow");
  if (!/^\d+$/.test(source.runId)) throw new Error("invalid candidate source run ID");
  if (typeof source.recordedAt !== "string" || Number.isNaN(Date.parse(source.recordedAt))) throw new Error("invalid candidate source time");
  if (Date.parse(source.recordedAt) > Date.parse(data.authorization.cutoffAt)) throw new Error("candidate source is after edition cutoff");
}
if (!hash.test(data.planHash)) throw new Error("planHash must be a sha256 hex string");
const {planHash, ...planWithoutHash}=data;
const actual=crypto.createHash("sha256").update(JSON.stringify(planWithoutHash, null, 2)).digest("hex");
if (actual !== planHash) throw new Error("planHash mismatch: expected " + planHash + ", recomputed " + actual);
' "$PLAN_PATH"

schema_version="$(json_field schemaVersion)"
plan_status="$(json_field status)"
authorization_type="$(json_field authorization.type)"
previous_tag="$(json_field previousTag)"
tag="$(json_field nextTag)"
target="$(json_field candidateCommit)"
expected_confirmation="$(json_field confirmationPhrase)"
plan_hash="$(json_field planHash)"

[[ "$schema_version" == "2" ]] || fail "Unsupported plan schemaVersion: $schema_version"
if [[ "$SCHEDULED" == true ]]; then
  [[ "$authorization_type" == "scheduled-workflow" ]] || fail "Scheduled cuts require scheduled-workflow authorization"
  [[ "${GITHUB_ACTIONS:-}" == "true" ]] || fail "Scheduled cuts require GitHub Actions"
  [[ "${GITHUB_REPOSITORY:-}" == "NVIDIA/NemoClaw" ]] || fail "Scheduled cuts require NVIDIA/NemoClaw"
  [[ "${GITHUB_EVENT_NAME:-}" == "schedule" ]] || fail "Scheduled cuts require a schedule event"
  expected_workflow_ref="NVIDIA/NemoClaw/.github/workflows/release-edition-cut.yaml@refs/heads/main"
  [[ "${GITHUB_WORKFLOW_REF:-}" == "$expected_workflow_ref" ]] || fail "Scheduled cuts require the canonical main-branch workflow"
elif [[ "$PREFLIGHT_ONLY" != true ]]; then
  [[ "$CONFIRMATION" == "$expected_confirmation" ]] || fail "Confirmation phrase does not match plan"
fi

[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Plan tag is not semver: $tag"
[[ "$target" =~ ^[0-9a-f]{40}$ ]] || fail "Plan target commit is not a full SHA: $target"
[[ "$plan_hash" =~ ^[0-9a-f]{64}$ ]] || fail "Plan hash is not a SHA-256 hex string: $plan_hash"

git fetch origin main --tags --force
git cat-file -e "${target}^{commit}" || fail "Target commit does not exist: $target"
git merge-base --is-ancestor "$previous_tag" "$target" || fail "$previous_tag is not an ancestor of target $target"
git merge-base --is-ancestor "$target" origin/main || fail "Target commit is not reachable from origin/main: $target"

if [[ "$authorization_type" == "maintainer-confirmation" ]]; then
  current_origin_main="$(git rev-parse origin/main)"
  [[ "$current_origin_main" == "$target" ]] || fail "origin/main moved from manual plan target $target to $current_origin_main; regenerate the plan"
fi

latest_remote_semver="$(git ls-remote --tags origin 'v*' | node -e '
let input=""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => {
  const tags=[...new Set(input.split("\n").map((line) => (line.trim().split(/\s+/)[1] || "").replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "")).filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag)))];
  tags.sort((a,b) => { const pa=a.slice(1).split(".").map(Number); const pb=b.slice(1).split(".").map(Number); for (let i=0;i<3;i+=1) if (pa[i] !== pb[i]) return pb[i]-pa[i]; return 0; });
  process.stdout.write(tags[0] || "");
});
')"
[[ "$latest_remote_semver" == "$previous_tag" ]] || fail "Latest remote semver changed from $previous_tag to ${latest_remote_semver:-none}; regenerate the plan"

untagged_count="$(git rev-list --count "${previous_tag}..${target}")"
if [[ "$plan_status" == "no-changes" ]]; then
  [[ "$untagged_count" == "0" ]] || fail "No-change plan target is ahead of $previous_tag"
  result_path="$(dirname "$PLAN_PATH")/cut-result.json"
  node -e 'const fs=require("fs"); const result={schemaVersion:2,status:"no-changes",planPath:process.argv[1],planHash:process.argv[2],tag:null,targetCommit:process.argv[3],latestTouched:false,lkgTouched:false,createdAt:new Date().toISOString()}; fs.writeFileSync(process.argv[4], JSON.stringify(result, null, 2) + "\n");' "$PLAN_PATH" "$plan_hash" "$target" "$result_path"
  printf 'release-cut-tag: no untagged commits; no tag created for %s\n' "$target"
  printf 'release-cut-tag: result written: %s\n' "$result_path"
  exit 0
fi

[[ "$untagged_count" != "0" ]] || fail "Ready plan has no commits after $previous_tag"
tag_pattern="${tag//./\\.}"
changelog_matches="$(git grep -n -E "^## ${tag_pattern}$" "$target" -- ':(glob)docs/changelog/*.mdx' || true)"
changelog_count="$(printf '%s\n' "$changelog_matches" | awk 'NF { count += 1 } END { print count + 0 }')"
[[ "$changelog_count" == "1" ]] || fail "Expected exactly one direct changelog entry for $tag at $target, found $changelog_count"

if git show-ref --verify --quiet "refs/tags/$tag"; then
  fail "Local tag already exists: $tag"
fi
if git ls-remote --exit-code --tags origin "$tag" >/dev/null; then
  fail "Remote tag already exists: $tag"
fi

if [[ "$PREFLIGHT_ONLY" == true ]]; then
  preflight_tag="nemoclaw-release-signing-preflight-$$"
  preflight_ref="refs/tags/$preflight_tag"
  git show-ref --verify --quiet "$preflight_ref" && fail "Local preflight tag already exists: $preflight_tag"

  cleanup_preflight_tag() {
    if git show-ref --verify --quiet "$preflight_ref"; then
      git update-ref -d "$preflight_ref"
    fi
  }
  trap cleanup_preflight_tag EXIT

  git tag -s "$preflight_tag" "$target" -m "NemoClaw release signing preflight"
  cleanup_preflight_tag
  trap - EXIT

  result_path="$(dirname "$PLAN_PATH")/cut-result.json"
  node -e 'const fs=require("fs"); const result={schemaVersion:2,status:"preflight",planPath:process.argv[1],planHash:process.argv[2],tag:process.argv[3],targetCommit:process.argv[4],latestTouched:false,lkgTouched:false,createdAt:new Date().toISOString()}; fs.writeFileSync(process.argv[5], JSON.stringify(result, null, 2) + "\n");' "$PLAN_PATH" "$plan_hash" "$tag" "$target" "$result_path"
  printf 'release-cut-tag: signing preflight passed for %s at %s\n' "$tag" "$target"
  exit 0
fi

git tag -s "$tag" "$target" -m "$tag"
push_remote="${PUSH_REMOTE_URL:-origin}"
git push "$push_remote" "refs/tags/$tag"

remote_peeled="$(git ls-remote --tags origin "refs/tags/$tag^{}" | awk '{print $1}')"
[[ "$remote_peeled" == "$target" ]] || fail "Remote $tag peeled to $remote_peeled, expected $target"

result_path="$(dirname "$PLAN_PATH")/cut-result.json"
node -e 'const fs=require("fs"); const result={schemaVersion:2,status:"tagged",planPath:process.argv[1],planHash:process.argv[2],tag:process.argv[3],targetCommit:process.argv[4],remotePeeledCommit:process.argv[5],latestTouched:false,lkgTouched:false,createdAt:new Date().toISOString()}; fs.writeFileSync(process.argv[6], JSON.stringify(result, null, 2) + "\n");' "$PLAN_PATH" "$plan_hash" "$tag" "$target" "$remote_peeled" "$result_path"

printf 'release-cut-tag: pushed %s at %s\n' "$tag" "$target"
printf 'release-cut-tag: result written: %s\n' "$result_path"
