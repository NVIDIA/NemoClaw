// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const LINT_BIN = path.join(REPO_ROOT, "scripts/e2e/lint-conventions.ts");
const COMPARE_PARITY = path.join(REPO_ROOT, "scripts/e2e/compare-parity.sh");
const PARITY_MAP_REAL = path.join(REPO_ROOT, "test/e2e/docs/parity-map.yaml");

function runTsx(scriptPath: string, args: string[] = [], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  const tsx = path.join(REPO_ROOT, "node_modules/.bin/tsx");
  return spawnSync(tsx, [scriptPath, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
    cwd: REPO_ROOT,
  });
}

function runBash(script: string, env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync("bash", ["-c", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
    cwd: REPO_ROOT,
  });
}

/**
 * Create a synthetic repo layout mirroring the paths the lint walks:
 *   <root>/test/e2e/validation_suites/<suite>/<step>.sh  (suite step scripts)
 *   <root>/test/e2e/test-*.sh                            (legacy scripts)
 *   <root>/test/e2e/docs/parity-map.yaml                 (mapping file)
 */
function makeSyntheticRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-lint-"));
  fs.mkdirSync(path.join(tmp, "test/e2e/validation_suites/example"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "test/e2e/docs"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "test/e2e/docs/parity-map.yaml"), "scripts: {}\n");
  return tmp;
}

function writeStep(tmp: string, name: string, body: string) {
  const p = path.join(tmp, "test/e2e/validation_suites/example", name);
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
}

function writeLegacy(tmp: string, name: string, body: string) {
  const p = path.join(tmp, "test/e2e", name);
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
}

