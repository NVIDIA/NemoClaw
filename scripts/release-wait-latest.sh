#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

PLAN_PATH=""
TIMEOUT_SECS=300
INTERVAL_SECS=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)
      PLAN_PATH="${2:-}"
      shift 2
      ;;
    --timeout-secs)
      TIMEOUT_SECS="${2:-}"
      shift 2
      ;;
    --interval-secs)
      INTERVAL_SECS="${2:-}"
      shift 2
      ;;
    --help | -h)
      cat <<'USAGE'
Usage: scripts/release-wait-latest.sh --plan PATH [--timeout-secs N] [--interval-secs N]

Waits until workflow-managed latest peels to the planned release commit.
USAGE
      exit 0
      ;;
    *)
      echo "release-wait-latest: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

fail() {
  echo "release-wait-latest: $*" >&2
  exit 1
}

[[ -n "$PLAN_PATH" ]] || fail "--plan is required"
[[ -f "$PLAN_PATH" ]] || fail "Plan file not found: $PLAN_PATH"

node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const semver=/^v\d+\.\d+\.\d+$/; const sha=/^[0-9a-f]{40}$/; const hash=/^[0-9a-f]{64}$/; if (data.schemaVersion !== 1) throw new Error("schemaVersion must be 1"); if (data.mode !== "tag-only") throw new Error("mode must be tag-only"); if (!semver.test(data.previousTag)) throw new Error("previousTag must be semver"); if (!semver.test(data.nextTag)) throw new Error("nextTag must be semver"); if (!sha.test(data.originMainCommit)) throw new Error("originMainCommit must be a full SHA"); if (!hash.test(data.planHash)) throw new Error("planHash must be a sha256 hex string");' "$PLAN_PATH"

json_field() {
  node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const path=process.argv[2].split("."); let value=data; for (const key of path) value=value?.[key]; if (value == null) process.exit(1); process.stdout.write(String(value));' "$PLAN_PATH" "$1"
}

tag="$(json_field nextTag)"
target="$(json_field originMainCommit)"
plan_hash="$(json_field planHash)"
lkg_before="$(node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(data.lkgBefore?.peeledSha || data.lkgBefore?.objectSha || "")' "$PLAN_PATH")"

remote_tag_commit_or_object() {
  local remote_tag="$1"
  local peeled=""
  local object=""
  peeled="$(git ls-remote --tags origin "refs/tags/${remote_tag}^{}" | awk '{print $1}')"
  if [[ -n "$peeled" ]]; then
    printf '%s' "$peeled"
    return
  fi
  object="$(git ls-remote --tags origin "refs/tags/${remote_tag}" | awk '{print $1}')"
  printf '%s' "$object"
}

deadline=$((SECONDS + TIMEOUT_SECS))
latest_peeled=""
semver_peeled=""

while ((SECONDS <= deadline)); do
  semver_peeled="$(git ls-remote --tags origin "refs/tags/$tag^{}" | awk '{print $1}')"
  latest_peeled="$(git ls-remote --tags origin 'refs/tags/latest^{}' | awk '{print $1}')"

  if [[ "$semver_peeled" == "$target" && "$latest_peeled" == "$target" ]]; then
    break
  fi

  sleep "$INTERVAL_SECS"
done

[[ "$semver_peeled" == "$target" ]] || fail "$tag peeled to $semver_peeled, expected $target"
[[ "$latest_peeled" == "$target" ]] || fail "latest peeled to $latest_peeled, expected $target"

lkg_after="$(remote_tag_commit_or_object lkg)"
if [[ -n "$lkg_before" && "$lkg_after" != "$lkg_before" ]]; then
  fail "lkg changed from $lkg_before to $lkg_after"
fi
if [[ -z "$lkg_before" && -n "$lkg_after" ]]; then
  fail "lkg was created after the release plan was generated: $lkg_after"
fi

result_path="$(dirname "$PLAN_PATH")/latest-result.json"
node -e 'const fs=require("fs"); const result={schemaVersion:1,status:"ok",planPath:process.argv[1],planHash:process.argv[2],tag:process.argv[3],targetCommit:process.argv[4],semverPeeledCommit:process.argv[5],latestPeeledCommit:process.argv[6],lkgPeeledCommitBefore:process.argv[7] || null,lkgPeeledCommitAfter:process.argv[8] || null,createdAt:new Date().toISOString()}; fs.writeFileSync(process.argv[9], JSON.stringify(result, null, 2) + "\n");' "$PLAN_PATH" "$plan_hash" "$tag" "$target" "$semver_peeled" "$latest_peeled" "$lkg_before" "$lkg_after" "$result_path"

printf 'release-wait-latest: latest and %s peel to %s\n' "$tag" "$target"
printf 'release-wait-latest: result written: %s\n' "$result_path"
