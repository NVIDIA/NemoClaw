#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PLAN_PATH=""
MESSAGE_FILE=""
CONFIRMATION="${RELEASE_CONFIRMATION:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan)
      PLAN_PATH="${2:-}"
      shift 2
      ;;
    --message-file)
      MESSAGE_FILE="${2:-}"
      shift 2
      ;;
    --confirm)
      CONFIRMATION="${2:-}"
      shift 2
      ;;
    --help | -h)
      cat <<'USAGE'
Usage:
  scripts/release-cut-tag.sh --plan PATH --message-file release-brief.md \
    --confirm "CONFIRM RELEASE vX.Y.Z <sha>"

Creates and pushes only the signed annotated semver tag described by a release plan.
The signed tag message is the exact content of the message file.
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
[[ -n "$MESSAGE_FILE" ]] || fail "--message-file is required"
[[ -f "$MESSAGE_FILE" ]] || fail "Message file not found: $MESSAGE_FILE"
[[ -s "$MESSAGE_FILE" ]] || fail "Message file is empty: $MESSAGE_FILE"
[[ -n "$CONFIRMATION" ]] || fail "--confirm is required"

plan_directory="$(cd -- "$(dirname -- "$PLAN_PATH")" && pwd -P)"
PLAN_PATH="$plan_directory/$(basename -- "$PLAN_PATH")"
message_directory="$(cd -- "$(dirname -- "$MESSAGE_FILE")" && pwd -P)"
MESSAGE_FILE="$message_directory/$(basename -- "$MESSAGE_FILE")"
brief_snapshot="$(mktemp)"
chmod 600 "$brief_snapshot"
trap 'rm -f -- "$brief_snapshot"' EXIT
cp -- "$MESSAGE_FILE" "$brief_snapshot" || fail "Could not snapshot the release brief"
[[ -s "$brief_snapshot" ]] || fail "Release brief snapshot is empty"

repo_root="$(cd -- "$(git rev-parse --show-toplevel)" && pwd -P)"
cd "$repo_root"

IFS=$'\t' read -r previous_tag planned_previous_object planned_previous_commit tag target candidate_selection historical_exception < <(
  node -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const semver = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
    const sha = /^[0-9a-f]{40}$/;
    const expectedKeys = [
      "candidateCommit",
      "candidateSelection",
      "historicalCandidateException",
      "nextTag",
      "originMainCommit",
      "originMainHeadline",
      "previousTag",
      "previousTagCommit",
      "previousTagObject",
    ];
    const actualKeys = Object.keys(data).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
      throw new Error("release plan must contain exactly the nine supported fields");
    }
    if (!semver.test(data.previousTag)) throw new Error("previousTag must be semver");
    if (!sha.test(data.previousTagCommit)) throw new Error("previousTagCommit must be a full SHA");
    if (!sha.test(data.previousTagObject)) throw new Error("previousTagObject must be a full SHA");
    if (!semver.test(data.nextTag)) throw new Error("nextTag must be semver");
    if (!sha.test(data.originMainCommit)) throw new Error("originMainCommit must be a full SHA");
    if (!sha.test(data.candidateCommit)) throw new Error("candidateCommit must be a full SHA");
    if (typeof data.originMainHeadline !== "string" || data.originMainHeadline.length === 0) {
      throw new Error("originMainHeadline must be a nonempty string");
    }
    if (data.candidateSelection === "current-main") {
      if (data.candidateCommit !== data.originMainCommit || data.historicalCandidateException !== "None") {
        throw new Error("current-main plan must select originMainCommit without an exception");
      }
    } else if (data.candidateSelection === "historical") {
      if (data.candidateCommit === data.originMainCommit) {
        throw new Error("historical plan must select a commit before originMainCommit");
      }
      if (typeof data.historicalCandidateException !== "string" ||
          !/\S/u.test(data.historicalCandidateException) ||
          /[\u0000-\u001f\u007f]/u.test(data.historicalCandidateException)) {
        throw new Error("historical plan must contain a single-line exception reason");
      }
    } else {
      throw new Error("candidateSelection must be current-main or historical");
    }
    process.stdout.write([
      data.previousTag,
      data.previousTagObject,
      data.previousTagCommit,
      data.nextTag,
      data.candidateCommit,
      data.candidateSelection,
      data.historicalCandidateException,
    ].join("\t") + "\n");
  ' "$PLAN_PATH"
) || fail "Could not read release plan"

