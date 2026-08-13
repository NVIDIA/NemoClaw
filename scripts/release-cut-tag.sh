#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PLAN_PATH=""
CONFIRMATION="${RELEASE_CONFIRMATION:-}"
PREFLIGHT_ONLY=false

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
    --help | -h)
      cat <<'USAGE'
Usage:
  scripts/release-cut-tag.sh --plan PATH --preflight-only
  scripts/release-cut-tag.sh --plan PATH --confirm "CONFIRM RELEASE vX.Y.Z <sha>"

Preflight mode verifies exact-commit release qualification and the configured Git signer.
Cut mode creates and pushes only the signed annotated semver tag described by a release plan.
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
if [[ "$PREFLIGHT_ONLY" != true ]]; then
  [[ -n "$CONFIRMATION" ]] || fail "--confirm is required"
fi

json_field() {
  node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const path=process.argv[2].split("."); let value=data; for (const key of path) value=value?.[key]; if (value == null) process.exit(1); process.stdout.write(String(value));' "$PLAN_PATH" "$1"
}

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

status="$(git status --short)"
[[ -z "$status" ]] || fail "Release tagging requires a clean worktree"

node -e 'const fs=require("fs"); const crypto=require("crypto"); const data=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const semver=/^v\d+\.\d+\.\d+$/; const sha=/^[0-9a-f]{40}$/; const hash=/^[0-9a-f]{64}$/; if (data.schemaVersion !== 1) throw new Error("schemaVersion must be 1"); if (data.mode !== "tag-only") throw new Error("mode must be tag-only"); if (!semver.test(data.previousTag)) throw new Error("previousTag must be semver"); if (!semver.test(data.nextTag)) throw new Error("nextTag must be semver"); if (typeof data.originRemote !== "string" || data.originRemote.length === 0) throw new Error("originRemote must be a nonempty string"); if (!sha.test(data.originMainCommit)) throw new Error("originMainCommit must be a full SHA"); if (!hash.test(data.planHash)) throw new Error("planHash must be a sha256 hex string"); const {planHash, ...planWithoutHash}=data; const actual=crypto.createHash("sha256").update(JSON.stringify(planWithoutHash, null, 2)).digest("hex"); if (actual !== planHash) throw new Error("planHash mismatch: expected " + planHash + ", recomputed " + actual);' "$PLAN_PATH"

schema_version="$(json_field schemaVersion)"
mode="$(json_field mode)"
tag="$(json_field nextTag)"
target="$(json_field originMainCommit)"
origin_remote="$(json_field originRemote)"
expected_confirmation="$(json_field confirmationPhrase)"
plan_hash="$(json_field planHash)"

[[ "$schema_version" == "1" ]] || fail "Unsupported plan schemaVersion: $schema_version"
[[ "$mode" == "tag-only" ]] || fail "Unsupported plan mode: $mode"
if [[ "$PREFLIGHT_ONLY" != true ]]; then
  [[ "$CONFIRMATION" == "$expected_confirmation" ]] || fail "Confirmation phrase does not match plan"
fi
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Plan tag is not semver: $tag"
[[ "$target" =~ ^[0-9a-f]{40}$ ]] || fail "Plan target commit is not a full SHA: $target"
[[ "$plan_hash" =~ ^[0-9a-f]{64}$ ]] || fail "Plan hash is not a SHA-256 hex string: $plan_hash"

git fetch origin main --tags --force

current_origin_remote="$(git remote get-url origin)"
[[ "$current_origin_remote" == "$origin_remote" ]] || fail "origin remote changed after plan generation; regenerate the plan"

current_origin_main="$(git rev-parse origin/main)"
[[ "$current_origin_main" == "$target" ]] || fail "origin/main moved from plan target $target to $current_origin_main; regenerate the plan"

git cat-file -e "${target}^{commit}" || fail "Target commit does not exist: $target"
git merge-base --is-ancestor "$target" origin/main || fail "Target commit is not reachable from origin/main: $target"

