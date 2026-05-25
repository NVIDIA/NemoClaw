// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const LINT_BIN = path.join(REPO_ROOT, "scripts/e2e/lint-conventions.ts");

function runTsx(scriptPath: string, args: string[] = [], env: Record<string, string> = {}): SpawnSyncReturns<string> {
  const tsx = path.join(REPO_ROOT, "node_modules/.bin/tsx");
  return spawnSync(tsx, [scriptPath, ...args], {
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
 */
function makeSyntheticRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-lint-"));
  fs.mkdirSync(path.join(tmp, "test/e2e/validation_suites/example"), { recursive: true });
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

  it("lint_should_not_require_legacy_scripts_to_update_parity_map", () => {
    writeLegacy(tmp, "test-new-thing.sh", '# legacy script\npass "something"');
    const r = runTsx(LINT_BIN, ["--root", tmp]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });


  it("lint_should_pass_on_current_repo_state", () => {
    const r = runTsx(LINT_BIN);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