expected_confirmation="CONFIRM RELEASE $tag $target"
[[ "$CONFIRMATION" == "$expected_confirmation" ]] \
  || fail "Confirmation phrase does not match release tag and commit"

expected_heading="# NemoClaw $tag release brief"
printf -v expected_candidate -- "- Candidate: \`%s\`" "$target"
IFS= read -r first_brief_line <"$brief_snapshot" \
  || fail "Could not read the release brief heading"
[[ "$first_brief_line" == "$expected_heading" ]] \
  || fail "Release brief heading does not match planned tag $tag"
candidate_count="$(awk -v expected="$expected_candidate" '$0 == expected { count++ } END { print count + 0 }' "$brief_snapshot")" \
  || fail "Could not validate the release brief candidate"
[[ "$candidate_count" == "1" ]] \
  || fail "Release brief candidate does not match planned commit $target"

require_brief_line_once() {
  local expected="$1"
  local label="$2"
  local count
  count="$(grep -Fxc -- "$expected" "$brief_snapshot" || true)" \
    || fail "Could not validate release brief $label"
  [[ "$count" == "1" ]] || fail "Release brief must contain exactly one $label"
}

expected_docs_decision="- Maintainer decision: Proceed with the candidate as shown."
printf -v expected_base_candidate -- "- Base-image candidate: \`%s\`" "$target"
require_brief_line_once "$expected_docs_decision" "documentation proceed decision"
require_brief_line_once "$expected_base_candidate" "plan-bound base-image candidate"
if [[ "$candidate_selection" == "historical" ]]; then
  # JavaScript owns $1 in the replacement string.
  # shellcheck disable=SC2016
  escaped_historical_exception="$(
    node -e 'process.stdout.write(process.argv[1].replace(/([\\`*_[\]<>#])/g, "\\$1"))' \
      "$historical_exception"
  )" || fail "Could not escape the historical candidate exception"
  printf -v expected_historical_exception -- \
    "- Historical candidate exception: %s" "$escaped_historical_exception"
  require_brief_line_once "$expected_historical_exception" "plan-bound historical candidate exception"
else
  if grep -q '^\- Historical candidate exception:' "$brief_snapshot"; then
    fail "Current-main release brief must not contain a historical candidate exception"
  fi
fi
if grep -Eq -- "TODO_RELEASE_BRIEF|Complete before confirmation" "$brief_snapshot"; then
  fail "Release brief still contains unresolved prompts"
fi
exceptions_count="$(awk '/^Exceptions: / { count++ } END { print count + 0 }' "$brief_snapshot")" \
  || fail "Could not validate the release brief exception line"
last_nonblank_line="$(awk 'NF { line = $0 } END { if (line == "") exit 1; print line }' "$brief_snapshot")" \
  || fail "Could not validate the final release brief line"
[[ "$exceptions_count" == "1" && "$last_nonblank_line" == Exceptions:\ * ]] \
  || fail "Release brief must end with exactly one resolved Exceptions line"
exception_reason="${last_nonblank_line#Exceptions: }"
[[ "$exception_reason" =~ [^[:space:]] ]] \
  || fail "Release brief must end with exactly one resolved Exceptions line"

if ! origin_fetch_urls="$(git remote get-url --all origin)"; then
  fail "Could not read origin fetch URLs"
fi
if ! origin_push_urls="$(git remote get-url --push --all origin)"; then
  fail "Could not read origin push URLs"
