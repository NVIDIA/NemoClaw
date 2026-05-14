#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Compare PASS/FAIL outcomes between a legacy e2e log and a migrated
# scenario log using the mapping in test/e2e/docs/parity-map.yaml.
#
# Usage:
#   scripts/e2e/compare-parity.sh \
#     --script <legacy-script-name>.sh \
#     --legacy <legacy.log> \
#     --scenario <scenario.log> \
#     [--map <parity-map.yaml>] [--strict] [--report <report.json>]
#     [--bucket <bucket>] [--all-migrated true|false] [--deferred-handling skip|report]
#
# Emits a JSON divergence report on stdout when divergence is found, plus
# a human summary line. Exits 0 on no divergence, non-zero on divergence
# or misuse.
#
# The "normalize both logs into {assertion_id, status}" logic is kept in
# one place so CI and local repro stay in lock-step.

set -euo pipefail

SCRIPT_NAME=""
LEGACY_LOG=""
SCENARIO_LOG=""
MAP_FILE=""
STRICT=0
REPORT_FILE=""
BUCKET=""
ALL_MIGRATED="false"
DEFERRED_HANDLING="skip"

usage() {
  cat >&2 <<'USAGE'
Usage: compare-parity.sh --script <legacy.sh> --legacy <log> --scenario <log> [--map <yaml>] [--strict] [--report <json>] [--bucket <bucket>] [--all-migrated true|false] [--deferred-handling skip|report]
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --script)
      SCRIPT_NAME="${2:?}"
      shift 2
      ;;
    --legacy)
      LEGACY_LOG="${2:?}"
      shift 2
      ;;
    --scenario)
      SCENARIO_LOG="${2:?}"
      shift 2
      ;;
    --map)
      MAP_FILE="${2:?}"
      shift 2
      ;;
    --strict)
      STRICT=1
      shift
      ;;
    --report)
      REPORT_FILE="${2:?}"
      shift 2
      ;;
    --bucket)
      BUCKET="${2:?}"
      shift 2
      ;;
    --all-migrated)
      ALL_MIGRATED="${2:?}"
      shift 2
      ;;
    --deferred-handling)
      DEFERRED_HANDLING="${2:?}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "compare-parity: unknown arg: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "${SCRIPT_NAME}" || -z "${LEGACY_LOG}" || -z "${SCENARIO_LOG}" ]]; then
  usage
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
if [[ -z "${MAP_FILE}" ]]; then
  MAP_FILE="${REPO_ROOT}/test/e2e/docs/parity-map.yaml"
fi
if [[ ! -f "${MAP_FILE}" ]]; then
  echo "compare-parity: map file not found: ${MAP_FILE}" >&2
  exit 2
fi

# The comparison logic is implemented in Node (available on all CI runners
# without extra setup) so we can parse YAML cleanly.
node --no-warnings - "${SCRIPT_NAME}" "${LEGACY_LOG}" "${SCENARIO_LOG}" "${MAP_FILE}" "${STRICT}" "${REPORT_FILE}" "${BUCKET}" "${ALL_MIGRATED}" "${DEFERRED_HANDLING}" <<'JS'
const fs = require("node:fs");
const path = require("node:path");

const [scriptName, legacyLog, scenarioLog, mapFile, strictRaw, reportFile, bucket, allMigratedRaw, deferredHandling] = process.argv.slice(2);
const strict = strictRaw === "1";

function loadYaml(file) {
  // Use the repo's vendored js-yaml (a root dependency) when available;
  // otherwise fall back to a tiny parser sufficient for the narrow schema.
  try {
    const yaml = require("js-yaml");
    return yaml.load(fs.readFileSync(file, "utf8")) ?? {};
  } catch (_) {
    // Ultra-minimal YAML fallback: only handles the parity-map shape.
    const text = fs.readFileSync(file, "utf8");
    const out = { scripts: {} };
    let currentScript = null;
    let currentEntry = null;
    const lines = text.split("\n");
    for (const raw of lines) {
      if (raw.trimStart().startsWith("#")) continue;
      if (/^scripts:\s*(\{\})?\s*$/.test(raw)) continue;
      // scripts:
      // <indent-2>name.sh:
      let m = raw.match(/^\s{2}([\w.\-]+):\s*$/);
      if (m) { currentScript = m[1]; out.scripts[currentScript] = { assertions: [] }; currentEntry = null; continue; }
      m = raw.match(/^\s{4}scenario:\s*(.+?)\s*$/);
      if (m && currentScript) { out.scripts[currentScript].scenario = m[1]; continue; }
      m = raw.match(/^\s{4}assertions:\s*$/);
      if (m && currentScript) { out.scripts[currentScript].assertions = []; continue; }
      m = raw.match(/^\s{6}-\s*legacy:\s*"(.*)"\s*$/);
      if (m && currentScript) { currentEntry = { legacy: m[1] }; out.scripts[currentScript].assertions.push(currentEntry); continue; }
      m = raw.match(/^\s{8}id:\s*(.+?)\s*$/);
      if (m && currentEntry) { currentEntry.id = m[1]; continue; }
      m = raw.match(/^\s{8}flaky:\s*(true|false)\s*$/);
      if (m && currentEntry) { currentEntry.flaky = m[1] === "true"; continue; }
    }
    return out;
  }
}

