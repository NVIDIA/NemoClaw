#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Run one or more functional suites against a completed E2E environment.
#
# Usage:
#   bash test/e2e/runtime/run-suites.sh <suite-id> [<suite-id> ...]
#
# Reads suite metadata from test/e2e/validation_suites/suites.yaml
# (or $E2E_SUITES_FILE). Each suite script receives .e2e/context.env
# via E2E_CONTEXT_DIR and is expected to source runtime/lib/context.sh if
# it needs specific keys.
#
# Environment:
#   E2E_CONTEXT_DIR   Directory containing context.env (default: <repo>/.e2e)
#   E2E_SUITES_FILE   Override suites metadata file (for tests)
#   E2E_SUITES_DIR    Override the directory that suite scripts are resolved
#                     against (default: test/e2e/validation_suites/)
#   E2E_DRY_RUN       When 1, suite scripts run in dry-run mode themselves.
#
# Exit code: 0 if all steps pass; non-zero at the first failing step.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
VALIDATION_SUITES_DIR="${E2E_ROOT}/validation_suites"

if (($# == 0)); then
  echo "run-suites: at least one suite id required" >&2
  echo "Usage: bash test/e2e/runtime/run-suites.sh <suite-id> [<suite-id> ...]" >&2
  exit 2
fi

export E2E_CONTEXT_DIR="${E2E_CONTEXT_DIR:-${REPO_ROOT}/.e2e}"
SUITES_FILE="${E2E_SUITES_FILE:-${VALIDATION_SUITES_DIR}/suites.yaml}"
SUITES_DIR="${E2E_SUITES_DIR:-${VALIDATION_SUITES_DIR}}"

CTX_FILE="${E2E_CONTEXT_DIR}/context.env"
if [[ ! -f "${CTX_FILE}" ]]; then
  echo "run-suites: missing ${CTX_FILE}; run-scenario.sh must emit context before running suites" >&2
  exit 1
fi

# Sanity-check that the baseline scenario key is present.
if ! grep -q '^E2E_SCENARIO=' "${CTX_FILE}"; then
  echo "run-suites: ${CTX_FILE} is missing required key E2E_SCENARIO" >&2
  exit 1
fi

# Resolve the suite step list by reading the YAML via node.
resolve_suite() {
  local suite_id="$1"
  node -e "
    const fs = require('fs');
    const path = process.argv[1];
    const wanted = process.argv[2];
    const raw = fs.readFileSync(path, 'utf8');
    // Minimal YAML reader: prefer js-yaml if available; else fall back.
    let yaml;
    try { yaml = require('js-yaml'); } catch (_) {
      process.stderr.write('run-suites: js-yaml required to parse suite metadata\n');
      process.exit(2);
    }
    const doc = yaml.load(raw);
    if (!doc || !doc.suites || !doc.suites[wanted]) {
      process.stderr.write('run-suites: unknown suite: ' + wanted + '\n');
      process.exit(3);
    }
    const steps = doc.suites[wanted].steps || [];
    for (const s of steps) {
      if (!s || typeof s.id !== 'string' || typeof s.script !== 'string') {
        process.stderr.write('run-suites: malformed step in ' + wanted + '\n');
        process.exit(4);
      }
      process.stdout.write(s.id + '\t' + s.script + '\n');
    }
  " "${SUITES_FILE}" "${suite_id}"
}

declare -a FAILED_STEPS=()
declare -a PASSED_STEPS=()
OVERALL_STATUS=0

run_one_suite() {
  local suite_id="$1"
  echo "== suite: ${suite_id} =="
  local steps
  if ! steps="$(resolve_suite "${suite_id}")"; then
    OVERALL_STATUS=1
    return 1
  fi
  if [[ -z "${steps}" ]]; then
    echo "  (no steps)"
    return 0
  fi
  while IFS=$'\t' read -r step_id script; do
    [[ -z "${step_id}" ]] && continue
    local full="${SUITES_DIR}/${script}"
    echo "  -> step: ${step_id} (${script})"
    if [[ ! -f "${full}" ]]; then
      echo "    FAIL: script not found at ${full}" >&2
      FAILED_STEPS+=("${suite_id}/${step_id}")
      OVERALL_STATUS=1
      return 1
    fi
    if ! bash "${full}"; then
      echo "    FAIL: suite=${suite_id} step=${step_id}" >&2
      FAILED_STEPS+=("${suite_id}/${step_id}")
      OVERALL_STATUS=1
      return 1
    fi
    echo "    PASS: ${step_id}"
    PASSED_STEPS+=("${suite_id}/${step_id}")
  done <<<"${steps}"
}

for suite_id in "$@"; do
  if ! run_one_suite "${suite_id}"; then
    break
  fi
done

echo
echo "== suite summary =="
# bash 3.2 (macOS) fails on "${arr[@]}" when the array is empty under `set -u`;
# use the `${arr[@]+...}` guard to expand to nothing when empty.
for p in ${PASSED_STEPS[@]+"${PASSED_STEPS[@]}"}; do
  echo "  PASS ${p}"
done
for f in ${FAILED_STEPS[@]+"${FAILED_STEPS[@]}"}; do
  echo "  FAIL ${f}"
done

exit "${OVERALL_STATUS}"