fi
[[ -n "$origin_fetch_urls" ]] || fail "origin has no fetch URL"
[[ -n "$origin_push_urls" ]] || fail "origin has no push URL"

all_urls_are_canonical() {
  local urls="$1"
  local remote_url remote_kind
  while IFS= read -r remote_url; do
    [[ -n "$remote_url" ]] || return 1
    remote_kind="$(node "$SCRIPT_DIR/release/remote.mts" "$remote_url")" || return 1
    [[ "$remote_kind" == "canonical" ]] || return 1
  done <<<"$urls"
}

canonical_release_origin=false
if all_urls_are_canonical "$origin_fetch_urls" && all_urls_are_canonical "$origin_push_urls"; then
  canonical_release_origin=true
elif
  [[ "${NEMOCLAW_RELEASE_ALLOW_NON_CANONICAL:-}" == "1" ]] \
    && [[ "$origin_fetch_urls" != *$'\n'* ]] \
    && [[ "$origin_fetch_urls" == "$origin_push_urls" ]] \
    && [[ "$(node "$SCRIPT_DIR/release/remote.mts" "$origin_fetch_urls")" == "local-fixture" ]]
then
  :
else
  if
    [[ "$origin_fetch_urls" != *$'\n'* ]] \
      && [[ "$origin_fetch_urls" == "$origin_push_urls" ]]
  then
    fail "Unexpected origin remote: $origin_fetch_urls"
  fi
  fail "Unexpected origin fetch or push URL"
fi

git fetch --no-tags origin "+refs/heads/main:refs/remotes/origin/main"

if [[ "$canonical_release_origin" == true ]]; then
  [[ "$SCRIPT_DIR" == "$repo_root/scripts" ]] \
    || fail "Release cutter must run from the canonical repository scripts directory"
  git diff --quiet origin/main -- scripts/release-cut-tag.sh scripts/release/remote.mts \
    || fail "Release cutter files differ from refreshed origin/main"
fi

if ! remote_semver_refs="$(git ls-remote --tags origin "refs/tags/v*")"; then
  fail "Could not read remote semver tags"
fi
if ! highest_remote_semver="$(
  node -e '
      const requested = process.argv[1];
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const tags = new Map();
        for (const line of input.trim().split("\n")) {
          if (!line) continue;
          const [object, ref] = line.trim().split(/\s+/);
          const match = /^refs\/tags\/(v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))(\^\{\})?$/.exec(ref ?? "");
          if (!match) continue;
          const entry = tags.get(match[1]) ?? { parts: match.slice(2, 5).map(BigInt) };
          entry[match[5] ? "commit" : "object"] = object;
          tags.set(match[1], entry);
        }
        if (tags.has(requested)) {
          process.stderr.write("Remote tag already exists: " + requested + "\n");
          process.exit(2);
        }
        const sorted = [...tags].sort((left, right) => {
          for (let index = 0; index < 3; index += 1) {
            if (left[1].parts[index] !== right[1].parts[index]) {
              return left[1].parts[index] > right[1].parts[index] ? -1 : 1;
            }
          }
          return 0;
        });
        if (sorted.length === 0) process.exit(3);
        const [name, entry] = sorted[0];
        if (!entry.object || !entry.commit) {
          process.stderr.write("Latest remote release tag must be annotated: " + name + "\n");
          process.exit(4);
        }
        const requestedMatch = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(requested);
        const requestedParts = requestedMatch?.slice(1, 4).map(BigInt);
        let comparison = 0;
        for (let index = 0; requestedParts && index < 3; index += 1) {
          if (requestedParts[index] > entry.parts[index]) {
            comparison = 1;
            break;
          }
          if (requestedParts[index] < entry.parts[index]) {
            comparison = -1;
            break;
          }
        }
        if (comparison <= 0) {
          process.stderr.write("Release tag " + requested + " must be newer than " + name + "\n");
          process.exit(5);
        }
        process.stdout.write(name + "\t" + entry.object + "\t" + entry.commit + "\n");
      });
    ' "$tag" <<<"$remote_semver_refs"
)"; then
  fail "Could not read the highest remote semver tag"