function readLog(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function normalize(logText, legacyString, scenarioId) {
  // Returns { legacy: "PASS"|"FAIL"|"MISSING", scenario: ... }
  const has = (needle) => {
    if (!needle) return null;
    const lines = logText.split(/\r?\n/);
    let pass = false, fail = false;
    for (const line of lines) {
      if (line.startsWith("PASS:") && line.includes(needle)) pass = true;
      if (line.startsWith("FAIL:") && line.includes(needle)) fail = true;
    }
    if (fail) return "FAIL";
    if (pass) return "PASS";
    return "MISSING";
  };
  return { legacy: has(legacyString), scenario: has(scenarioId) };
}

const map = loadYaml(mapFile);
const entry = (map.scripts ?? {})[scriptName];
if (!entry || !Array.isArray(entry.assertions) || entry.assertions.length === 0) {
  const report = { script: scriptName, bucket, all_migrated: allMigratedRaw === "true", strict, deferred_handling: deferredHandling, divergence: [], counts: { mapped: 0, deferred: 0, retired: 0 }, note: "no mappings" };
  if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  if (strict) {
    console.error(`compare-parity: no mappings for ${scriptName} in strict mode`);
    process.exit(1);
  }
  console.log(`compare-parity: no mappings for ${scriptName}; no-divergence`);
  process.exit(0);
}

const legacyText = readLog(legacyLog);
const scenarioText = readLog(scenarioLog);
const divergence = [];
const counts = { mapped: 0, deferred: 0, retired: 0 };
const outcomes = [];
for (const a of entry.assertions) {
  const status = a.status || "mapped";
  if (status === "deferred" || status === "retired") {
    counts[status]++;
    if (deferredHandling === "report") outcomes.push({ legacy: a.legacy, status });
    continue;
  }
  counts.mapped++;
  const n = normalize("", a.legacy, a.id);  // placeholder
  // Run legacy lookup against the legacy log, scenario against the scenario log.
  const legacyStatus = (() => {
    const lines = legacyText.split(/\r?\n/);
    let pass = false, fail = false;
    for (const line of lines) {
      if (line.startsWith("PASS:") && line.includes(a.legacy)) pass = true;
      if (line.startsWith("FAIL:") && line.includes(a.legacy)) fail = true;
    }
    if (fail) return "FAIL";
    if (pass) return "PASS";
    return "MISSING";
  })();
  const scenarioStatus = (() => {
    const lines = scenarioText.split(/\r?\n/);
    let pass = false, fail = false;
    const needle = a.id;
    for (const line of lines) {
      if (line.startsWith("PASS:") && line.includes(needle)) pass = true;
      if (line.startsWith("FAIL:") && line.includes(needle)) fail = true;
    }
    if (fail) return "FAIL";
    if (pass) return "PASS";
    return "MISSING";
  })();

  if (a.flaky) {
    // Flaky: both-pass-or-both-fail counts as aligned.
    if (legacyStatus !== scenarioStatus) {
      divergence.push({ id: a.id, legacy: legacyStatus, scenario: scenarioStatus, flaky: true });
    }
    continue;
  }
  if (legacyStatus !== scenarioStatus) {
    divergence.push({ id: a.id, legacy: legacyStatus, scenario: scenarioStatus });
  }
  outcomes.push({ id: a.id, legacy: legacyStatus, scenario: scenarioStatus });
}

const report = { script: scriptName, scenario: entry.scenario, bucket: entry.bucket || bucket, all_migrated: allMigratedRaw === "true", strict, deferred_handling: deferredHandling, counts, outcomes, divergence };
if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (divergence.length > 0) {
  console.error(`compare-parity: ${divergence.length} diverging assertion(s) for ${scriptName}`);
  for (const d of divergence) {
    console.error(`  ${d.id}: legacy=${d.legacy} scenario=${d.scenario}`);
  }
  process.exit(1);
}
console.log(`compare-parity: no divergence for ${scriptName}`);
JS
