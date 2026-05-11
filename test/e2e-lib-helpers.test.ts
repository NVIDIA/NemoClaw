// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const LIB = path.join(REPO_ROOT, "test/e2e/lib");
const RUN_SCENARIO = path.join(REPO_ROOT, "test/e2e/run-scenario.sh");

function runBash(script: string, env: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync("bash", ["-c", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
    cwd: REPO_ROOT,
  });
}

describe("E2E shell helpers", () => {
  it("env_helper_should_set_standard_noninteractive_env", () => {
    const r = runBash(`
      set -euo pipefail
      . "${LIB}/env.sh"
      e2e_env_apply_noninteractive
      echo "NEMOCLAW_NON_INTERACTIVE=\${NEMOCLAW_NON_INTERACTIVE:-}"
      echo "DEBIAN_FRONTEND=\${DEBIAN_FRONTEND:-}"
      echo "CI=\${CI:-}"
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("NEMOCLAW_NON_INTERACTIVE=1");
    expect(r.stdout).toContain("DEBIAN_FRONTEND=noninteractive");
  });

  it("artifact_helper_should_collect_known_logs_without_failing_when_missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-art-"));
    const srcDir = path.join(tmp, "src");
    const dstDir = path.join(tmp, "out");
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, "present.log"), "hello\n");
    const r = runBash(`
      set -euo pipefail
      . "${LIB}/artifacts.sh"
      e2e_artifact_collect_file "${srcDir}/present.log" "${dstDir}/present.log"
      e2e_artifact_collect_file "${srcDir}/missing.log" "${dstDir}/missing.log" || true
      ls "${dstDir}"
    `);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(path.join(dstDir, "present.log"))).toBe(true);
    expect(fs.existsSync(path.join(dstDir, "missing.log"))).toBe(false);
    expect(r.stderr + r.stdout).toMatch(/missing\.log|not found|skipping/i);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("gateway_helper_should_report_unhealthy_gateway_clearly", () => {
    // Pick a port very unlikely to be bound.
    const r = runBash(`
      set -euo pipefail
      . "${LIB}/gateway.sh"
      e2e_gateway_assert_healthy "http://127.0.0.1:65531"
    `);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/65531|gateway|unhealthy/i);
  });

  it("sandbox_helper_should_fail_for_missing_sandbox_name", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-sb-"));
    try {
      // Initialise a context file without E2E_SANDBOX_NAME.
      const r = runBash(
        `
        set -euo pipefail
        . "${LIB}/context.sh"
        . "${LIB}/assert/sandbox-alive.sh"
        e2e_context_init
        e2e_context_set E2E_SCENARIO test
        e2e_sandbox_assert_running
      `,
        { E2E_CONTEXT_DIR: tmp },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/E2E_SANDBOX_NAME/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("scenario_dry_run_should_trace_helper_sequence_in_order", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-trace-"));
    try {
      const trace = path.join(tmp, "trace.log");
      const r = spawnSync(
        "bash",
        [RUN_SCENARIO, "ubuntu-repo-cloud-openclaw", "--dry-run"],
        {
          env: {
            ...process.env,
            E2E_CONTEXT_DIR: tmp,
            E2E_TRACE_FILE: trace,
          },
          encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
          cwd: REPO_ROOT,
        },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(fs.existsSync(trace), "trace log missing").toBe(true);
      const contents = fs.readFileSync(trace, "utf8");
      const order = ["env:noninteractive", "install:", "onboard:", "gateway:check", "sandbox:check"];
      let pos = 0;
      for (const marker of order) {
        const idx = contents.indexOf(marker, pos);
        expect(idx, `trace missing marker in order: ${marker}\nfull:\n${contents}`).toBeGreaterThanOrEqual(0);
        pos = idx + marker.length;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
