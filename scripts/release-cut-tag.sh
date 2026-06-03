#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

PLAN_PATH=""
CONFIRMATION="${RELEASE_CONFIRMATION:-}"

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
    --help | -h)
      cat <<'USAGE'
Usage: scripts/release-cut-tag.sh --plan PATH --confirm "CONFIRM RELEASE vX.Y.Z <sha>"

Creates and pushes only the annotated semver tag described by a release plan.
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
[[ -n "$CONFIRMATION" ]] || fail "--confirm is required"

json_field() {
  node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const path=process.argv[2].split("."); let value=data; for (const key of path) value=value?.[key]; if (value == null) process.exit(1); process.stdout.write(String(value));' "$PLAN_PATH" "$1"
}

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

status="$(git status --short)"
[[ -z "$status" ]] || fail "Release tagging requires a clean worktree"

schema_version="$(json_field schemaVersion)"
mode="$(json_field mode)"
tag="$(json_field nextTag)"
target="$(json_field originMainCommit)"
expected_confirmation="$(json_field confirmationPhrase)"
plan_hash="$(json_field planHash)"

[[ "$schema_version" == "1" ]] || fail "Unsupported plan schemaVersion: $schema_version"
[[ "$mode" == "tag-only" ]] || fail "Unsupported plan mode: $mode"
[[ "$CONFIRMATION" == "$expected_confirmation" ]] || fail "Confirmation phrase does not match plan"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Plan tag is not semver: $tag"

git fetch origin main --tags --force

current_origin_main="$(git rev-parse origin/main)"
[[ "$current_origin_main" == "$target" ]] || fail "origin/main moved from plan target $target to $current_origin_main; regenerate the plan"

git cat-file -e "${target}^{commit}" || fail "Target commit does not exist: $target"
git merge-base --is-ancestor "$target" origin/main || fail "Target commit is not reachable from origin/main: $target"

if git show-ref --verify --quiet "refs/tags/$tag"; then
  fail "Local tag already exists: $tag"
fi
if git ls-remote --exit-code --tags origin "$tag" >/dev/null; then
  fail "Remote tag already exists: $tag"
fi

git tag -a "$tag" "$target" -m "$tag"
git push origin "refs/tags/$tag"

remote_peeled="$(git ls-remote --tags origin "refs/tags/$tag^{}" | awk '{print $1}')"
[[ "$remote_peeled" == "$target" ]] || fail "Remote $tag peeled to $remote_peeled, expected $target"

result_path="$(dirname "$PLAN_PATH")/cut-result.json"
node -e 'const fs=require("fs"); const result={schemaVersion:1,status:"ok",planPath:process.argv[1],planHash:process.argv[2],tag:process.argv[3],targetCommit:process.argv[4],remotePeeledCommit:process.argv[5],latestTouched:false,lkgTouched:false,createdAt:new Date().toISOString()}; fs.writeFileSync(process.argv[6], JSON.stringify(result, null, 2) + "\n");' "$PLAN_PATH" "$plan_hash" "$tag" "$target" "$remote_peeled" "$result_path"

printf 'release-cut-tag: pushed %s at %s\n' "$tag" "$target"
printf 'release-cut-tag: result written: %s\n' "$result_path"
