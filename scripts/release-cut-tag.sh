#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

PLAN_PATH=""
QUALIFICATION_RECEIPT_PATH=""
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
    --qualification-receipt)
      QUALIFICATION_RECEIPT_PATH="${2:-}"
      shift 2
      ;;
    --preflight-only)
      PREFLIGHT_ONLY=true
      shift
      ;;
    --help | -h)
      cat <<'USAGE'
Usage:
  scripts/release-cut-tag.sh --plan PATH --qualification-receipt PATH --preflight-only
  scripts/release-cut-tag.sh --plan PATH --qualification-receipt PATH --confirm "CONFIRM RELEASE vX.Y.Z <sha>"

Preflight mode verifies that Git can create a signed annotated tag with the configured signer.
When the #8590 contract is present, both modes require its exact final qualification receipt.
Cut mode creates and publishes only the signed annotated semver tag described by a release plan.
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

qualification_contract="$repo_root/ci/openshell-0.0.101-qualification-v1.json"
qualification_validator="$repo_root/scripts/checks/openshell-qualification-contract.mts"
qualification_core="$repo_root/scripts/checks/openshell-qualification-core.mts"
qualification_github="$repo_root/scripts/checks/openshell-qualification-github.mts"
qualification_io="$repo_root/scripts/checks/openshell-qualification-io.mts"
qualification_matrix="$repo_root/scripts/checks/openshell-qualification-matrix.mts"
qualification_schema="$repo_root/scripts/checks/openshell-qualification-schema.mts"
qualification_archive_reader="$repo_root/scripts/scorecard/read-artifact-zip.mts"
qualification_contract_relative="ci/openshell-0.0.101-qualification-v1.json"
qualification_validator_relative="scripts/checks/openshell-qualification-contract.mts"
qualification_core_relative="scripts/checks/openshell-qualification-core.mts"
qualification_github_relative="scripts/checks/openshell-qualification-github.mts"
qualification_io_relative="scripts/checks/openshell-qualification-io.mts"
qualification_matrix_relative="scripts/checks/openshell-qualification-matrix.mts"
qualification_schema_relative="scripts/checks/openshell-qualification-schema.mts"
qualification_archive_reader_relative="scripts/scorecard/read-artifact-zip.mts"
release_consumer_relative="scripts/release-cut-tag.sh"
release_repository="NVIDIA/NemoClaw"
qualification_retirement_tag_message=""
qualification_retirement_metadata_json=""
qualification_retirement_evidence_json=""

status="$(git status --short)"
[[ -z "$status" ]] || fail "Release tagging requires a clean worktree"

node -e 'const fs=require("fs"); const crypto=require("crypto"); const data=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const semver=/^v\d+\.\d+\.\d+$/; const sha=/^[0-9a-f]{40}$/; const hash=/^[0-9a-f]{64}$/; if (data.schemaVersion !== 1) throw new Error("schemaVersion must be 1"); if (data.mode !== "tag-only") throw new Error("mode must be tag-only"); if (!semver.test(data.previousTag)) throw new Error("previousTag must be semver"); if (!semver.test(data.nextTag)) throw new Error("nextTag must be semver"); if (!sha.test(data.originMainCommit)) throw new Error("originMainCommit must be a full SHA"); if (!hash.test(data.planHash)) throw new Error("planHash must be a sha256 hex string"); const {planHash, ...planWithoutHash}=data; const actual=crypto.createHash("sha256").update(JSON.stringify(planWithoutHash, null, 2)).digest("hex"); if (actual !== planHash) throw new Error("planHash mismatch: expected " + planHash + ", recomputed " + actual);' "$PLAN_PATH"

schema_version="$(json_field schemaVersion)"
mode="$(json_field mode)"
tag="$(json_field nextTag)"
target="$(json_field originMainCommit)"
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
local_head="$(git rev-parse HEAD)"
[[ "$local_head" == "$target" ]] || fail "Local HEAD $local_head does not match plan target $target"

git fetch origin main --tags --force

require_current_origin_main() {
  local current_origin_main
  current_origin_main="$(git rev-parse origin/main)"
  [[ "$current_origin_main" == "$target" ]] || fail "origin/main moved from plan target $target to $current_origin_main; regenerate the plan"
  [[ "$(git rev-parse HEAD)" == "$target" ]] || fail "Local HEAD moved from plan target $target"
  [[ -z "$(git status --short)" ]] || fail "Release worktree changed after plan validation"
}