fi
IFS=$'\t' read -r current_previous_tag previous_object previous_commit <<<"$highest_remote_semver" \
  || fail "Could not parse the highest remote semver tag"

[[ "$current_previous_tag" == "$previous_tag" ]] \
  || fail "A semver tag appeared after planning: highest tag changed from $previous_tag to $current_previous_tag"
[[ "$previous_object" == "$planned_previous_object" ]] \
  || fail "Remote $previous_tag object changed from $planned_previous_object to $previous_object; stop for protected-tag remediation"
[[ "$previous_commit" == "$planned_previous_commit" ]] \
  || fail "Remote $previous_tag changed from $planned_previous_commit to $previous_commit; stop for protected-tag remediation"

git cat-file -e "${target}^{commit}" || fail "Candidate commit does not exist: $target"
refreshed_origin_main="$(git rev-parse origin/main)" \
  || fail "Could not resolve refreshed origin/main"
if [[ "$candidate_selection" == "historical" ]]; then
  [[ "$target" != "$refreshed_origin_main" ]] \
    || fail "Historical candidate now identifies origin/main; generate a current-main plan without an exception"
fi
git merge-base --is-ancestor "$target" origin/main \
  || fail "Candidate commit is not reachable from origin/main: $target"
git cat-file -e "${previous_commit}^{commit}" \
  || fail "Previous release commit does not exist locally: $previous_commit"
git merge-base --is-ancestor "$previous_commit" "$target" \
  || fail "Candidate commit $target does not follow previous release $previous_tag"

if git show-ref --verify --quiet "refs/tags/$tag"; then
  fail "Local tag $tag already exists. Inspect the exact remote ref and do not rerun the cutter"
fi

# Git signs the tag on the maintainer workstation. The private signing key does not enter CI.
git tag -s -F "$brief_snapshot" --cleanup=verbatim "$tag" "$target"
local_tag_object="$(git rev-parse "refs/tags/$tag")"

# Candidate validation belongs to the commit. The tag-only push skips general pre-push checks.
push_failed=0
git push --no-verify origin "refs/tags/$tag:refs/tags/$tag" || push_failed=1

if ! remote_refs="$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}")"; then
  fail "Could not read back $tag after the push attempt; kept the local tag. Inspect the exact remote ref and do not rerun the cutter"
fi
remote_object=""
remote_peeled=""
while read -r sha ref; do
  case "$ref" in
    "refs/tags/$tag") remote_object="$sha" ;;
    "refs/tags/$tag^{}") remote_peeled="$sha" ;;
  esac
done <<<"$remote_refs"

if ((push_failed)); then
  if [[ -z "$remote_object" && -z "$remote_peeled" ]]; then
    git update-ref -d "refs/tags/$tag" "$local_tag_object" \
      || fail "The push failed and the remote tag is absent, but the local tag could not be removed. Keep it and do not rerun the cutter"
    fail "The push failed and the remote tag is absent; removed the local tag"
  fi
  if [[ "$remote_object" != "$local_tag_object" || "$remote_peeled" != "$target" ]]; then
    fail "The push failed and remote $tag has different data; kept the local tag. Stop and do not rerun the cutter"
  fi
  printf 'release-cut-tag: push reported failure, but remote %s matches the signed local tag\n' "$tag"
fi

[[ "$remote_object" == "$local_tag_object" ]] \
  || fail "Remote $tag object $remote_object does not match local signed object $local_tag_object; kept the local tag. Do not rerun the cutter"
[[ "$remote_peeled" == "$target" ]] \
  || fail "Remote $tag peeled to $remote_peeled, expected $target; kept the local tag. Do not rerun the cutter"

printf 'release-cut-tag: pushed signed %s object %s at %s\n' "$tag" "$remote_object" "$target"
