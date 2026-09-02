#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

trusted_inspector=.trusted-sdk-package-decision/scripts/checks/prepare-ci-npm-install.mts
trusted_workflow=.trusted-sdk-package-decision/.github/workflows/openshell-sdk-package-pr.yaml
if [ ! -f "$trusted_inspector" ]; then
  if [ -f "$trusted_workflow" ]; then
    echo "::error title=Incomplete SDK package support::The pull request base has a package workflow without its trusted inspector."
    exit 1
  fi
  if ! jq -se '
    length == 2 and
    all(.[];
      type == "object" and
      (.lockfileVersion | type == "number") and
      (.packages | type == "object")) and
    ([.[] | .. | objects | select(has("resolved")) | .resolved] |
      all(type == "string" and startswith("https://registry.npmjs.org/")))
  ' package-lock.json nemoclaw/package-lock.json >/dev/null; then
    echo "::error title=SDK package unavailable::The pull request base requires two valid public-registry npm lockfiles."
    exit 1
  fi
  echo "required=false" >>"$GITHUB_OUTPUT"
  exit 0
fi

decision="$(
  NEMOCLAW_CI_NPM_PACKAGE_MODE=inspect \
    NEMOCLAW_CI_TARGET_ROOT="$GITHUB_WORKSPACE" \
    node --experimental-strip-types "$trusted_inspector"
)"
required="$(
  jq -ser '
    if length == 1 and (.[0] | type) == "object" and (.[0].required | type) == "boolean" then
      .[0].required | tostring
    else
      error("decision must contain one object with a boolean required field")
    end
  ' <<<"$decision"
)"
if [ "$required" != "true" ]; then
  echo "required=false" >>"$GITHUB_OUTPUT"
  exit 0
fi
if [ "$HEAD_REPOSITORY" != "$GITHUB_REPOSITORY" ]; then
  echo "::error title=SDK package unavailable::The reviewed OpenShell SDK is available only to same-repository pull requests."
  exit 1
fi
if [ ! -f "$trusted_workflow" ]; then
  echo "::error title=Missing trusted SDK package workflow::The pull request base cannot package the approved OpenShell SDK."
  exit 1
fi

artifact_name="$(
  jq -er '.artifactName | select(type == "string" and test("^[a-z0-9][a-z0-9._-]*\\.tgz$"))' \
    <<<"$decision"
)"
printf 'artifact_name=%s\n' "$artifact_name" >>"$GITHUB_OUTPUT"
echo "required=true" >>"$GITHUB_OUTPUT"
newest_matching_run_url=""
newest_matching_run_status=""
for _attempt in $(seq 1 84); do
  if ! runs="$(
    gh api \
      "repos/$GITHUB_REPOSITORY/actions/workflows/openshell-sdk-package-pr.yaml/runs?event=pull_request_target&per_page=100" \
      2>/dev/null
  )"; then
    echo "::error title=SDK package workflow unavailable::Could not inspect reviewed SDK package workflow runs. After GitHub Actions access returns, rerun the failed openshell-sdk-package job in CI / Pull Request."
    exit 1
  fi
  matches="$(
    jq -cer \
      --arg base "$BASE_SHA" \
      --arg head "$HEAD_SHA" \
      --argjson pr "$PR_NUMBER" '
        [.workflow_runs[] |
          select(.event == "pull_request_target") |
          select(any(.pull_requests[]?;
            .number == $pr and .head.sha == $head and .base.sha == $base))] |
        sort_by(.created_at) | reverse
      ' <<<"$runs" 2>/dev/null || true
  )"
  if jq -e 'length > 0' <<<"$matches" >/dev/null 2>&1; then
    newest_matching_run_url="$(
      jq -er '.[0].html_url | select(type == "string" and startswith("https://github.com/"))' \
        <<<"$matches"
    )"
    newest_matching_run_status="$(
      jq -er '.[0].status | select(type == "string" and test("^[a-z_]+$"))' <<<"$matches"
    )"
    pending_run=false
    newest_completed_url=""
    while IFS= read -r match; do
      status="$(jq -r '.status' <<<"$match")"
      if [ "$status" != "completed" ]; then
        pending_run=true
        continue
      fi
      run_url="$(
        jq -er '.html_url | select(type == "string" and startswith("https://github.com/"))' \
          <<<"$match"
      )"
      if [ -z "$newest_completed_url" ]; then
        newest_completed_url="$run_url"
      fi
      conclusion="$(jq -r '.conclusion' <<<"$match")"
      if [ "$conclusion" != "success" ]; then
        continue
      fi
      run_id="$(
        jq -er '.id | select(type == "number" and . > 0 and . <= 9007199254740991)' <<<"$match"
      )"
      artifact_listing_url="repos/$GITHUB_REPOSITORY/actions/runs/$run_id/artifacts?per_page=100"
      if ! artifacts="$(gh api "$artifact_listing_url" 2>/dev/null)"; then
        echo "::error title=SDK package artifact unavailable::Could not inspect the reviewed SDK archive from $run_url. After GitHub Actions access returns, rerun the failed openshell-sdk-package job in CI / Pull Request."
        exit 1
      fi
      expected_artifact="openshell-sdk-$HEAD_SHA"
      if jq -e --arg name "$expected_artifact" '
        [.artifacts[]? | select(.name == $name and .expired == false)] | length == 1
      ' <<<"$artifacts" >/dev/null; then
        echo "run_id=$run_id" >>"$GITHUB_OUTPUT"
        exit 0
      fi
    done < <(jq -c '.[]' <<<"$matches")
    if [ "$pending_run" = "false" ]; then
      echo "::error title=SDK package artifact unavailable::No unexpired reviewed SDK archive is available. Last checked $newest_completed_url. Rerun Security / Package OpenShell SDK for PR for this latest PR commit. Then rerun the failed openshell-sdk-package job in CI / Pull Request."
      exit 1
    fi
  fi
  sleep 5
done
latest_run_detail="No matching run was found."
if [ -n "$newest_matching_run_url" ]; then
  latest_run_detail="Last matching run: $newest_matching_run_url ($newest_matching_run_status)."
fi
echo "::error title=SDK package workflow timed out::No successful reviewed SDK package run for this latest PR commit was available within seven minutes. $latest_run_detail Rerun Security / Package OpenShell SDK for PR for this latest PR commit. Then rerun the failed openshell-sdk-package job in CI / Pull Request."
exit 1