require_current_origin_main

git cat-file -e "${target}^{commit}" || fail "Target commit does not exist: $target"
git merge-base --is-ancestor "$target" origin/main || fail "Target commit is not reachable from origin/main: $target"
target_base="$(git rev-parse "${target}^1" 2>/dev/null)" || fail "Plan target has no first parent"
[[ "$target_base" =~ ^[0-9a-f]{40}$ ]] || fail "Target first parent is not a full SHA: $target_base"

contract_in_target=false
contract_in_base=false
git cat-file -e "${target}:${qualification_contract_relative}" 2>/dev/null && contract_in_target=true
git cat-file -e "${target_base}:${qualification_contract_relative}" 2>/dev/null && contract_in_base=true
[[ "$contract_in_target" == "$contract_in_base" ]] || fail "#8590 qualification contract presence differs between the plan target and its first parent"

if [[ "$contract_in_target" == true ]]; then
  require_canonical_release_origin() {
    local origin_fetch_url
    local origin_push_url
    origin_fetch_url="$(git remote get-url origin 2>/dev/null)" || fail "#8590 release publication requires a readable origin URL"
    origin_push_url="$(git remote get-url --push origin 2>/dev/null)" || fail "#8590 release publication requires a readable origin push URL"
    case "$origin_fetch_url" in
      "https://github.com/$release_repository" | "https://github.com/$release_repository.git" | "git@github.com:$release_repository" | "git@github.com:$release_repository.git" | "ssh://git@github.com/$release_repository" | "ssh://git@github.com/$release_repository.git") ;;
      *) fail "#8590 release origin does not resolve to the canonical $release_repository repository: $origin_fetch_url" ;;
    esac
    case "$origin_push_url" in
      "https://github.com/$release_repository" | "https://github.com/$release_repository.git" | "git@github.com:$release_repository" | "git@github.com:$release_repository.git" | "ssh://git@github.com/$release_repository" | "ssh://git@github.com/$release_repository.git") ;;
      *) fail "#8590 release origin push URL does not resolve to the canonical $release_repository repository: $origin_push_url" ;;
    esac
  }

  require_canonical_release_origin
  # This is the complete transitive local runtime read by validate-live. Keep it
  # explicit and independent from module-owned metadata.
  qualification_runtime_authority_paths=(
    "ci/openshell-0.0.101-qualification-v1.json"
    "scripts/checks/openshell-qualification-contract.mts"
    "scripts/checks/openshell-qualification-core.mts"
    "scripts/checks/openshell-qualification-github.mts"
    "scripts/checks/openshell-qualification-io.mts"
    "scripts/checks/openshell-qualification-matrix.mts"
    "scripts/checks/openshell-qualification-schema.mts"
    "scripts/scorecard/read-artifact-zip.mts"
  )
  # Keep this independent inventory exactly aligned with
  # QUALIFICATION_FROZEN_AUTHORITY_PATHS in openshell-qualification-core.mts.
  qualification_frozen_authority_paths=(
    ".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md"
    ".github/workflows/openshell-0.0.101-pr-gate.yaml"
    ".github/workflows/openshell-0.0.101-qualification.yaml"
    "scripts/checks/openshell-qualification-contract.mts"
    "scripts/checks/openshell-qualification-core.mts"
    "scripts/checks/openshell-qualification-github.mts"
    "scripts/checks/openshell-qualification-io.mts"
    "scripts/checks/openshell-qualification-matrix.mts"
    "scripts/checks/openshell-qualification-paths.mts"
    "scripts/checks/openshell-qualification-schema.mts"
    "scripts/checks/verify-openshell-qualification-producer-workflow.mts"
    "scripts/checks/verify-openshell-qualification-pr-gate.mts"
    "scripts/release-cut-tag.sh"
    "scripts/scorecard/read-artifact-zip.mts"
  )
  qualification_bootstrap_authority_paths=(
    "$qualification_contract_relative"
    "${qualification_frozen_authority_paths[@]}"
  )
  qualification_authority_paths=()
  require_commit_authority_regular_blob() {
    local authority_commit="$1"
    local authority_path="$2"
    local authority_source="$3"
    local entry
    local listed_path
    local metadata
    local mode
    local object
    local type
    entry="$(git ls-tree "$authority_commit" -- "$authority_path")" || fail "#8590 could not inspect $authority_source qualification authority: $authority_path"
    [[ "$entry" == *$'\t'* && "$entry" != *$'\n'* ]] || fail "#8590 $authority_source qualification authority entry is missing or ambiguous: $authority_path"
    metadata="${entry%%$'\t'*}"
    listed_path="${entry#*$'\t'}"
    read -r mode type object <<<"$metadata"
    [[ "$listed_path" == "$authority_path" && "$type" == "blob" && ("$mode" == "100644" || "$mode" == "100755") && "$object" =~ ^[0-9a-f]{40}$ ]] || fail "#8590 $authority_source qualification authority is not a regular blob: $authority_path"
  }
  for authority_path in "${qualification_bootstrap_authority_paths[@]}"; do
    git cat-file -e "${target}:${authority_path}" 2>/dev/null || fail "#8590 qualification authority is missing from the plan target: $authority_path"
    git cat-file -e "${target_base}:${authority_path}" 2>/dev/null || fail "#8590 qualification authority is missing from the target first parent: $authority_path"
    require_commit_authority_regular_blob "$target" "$authority_path" "plan target"
    require_commit_authority_regular_blob "$target_base" "$authority_path" "target first-parent"
  done
  git diff --quiet "$target_base" "$target" -- "${qualification_bootstrap_authority_paths[@]}" || fail "#8590 qualification bootstrap authority differs between the plan target and its first parent"
  release_consumer_source="${BASH_SOURCE[0]}"
  if [[ "$release_consumer_source" != /* ]]; then
    release_consumer_source="$PWD/$release_consumer_source"
  fi
  release_consumer_path="$(cd -- "$(dirname -- "$release_consumer_source")" && pwd -P)/$(basename -- "$release_consumer_source")"

  require_local_authority_blob() {
    local authority_relative="$1"
    local authority_local_path="$2"
    local authority_label="$3"
    local expected_authority_blob
    local actual_authority_blob
    [[ -f "$authority_local_path" && ! -L "$authority_local_path" ]] || fail "#8590 $authority_label is not a regular target-owned file"
    expected_authority_blob="$(git rev-parse "${target_base}:${authority_relative}")" || fail "#8590 could not resolve the target first-parent blob for $authority_relative"
    actual_authority_blob="$(git hash-object "$authority_local_path")" || fail "#8590 could not hash local authority $authority_relative"
    [[ "$actual_authority_blob" == "$expected_authority_blob" ]] || fail "#8590 $authority_label does not match the target first-parent authority"
  }

  require_local_qualification_authority() {
    require_local_authority_blob "$qualification_contract_relative" "$qualification_contract" "qualification contract"
    require_local_authority_blob "$qualification_validator_relative" "$qualification_validator" "qualification validator"
    require_local_authority_blob "$qualification_core_relative" "$qualification_core" "qualification core"
    require_local_authority_blob "$qualification_github_relative" "$qualification_github" "qualification GitHub authenticator"
    require_local_authority_blob "$qualification_io_relative" "$qualification_io" "qualification I/O validator"
    require_local_authority_blob "$qualification_matrix_relative" "$qualification_matrix" "qualification matrix validator"
    require_local_authority_blob "$qualification_schema_relative" "$qualification_schema" "qualification schema"
    require_local_authority_blob "$qualification_archive_reader_relative" "$qualification_archive_reader" "qualification archive reader"
    require_local_authority_blob "$release_consumer_relative" "$release_consumer_path" "release consumer"
  }

  qualification_runtime_root=""
  cleanup_qualification_runtime() {
    local runtime_root="${qualification_runtime_root:-}"
    local runtime_name
    [[ -n "$runtime_root" ]] || return 0
    runtime_name="$(basename -- "$runtime_root")"
    if [[ -d "$runtime_root" && ! -L "$runtime_root" && "$runtime_name" == nemoclaw-release-qualification.* ]]; then
      rm -rf -- "$runtime_root" || true
    fi
    qualification_runtime_root=""
  }

  materialize_qualification_runtime() {
    local authority_blob
    local authority_entry
    local authority_metadata
    local authority_mode
    local authority_path
    local authority_type
    local destination
    local destination_parent
    local extracted_blob
    local listed_path
    cleanup_qualification_runtime
    qualification_runtime_root="$(mktemp -d "${TMPDIR:-/tmp}/nemoclaw-release-qualification.XXXXXX")" || fail "#8590 could not create a private qualification runtime"
    chmod 0700 "$qualification_runtime_root" || fail "#8590 could not protect the private qualification runtime"
    qualification_runtime_root="$(cd -- "$qualification_runtime_root" && pwd -P)" || fail "#8590 could not canonicalize the private qualification runtime"
    for authority_path in "${qualification_runtime_authority_paths[@]}"; do
      authority_entry="$(git ls-tree "$target_base" -- "$authority_path")" || fail "#8590 could not inspect the first-parent authority $authority_path"
      [[ "$authority_entry" == *$'\t'* && "$authority_entry" != *$'\n'* ]] || fail "#8590 first-parent authority entry is missing or ambiguous: $authority_path"
      authority_metadata="${authority_entry%%$'\t'*}"
      listed_path="${authority_entry#*$'\t'}"
      read -r authority_mode authority_type authority_blob <<<"$authority_metadata"
      [[ "$listed_path" == "$authority_path" && "$authority_type" == "blob" && ("$authority_mode" == "100644" || "$authority_mode" == "100755") && "$authority_blob" =~ ^[0-9a-f]{40}$ ]] || fail "#8590 first-parent qualification authority is not an exact regular blob: $authority_path"
      destination="$qualification_runtime_root/$authority_path"
      destination_parent="$(dirname -- "$destination")"
      install -d -m 0700 "$destination_parent" || fail "#8590 could not create the private authority path for $authority_path"
      git cat-file blob "$authority_blob" >"$destination" || fail "#8590 could not materialize the first-parent authority $authority_path"
      chmod 0600 "$destination" || fail "#8590 could not protect the private authority $authority_path"
      extracted_blob="$(git hash-object "$destination")" || fail "#8590 could not hash the private authority $authority_path"
      [[ "$extracted_blob" == "$authority_blob" ]] || fail "#8590 private authority does not match the first-parent blob: $authority_path"
    done
  }

  require_private_qualification_authority() {
    local authority_path
    local expected_authority_blob
    local private_authority_blob
    local private_authority_path
    [[ -n "$qualification_runtime_root" && -d "$qualification_runtime_root" && ! -L "$qualification_runtime_root" ]] || fail "#8590 private qualification runtime is missing or invalid"
    for authority_path in "${qualification_runtime_authority_paths[@]}"; do
      private_authority_path="$qualification_runtime_root/$authority_path"
      [[ -f "$private_authority_path" && ! -L "$private_authority_path" ]] || fail "#8590 private qualification authority is not a regular file: $authority_path"
      expected_authority_blob="$(git rev-parse "${target_base}:${authority_path}")" || fail "#8590 could not resolve the first-parent authority $authority_path"
      private_authority_blob="$(git hash-object "$private_authority_path")" || fail "#8590 could not hash the private authority $authority_path"
      [[ "$private_authority_blob" == "$expected_authority_blob" ]] || fail "#8590 private qualification authority changed before use: $authority_path"
    done
  }

  load_complete_qualification_authority() {
    local authority_output
    local authority_path
    local bootstrap_path
    local found
    require_private_qualification_authority
    authority_output="$(
      env -u NODE_OPTIONS node --experimental-strip-types --no-warnings \
        "$qualification_runtime_root/$qualification_validator_relative" authority-paths \
        --contract "$qualification_runtime_root/$qualification_contract_relative" \
        --include-contract true
    )" || fail "#8590 could not derive the complete base-trusted qualification authority"
    qualification_authority_paths=()
    while IFS= read -r authority_path; do
      [[ -n "$authority_path" ]] || fail "#8590 complete qualification authority contains an empty path"
      qualification_authority_paths+=("$authority_path")
    done <<<"$authority_output"
    [[ "${#qualification_authority_paths[@]}" -gt 0 ]] || fail "#8590 complete qualification authority is empty"

    for bootstrap_path in "${qualification_bootstrap_authority_paths[@]}"; do
      found=false
      for authority_path in "${qualification_authority_paths[@]}"; do
        if [[ "$authority_path" == "$bootstrap_path" ]]; then
          found=true
          break
        fi
      done
      [[ "$found" == true ]] || fail "#8590 base-trusted authority omitted bootstrap path: $bootstrap_path"
    done

    for authority_path in "${qualification_authority_paths[@]}"; do
      git cat-file -e "${target}:${authority_path}" 2>/dev/null || fail "#8590 qualification authority is missing from the plan target: $authority_path"
      git cat-file -e "${target_base}:${authority_path}" 2>/dev/null || fail "#8590 qualification authority is missing from the target first parent: $authority_path"
      require_commit_authority_regular_blob "$target" "$authority_path" "plan target"
      require_commit_authority_regular_blob "$target_base" "$authority_path" "target first-parent"
    done
    git diff --quiet "$target_base" "$target" -- "${qualification_authority_paths[@]}" || fail "#8590 complete qualification authority differs between the plan target and its first parent"
  }

  authenticate_final_qualification_receipt() {
    require_private_qualification_authority
    env -u NODE_OPTIONS node --experimental-strip-types --no-warnings \
      "$qualification_runtime_root/$qualification_validator_relative" validate-live \
      --contract "$qualification_runtime_root/$qualification_contract_relative" \
      --receipt "$QUALIFICATION_RECEIPT_PATH" \
      --execution-context release \
      --phase final \
      --repository NVIDIA/NemoClaw \
      --candidate-sha "$target" \
      --base-sha "$target_base" || fail "#8590 final qualification receipt is invalid"
  }

  create_qualification_retirement_payload() {
    require_private_qualification_authority
    qualification_retirement_tag_message="$(
      env -u NODE_OPTIONS node --experimental-strip-types --no-warnings \
        "$qualification_runtime_root/$qualification_validator_relative" retirement-tag-message \
        --contract "$qualification_runtime_root/$qualification_contract_relative" \
        --receipt "$QUALIFICATION_RECEIPT_PATH" \
        --release-tag "$tag" \
        --candidate-sha "$target" \
        --base-sha "$target_base"
    )" || fail "#8590 could not render deterministic retirement tag metadata"
    qualification_retirement_metadata_json="$(node -e '
      const message = process.argv[1];
      const tag = process.argv[2];
      const prefix = "NemoClaw-Qualification-Retirement-Evidence: ";
      const marker = tag + "\n\n" + prefix;
      if (!message.startsWith(marker)) throw new Error("retirement tag message prefix is invalid");
      const metadata = JSON.parse(message.slice(marker.length));
      if (marker + JSON.stringify(metadata) !== message) {
        throw new Error("retirement tag metadata is not canonical");
      }
      process.stdout.write(JSON.stringify(metadata));
    ' "$qualification_retirement_tag_message" "$tag")" || fail "#8590 deterministic retirement tag metadata is invalid"
  }

  require_qualification_retirement_payload_unchanged() {
    local expected_message="$qualification_retirement_tag_message"
    local expected_metadata="$qualification_retirement_metadata_json"
    create_qualification_retirement_payload
    [[ "$qualification_retirement_tag_message" == "$expected_message" && "$qualification_retirement_metadata_json" == "$expected_metadata" ]] || fail "#8590 retirement tag metadata changed after final receipt authentication"
  }

  require_local_qualification_authority
  trap cleanup_qualification_runtime EXIT
  materialize_qualification_runtime
  load_complete_qualification_authority
  [[ -n "$QUALIFICATION_RECEIPT_PATH" ]] || fail "--qualification-receipt is required by the #8590 contract"
  [[ "$QUALIFICATION_RECEIPT_PATH" == /* ]] || fail "--qualification-receipt must use an absolute path"
  command -v gh >/dev/null 2>&1 || fail "gh is required to authenticate the #8590 qualification receipt"
  authenticate_final_qualification_receipt
  create_qualification_retirement_payload
elif [[ -n "$QUALIFICATION_RECEIPT_PATH" ]]; then
  fail "--qualification-receipt was provided but the #8590 contract is absent from the plan target"
fi

git fetch origin main --force
require_current_origin_main
if [[ "$contract_in_target" == true ]]; then
  git diff --quiet "$target_base" "$target" -- "${qualification_authority_paths[@]}" || fail "#8590 qualification authority changed during receipt authentication"
fi

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

  cleanup_preflight_state() {
    if git show-ref --verify --quiet "$preflight_ref"; then
      git update-ref -d "$preflight_ref"
    fi
    cleanup_qualification_runtime
  }
  trap cleanup_preflight_state EXIT

  # Exercise Git's configured OpenPGP, SSH, or X.509 signer without publishing a ref.
  if [[ "$contract_in_target" == true ]]; then
    require_local_qualification_authority
  fi
  git tag -s "$preflight_tag" "$target" -m "NemoClaw release signing preflight"
  cleanup_preflight_state
  trap - EXIT

  printf 'release-cut-tag: signing preflight passed for %s at %s\n' "$tag" "$target"
  exit 0
fi

# Release tags are immutable once pushed. Sign the tag on the release
# operator's workstation so the private signing key never enters CI.
cleanup_unpushed_release_tag() {
  if git show-ref --verify --quiet "refs/tags/$tag"; then
    git update-ref -d "refs/tags/$tag"
  fi
  if [[ "$contract_in_target" == true ]]; then
    cleanup_qualification_runtime
  fi
}
trap cleanup_unpushed_release_tag EXIT
if [[ "$contract_in_target" == true ]]; then
  require_local_qualification_authority
  git tag -s "$tag" "$target" -m "$qualification_retirement_tag_message"
else
  git tag -s "$tag" "$target" -m "$tag"
fi
release_tag_object="$(git rev-parse "refs/tags/$tag")"
[[ "$release_tag_object" =~ ^[0-9a-f]{40}$ ]] || fail "local release tag object is invalid"
git fetch origin main --force
require_current_origin_main
if [[ "$contract_in_target" == true ]]; then
  git diff --quiet "$target_base" "$target" -- "${qualification_authority_paths[@]}" || fail "#8590 qualification authority changed before tag push"
  require_local_qualification_authority
  # shellcheck disable=SC2016 # The Node program owns its template-literal expansion.
  tag_upload_payload="$(node -e '
    const { execFileSync } = require("node:child_process");
    const tag = process.argv[1];
    const expectedTarget = process.argv[2];
    const expectedMessage = process.argv[3];
    const raw = execFileSync("git", ["cat-file", "tag", `refs/tags/${tag}`], { encoding: "utf8" });
    const separator = raw.indexOf("\n\n");
    if (separator < 0) throw new Error("signed tag object has no message separator");
    const headers = new Map(raw.slice(0, separator).split("\n").map((line) => {
      const space = line.indexOf(" ");
      if (space < 1) throw new Error("signed tag object has a malformed header");
      return [line.slice(0, space), line.slice(space + 1)];
    }));
    const tagger = /^(.*) <([^<>]*)> ([0-9]+) ([+-])([0-9]{2})([0-9]{2})$/.exec(headers.get("tagger") || "");
    if (!tagger) throw new Error("signed tag object has a malformed tagger");
    if (headers.get("object") !== expectedTarget || headers.get("type") !== "commit" || headers.get("tag") !== tag) {
      throw new Error("signed tag object does not match the release plan");
    }
    const signedMessage = raw.slice(separator + 2);
    const signatureIndex = signedMessage.indexOf("-----BEGIN ");
    if (signatureIndex < 0 || signedMessage.slice(0, signatureIndex).replace(/\n+$/u, "") !== expectedMessage) {
      throw new Error("signed tag object does not contain the exact retirement metadata");
    }
    const offsetMinutes = (Number(tagger[5]) * 60 + Number(tagger[6])) * (tagger[4] === "+" ? 1 : -1);
    const localTime = new Date((Number(tagger[3]) + offsetMinutes * 60) * 1000).toISOString().replace(/\.000Z$/, "");
    process.stdout.write(JSON.stringify({
      message: raw.slice(separator + 2),
      object: expectedTarget,
      tag,
      tagger: {
        date: `${localTime}${tagger[4]}${tagger[5]}:${tagger[6]}`,
        email: tagger[2],
        name: tagger[1],
      },
      type: "commit",
    }));
  ' "$tag" "$target" "$qualification_retirement_tag_message")" || fail "could not serialize the signed release tag"
  tag_upload_response="$(gh api \
    --hostname github.com \
    --method POST \
    "repos/$release_repository/git/tags" \
    --input - \
    <<<"$tag_upload_payload")" || fail "could not upload the signed release tag object"
  uploaded_tag_object="$(node -e '
    const fs = require("node:fs");
    let response;
    try {
      response = JSON.parse(fs.readFileSync(0, "utf8"));
    } catch {
      console.error("GitHub tag verification response is not valid JSON");
      process.exit(1);
    }
    if (!response || typeof response !== "object" || !/^[0-9a-f]{40}$/.test(response.sha || "")) {
      console.error("GitHub tag verification response has no valid object SHA");
      process.exit(1);
    }
    const verification = response.verification;
    if (!verification || verification.verified !== true || verification.reason !== "valid") {
      const reason = typeof verification?.reason === "string" ? verification.reason : "missing";
      console.error("GitHub did not verify the signed tag object (" + reason + ")");
      process.exit(1);
    }
    process.stdout.write(response.sha);
  ' <<<"$tag_upload_response")" || fail "uploaded signed tag object response did not prove GitHub verification"
  [[ "$uploaded_tag_object" == "$release_tag_object" ]] || fail "uploaded signed tag object $uploaded_tag_object does not match local object $release_tag_object"
  qualification_retirement_evidence_json="$(node -e '
    const metadata = JSON.parse(process.argv[1]);
    const releaseTagObjectSha = process.argv[2];
    if (!/^[0-9a-f]{40}$/u.test(releaseTagObjectSha)) {
      throw new Error("release tag object SHA is invalid");
    }
    process.stdout.write(JSON.stringify({ ...metadata, releaseTagObjectSha }));
  ' "$qualification_retirement_metadata_json" "$release_tag_object")" || fail "could not bind the verified tag object to retirement evidence"

  repository_node_id="$(gh api --hostname github.com "repos/$release_repository" --jq '.node_id')" || fail "could not resolve the release repository identity"
  [[ -n "$repository_node_id" ]] || fail "release repository identity is empty"
  zero_oid="0000000000000000000000000000000000000000"
  # shellcheck disable=SC2016 # GraphQL variables must reach GitHub literally.
  update_refs_query='mutation($repositoryId: ID!, $target: GitObjectID!, $tagRef: GitRefname!, $tagObject: GitObjectID!, $zero: GitObjectID!) {
    updateRefs(input: {
      repositoryId: $repositoryId,
      refUpdates: [
        { name: "refs/heads/main", beforeOid: $target, afterOid: $target },
        { name: $tagRef, beforeOid: $zero, afterOid: $tagObject }
      ]
    }) { clientMutationId }
  }'
  preserve_local_release_tag_for_recovery() {
    local current_local_tag_object
    if git show-ref --verify --quiet "refs/tags/$tag"; then
      current_local_tag_object="$(git rev-parse "refs/tags/$tag")"
      if [[ "$current_local_tag_object" != "$release_tag_object" ]]; then
        cleanup_qualification_runtime
        trap - EXIT
        fail "local release tag changed while reconciling publication; remote state requires manual recovery"
      fi
      return
    fi
    git update-ref "refs/tags/$tag" "$release_tag_object" || {
      cleanup_qualification_runtime
      trap - EXIT
      fail "could not recreate the verified local release tag while reconciling publication"
    }
  }

  hard_stop_ambiguous_publication() {
    preserve_local_release_tag_for_recovery
    cleanup_qualification_runtime
    trap - EXIT
    fail "$*"
  }

  reconcile_atomic_publication_failure() {
    local remote_tag_output
    local remote_tag_status
    local remote_tag_object
    local remote_tag_ref
    require_canonical_release_origin
    if remote_tag_output="$(git ls-remote --exit-code --refs origin "refs/tags/$tag" 2>/dev/null)"; then
      read -r remote_tag_object remote_tag_ref <<<"$remote_tag_output"
      if [[ "$remote_tag_output" == *$'\n'* || ! "$remote_tag_object" =~ ^[0-9a-f]{40}$ || "$remote_tag_ref" != "refs/tags/$tag" ]]; then
        hard_stop_ambiguous_publication "atomic publication response was lost and the remote semver ref response is malformed; local tag preserved for recovery"
      fi
    else
      remote_tag_status=$?
      if [[ "$remote_tag_status" -eq 2 ]]; then
        fail "atomic release tag publication failed and the remote semver tag is absent"
      fi
      hard_stop_ambiguous_publication "atomic publication response was lost and the remote semver ref could not be queried; local tag preserved for recovery"
    fi

    if [[ "$remote_tag_object" != "$release_tag_object" ]]; then
      hard_stop_ambiguous_publication "atomic publication response was lost and remote $tag points to $remote_tag_object instead of verified object $release_tag_object; local tag preserved for recovery"
    fi

    local remote_peeled_output
    local remote_peeled_object
    local remote_peeled_ref
    if ! remote_peeled_output="$(git ls-remote --exit-code origin "refs/tags/$tag^{}" 2>/dev/null)"; then
      hard_stop_ambiguous_publication "atomic publication response was lost and remote $tag cannot be peeled to the planned commit; local tag preserved for recovery"
    fi
    read -r remote_peeled_object remote_peeled_ref <<<"$remote_peeled_output"
    if [[ "$remote_peeled_output" == *$'\n'* || "$remote_peeled_object" != "$target" || "$remote_peeled_ref" != "refs/tags/$tag^{}" ]]; then
      hard_stop_ambiguous_publication "atomic publication response was lost and remote $tag does not peel to plan target $target; local tag preserved for recovery"
    fi

    local remote_main_output
    local remote_main_object
    local remote_main_ref
    if ! remote_main_output="$(git ls-remote --exit-code --refs origin refs/heads/main 2>/dev/null)"; then
      hard_stop_ambiguous_publication "atomic publication response was lost and remote main could not be queried; local tag preserved for recovery"
    fi
    read -r remote_main_object remote_main_ref <<<"$remote_main_output"
    if [[ "$remote_main_output" == *$'\n'* || "$remote_main_object" != "$target" || "$remote_main_ref" != "refs/heads/main" ]]; then
      hard_stop_ambiguous_publication "atomic publication response was lost and remote main no longer equals plan target $target; local tag preserved for recovery"
    fi

    preserve_local_release_tag_for_recovery
    printf 'release-cut-tag: recovered from a lost atomic publication response; remote %s is the verified object at %s\n' "$tag" "$target" >&2
  }

  require_canonical_release_origin
  require_local_qualification_authority
  authenticate_final_qualification_receipt
  require_qualification_retirement_payload_unchanged
  if ! gh api --hostname github.com graphql \
    -f query="$update_refs_query" \
    -f repositoryId="$repository_node_id" \
    -f target="$target" \
    -f tagRef="refs/tags/$tag" \
    -f tagObject="$release_tag_object" \
    -f zero="$zero_oid" \
    >/dev/null; then
    reconcile_atomic_publication_failure
  fi
else
  git push origin "refs/tags/$tag"
fi
if [[ "$contract_in_target" == true ]]; then
  cleanup_qualification_runtime
fi
trap - EXIT

if [[ "$contract_in_target" == true ]]; then
  require_canonical_release_origin
fi
remote_tag_output="$(git ls-remote --exit-code --refs origin "refs/tags/$tag" 2>/dev/null)" || fail "Remote $tag direct ref is missing or unreadable"
read -r remote_tag_object remote_tag_ref <<<"$remote_tag_output"
[[ "$remote_tag_output" != *$'\n'* && "$remote_tag_object" =~ ^[0-9a-f]{40}$ && "$remote_tag_ref" == "refs/tags/$tag" ]] || fail "Remote $tag direct ref response is malformed or ambiguous"
[[ "$remote_tag_object" == "$release_tag_object" ]] || fail "Remote $tag points to $remote_tag_object, expected exact signed object $release_tag_object"

remote_peeled_output="$(git ls-remote --exit-code origin "refs/tags/$tag^{}" 2>/dev/null)" || fail "Remote $tag cannot be peeled to the planned commit"
read -r remote_peeled remote_peeled_ref <<<"$remote_peeled_output"
[[ "$remote_peeled_output" != *$'\n'* && "$remote_peeled" == "$target" && "$remote_peeled_ref" == "refs/tags/$tag^{}" ]] || fail "Remote $tag peeled state does not exactly match plan target $target"

result_path="$(dirname "$PLAN_PATH")/cut-result.json"
node -e '
  const fs = require("fs");
  const qualificationRetirementEvidence = process.argv[7]
    ? JSON.parse(process.argv[7])
    : null;
  const result = {
    schemaVersion: 1,
    status: "ok",
    planPath: process.argv[1],
    planHash: process.argv[2],
    tag: process.argv[3],
    targetCommit: process.argv[4],
    remotePeeledCommit: process.argv[5],
    qualificationRetirementEvidence,
    latestTouched: false,
    lkgTouched: false,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(process.argv[6], JSON.stringify(result, null, 2) + "\n");
' "$PLAN_PATH" "$plan_hash" "$tag" "$target" "$remote_peeled" "$result_path" "$qualification_retirement_evidence_json"

printf 'release-cut-tag: pushed %s at %s\n' "$tag" "$target"
printf 'release-cut-tag: result written: %s\n' "$result_path"