describe("Phase 1.G convention lint", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeSyntheticRepo();
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("lint_should_flag_step_that_reexports_noninteractive_env", () => {
    writeStep(tmp, "00-bad.sh", 'export DEBIAN_FRONTEND=noninteractive\necho hi');
    const r = runTsx(LINT_BIN, ["--root", tmp]);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/00-bad\.sh/);
    expect(r.stdout + r.stderr).toMatch(/DEBIAN_FRONTEND|non.?interactive/i);
  });

  it("lint_should_flag_step_that_registers_own_trap", () => {
    writeStep(tmp, "00-trap.sh", 'trap cleanup EXIT');
    const r = runTsx(LINT_BIN, ["--root", tmp]);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/00-trap\.sh/);
    expect(r.stdout + r.stderr).toMatch(/trap/i);
  });

  it("lint_should_flag_step_that_calls_section", () => {
    writeStep(tmp, "00-section.sh", 'section "Phase 3: X"');
    const r = runTsx(LINT_BIN, ["--root", tmp]);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/00-section\.sh/);
    expect(r.stdout + r.stderr).toMatch(/section/i);
  });

  it("lint_should_flag_step_writing_to_tmp_log_path", () => {
    writeStep(tmp, "00-tmplog.sh", 'echo hi > /tmp/foo.log');
    const r = runTsx(LINT_BIN, ["--root", tmp]);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/00-tmplog\.sh/);
    expect(r.stdout + r.stderr).toMatch(/\/tmp.*\.log|E2E_CONTEXT_DIR/);
  });

  it("lint_should_flag_nonstandard_repo_root_discovery_pattern", () => {
    writeStep(tmp, "00-reporoot.sh", 'REPO_ROOT="$(git rev-parse --show-toplevel)"');
    const r = runTsx(LINT_BIN, ["--root", tmp]);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/repo.?root|git rev-parse/i);
  });

  it("lint_should_flag_new_legacy_test_script_with_no_parity_map_entry", () => {
    writeLegacy(tmp, "test-new-thing.sh", '# legacy script\npass "something"');
    const r = runTsx(LINT_BIN, ["--root", tmp]);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/test-new-thing\.sh/);
    expect(r.stdout + r.stderr).toMatch(/parity.?map/i);
  });

  it("retired_wrapper_lint_should_reject_monolithic_logic", () => {
    writeLegacy(tmp, "test-retired.sh", 'pass() { echo "PASS: $*"; }\nnemoclaw onboard --name old\n');
    fs.writeFileSync(
      path.join(tmp, "test/e2e/docs/parity-map.yaml"),
      `scripts:\n  test-retired.sh:\n    status: retired\n    scenario: ubuntu-repo-cloud-openclaw\n    assertions: []\n`,
    );
    fs.writeFileSync(
      path.join(tmp, "test/e2e/docs/parity-inventory.generated.json"),
      JSON.stringify({ generated_by: "test", entrypoints: [], totals: { scripts: 0, assertions: 0, zero_assertion_scripts: 0 } }),
    );
    const r = runTsx(LINT_BIN, ["--root", tmp]);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/test-retired\.sh/);
    expect(r.stdout + r.stderr).toMatch(/retired-wrapper/);
  });

  it("lint_should_pass_on_current_repo_state", () => {
    const r = runTsx(LINT_BIN);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.H — Parity harness (compare-parity.sh)
// ─────────────────────────────────────────────────────────────────────────────

function writeMap(tmp: string, content: string): string {
  const p = path.join(tmp, "parity-map.yaml");
  fs.writeFileSync(p, content);
  return p;
}

describe("Phase 1.H parity harness", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-parity-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("compare_parity_should_produce_empty_diff_when_map_is_empty", () => {
    const mapPath = writeMap(tmp, "scripts: {}\n");
    const legacyLog = path.join(tmp, "legacy.log");
    const scenarioLog = path.join(tmp, "scenario.log");
    fs.writeFileSync(legacyLog, "");
    fs.writeFileSync(scenarioLog, "");
    const r = runBash(
      `bash "${COMPARE_PARITY}" --script none.sh --legacy "${legacyLog}" --scenario "${scenarioLog}" --map "${mapPath}"`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/no.?divergence|no.?mappings/i);
  });

  it("compare_parity_should_exit_nonzero_when_any_assertion_diverges", () => {
    const mapPath = writeMap(
      tmp,
      `
scripts:
  sample.sh:
    scenario: dummy
    assertions:
      - legacy: "thing works"
        id: thing.works
`.trimStart(),
    );
    const legacyLog = path.join(tmp, "legacy.log");
    const scenarioLog = path.join(tmp, "scenario.log");
    // Legacy passed, scenario failed → divergence.
    fs.writeFileSync(legacyLog, 'PASS: thing works\n');
    fs.writeFileSync(scenarioLog, 'FAIL: thing.works\n');
    const r = runBash(
      `bash "${COMPARE_PARITY}" --script sample.sh --legacy "${legacyLog}" --scenario "${scenarioLog}" --map "${mapPath}"`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/thing\.works|thing works/);
    expect(r.stdout + r.stderr).toMatch(/diverg/i);
  });

  it("compare_parity_should_treat_flaky_marked_assertion_as_both_pass_or_both_fail", () => {
    const mapPath = writeMap(
      tmp,
      `
scripts:
  sample.sh:
    scenario: dummy
    assertions:
      - legacy: "sometimes breaks"
        id: sometimes.breaks
        flaky: true
`.trimStart(),
    );
    const legacyLog = path.join(tmp, "legacy.log");
    const scenarioLog = path.join(tmp, "scenario.log");
    // Both FAIL → flaky should accept this as non-divergent.
    fs.writeFileSync(legacyLog, 'FAIL: sometimes breaks\n');
    fs.writeFileSync(scenarioLog, 'FAIL: sometimes.breaks\n');
    const r = runBash(
      `bash "${COMPARE_PARITY}" --script sample.sh --legacy "${legacyLog}" --scenario "${scenarioLog}" --map "${mapPath}"`,
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Static: parity-map.yaml must exist (empty but parseable).
// ─────────────────────────────────────────────────────────────────────────────

describe("parity-map.yaml seed", () => {
  it("should_exist_under_test_e2e_and_be_valid_yaml_even_when_empty", () => {
    expect(fs.existsSync(PARITY_MAP_REAL)).toBe(true);
    const content = fs.readFileSync(PARITY_MAP_REAL, "utf8");
    expect(content).toMatch(/scripts:/);
  });
});