verify_release_qualification() {
  local remote_kind
  remote_kind="$(node "$SCRIPT_DIR/release/remote.mts" "$origin_remote")" || fail "Could not validate origin remote"
  if [[ "$remote_kind" == "noncanonical" && "${NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL:-}" == "1" ]]; then
    printf 'release-cut-tag: skipped GitHub qualification for an explicitly allowed noncanonical test remote %s\n' "$origin_remote"
    return
  fi
  [[ "$remote_kind" == "canonical" ]] || fail "Unexpected origin remote: $origin_remote"

  command -v gh >/dev/null 2>&1 || fail "GitHub CLI is required to verify Release qualification"
  command -v jq >/dev/null 2>&1 || fail "jq is required to verify Release qualification"

  local run_lines
  if ! run_lines="$(gh api --paginate \
    "repos/NVIDIA/NemoClaw/actions/workflows/e2e.yaml/runs?branch=main&head_sha=${target}&event=workflow_dispatch&status=completed&per_page=100" \
    --jq ".workflow_runs[] | select(.head_sha == \"${target}\" and .head_branch == \"main\" and .event == \"workflow_dispatch\" and .status == \"completed\" and .conclusion == \"success\") | [.id, .html_url] | @tsv")"; then
    fail "GitHub could not list E2E runs for candidate commit $target"
  fi

  local run_id run_url job_lines match_count job_status job_conclusion job_url
  while IFS=$'\t' read -r run_id run_url; do
    [[ "$run_id" =~ ^[1-9][0-9]*$ && "$run_url" == https://github.com/NVIDIA/NemoClaw/actions/runs/* ]] || continue
    if ! job_lines="$(gh api --paginate \
      "repos/NVIDIA/NemoClaw/actions/runs/${run_id}/jobs?filter=latest&per_page=100" \
      --jq '.jobs[] | select(.name == "Release qualification") | [.status, .conclusion, .html_url] | @tsv')"; then
      fail "GitHub could not read Release qualification jobs for run $run_id"
    fi
    match_count="$(awk 'NF { count++ } END { print count + 0 }' <<<"$job_lines")"
    [[ "$match_count" == "1" ]] || continue
    IFS=$'\t' read -r job_status job_conclusion job_url <<<"$job_lines"
    if [[ "$job_status" == "completed" && "$job_conclusion" == "success" && "$job_url" == https://github.com/NVIDIA/NemoClaw/actions/runs/* ]]; then
      printf 'release-cut-tag: verified Release qualification for %s\n' "$target"
      printf 'release-cut-tag: workflow evidence: %s\n' "$run_url"
      printf 'release-cut-tag: qualification evidence: %s\n' "$job_url"
      return
    fi
  done <<<"$run_lines"

  fail "No completed successful Release qualification check exists for candidate commit $target"
}

verify_release_qualification

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

  # Exercise Git's configured OpenPGP, SSH, or X.509 signer without publishing a ref.
  git tag -s "$preflight_tag" "$target" -m "NemoClaw release signing preflight"
  cleanup_preflight_tag
  trap - EXIT

  printf 'release-cut-tag: signing preflight passed for %s at %s\n' "$tag" "$target"
  exit 0
fi

# Release tags are immutable once pushed. Sign the tag on the release
# operator's workstation so the private signing key never enters CI.
git tag -s "$tag" "$target" -m "$tag"
git push origin "refs/tags/$tag"

remote_peeled="$(git ls-remote --tags origin "refs/tags/$tag^{}" | awk '{print $1}')"
[[ "$remote_peeled" == "$target" ]] || fail "Remote $tag peeled to $remote_peeled, expected $target"

result_path="$(dirname "$PLAN_PATH")/cut-result.json"
node -e 'const fs=require("fs"); const result={schemaVersion:1,status:"ok",planPath:process.argv[1],planHash:process.argv[2],tag:process.argv[3],targetCommit:process.argv[4],remotePeeledCommit:process.argv[5],latestTouched:false,lkgTouched:false,createdAt:new Date().toISOString()}; fs.writeFileSync(process.argv[6], JSON.stringify(result, null, 2) + "\n");' "$PLAN_PATH" "$plan_hash" "$tag" "$target" "$remote_peeled" "$result_path"

printf 'release-cut-tag: pushed %s at %s\n' "$tag" "$target"
printf 'release-cut-tag: result written: %s\n' "$result_path"
