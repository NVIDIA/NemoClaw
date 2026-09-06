#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
: "${ADVISOR_DIR:?}" "${GITHUB_WORKFLOW_SHA:?}" "${GITHUB_RUN_ID:?}" "${EXPECTED_RUNTIME_SHA:?}" "${RUNNER_TEMP:?}" "${GITHUB_PATH:?}"
artifact="${1:?artifact directory required}"
payload="$artifact/runtime.tar"
test -f "$payload" && test ! -L "$payload"
actual_sha="$(sha256sum "$payload" | awk '{print $1}')"
test "$actual_sha" = "$EXPECTED_RUNTIME_SHA"
while IFS= read -r member; do case "$member" in . | ./ | ./node_modules | ./node_modules/ | ./node_modules/* | ./bin | ./bin/ | ./bin/rg | ./bin/fdfind | ./bin/fd | ./workflow-sha | ./run-id | ./run-attempt) ;; *)
  echo "::error::unexpected advisor runtime member: $member"
  exit 1
  ;;
esac done < <(tar -tf "$payload")
if tar -tvf "$payload" | awk '$1 !~ /^[d-]/ { bad=1 } END { exit bad ? 0 : 1 }'; then
  echo "::error::advisor runtime contains a link or special entry"
  exit 1
fi
stage="$(mktemp -d "$RUNNER_TEMP/advisor-runtime.XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
tar --no-same-owner --no-same-permissions -xf "$payload" -C "$stage"
test "$(<"$stage/workflow-sha")" = "$GITHUB_WORKFLOW_SHA"
test "$(<"$stage/run-id")" = "$GITHUB_RUN_ID"
case "$(<"$stage/run-attempt")" in '' | *[!0-9]*) exit 1 ;; esac
test -d "$stage/node_modules" && test ! -L "$stage/node_modules"
for name in rg fdfind fd; do test -f "$stage/bin/$name" && test ! -L "$stage/bin/$name"; done
test ! -e "$ADVISOR_DIR/node_modules"
mv -- "$stage/node_modules" "$ADVISOR_DIR/node_modules"
runtime_bin="$RUNNER_TEMP/pr-review-advisor-runtime-bin"
rm -rf -- "$runtime_bin"
mv -- "$stage/bin" "$runtime_bin"
printf '%s\n' "$runtime_bin" >>"$GITHUB_PATH"
