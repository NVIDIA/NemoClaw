// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 6: Migrate First Scenario - ubuntu-repo-cloud-openclaw.
 * Verifies resolver output, plan printout, and dry-run phase ordering.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadMetadataFromDir } from "../runtime/resolver/load.ts";
import { resolveScenario } from "../runtime/resolver/plan.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const E2E_DIR = path.join(REPO_ROOT, "test/e2e");
const RUN_SCENARIO = path.join(E2E_DIR, "runtime", "run-scenario.sh");

describe("Phase 6: ubuntu-repo-cloud-openclaw migration", () => {
  it("ubuntu_repo_cloud_openclaw_should_resolve_to_cloud_openclaw_ready", () => {
    const meta = loadMetadataFromDir(E2E_DIR);
    const plan = resolveScenario("ubuntu-repo-cloud-openclaw", meta);
    expect(plan.expected_state.id).toBe("cloud-openclaw-ready");
    const suiteIds = plan.suites.map((s) => s.id);
    expect(suiteIds).toContain("smoke");
    expect(suiteIds).toContain("inference");
  });

  it("ubuntu_repo_cloud_openclaw_plan_should_include_setup_install_onboard", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-first-"));
    try {
      const r = spawnSync(
        "bash",
        [RUN_SCENARIO, "ubuntu-repo-cloud-openclaw", "--plan-only"],
        { env: { ...process.env, E2E_CONTEXT_DIR: tmp }, encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000), cwd: REPO_ROOT },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/install=repo-current/);
      expect(r.stdout).toMatch(/runtime=docker-running/);
      expect(r.stdout).toMatch(/onboarding=cloud-openclaw/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ubuntu_repo_cloud_openclaw_dry_run_should_execute_phases_in_order", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-first-"));
    try {
      const trace = path.join(tmp, "trace.log");
      const r = spawnSync(
        "bash",
        [RUN_SCENARIO, "ubuntu-repo-cloud-openclaw", "--dry-run"],
        {
          env: { ...process.env, E2E_CONTEXT_DIR: tmp, E2E_TRACE_FILE: trace },
          encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
          cwd: REPO_ROOT,
        },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(fs.existsSync(trace)).toBe(true);
      const contents = fs.readFileSync(trace, "utf8");
      const order = [
        "env:noninteractive",
        "install:repo-current",
        "onboard:cloud-openclaw",
        "gateway:check",
        "sandbox:check",
      ];
      let pos = 0;
      for (const marker of order) {
        const idx = contents.indexOf(marker, pos);
        expect(idx, `missing marker ${marker}. trace:\n${contents}`).toBeGreaterThanOrEqual(0);
        pos = idx + marker.length;
      }
      // The run should also seed the context and produce plan.json.
      expect(fs.existsSync(path.join(tmp, "context.env"))).toBe(true);
      expect(fs.existsSync(path.join(tmp, "plan.json"))).toBe(true);
      // After dry-run, suite runner should be able to execute the full
      // suite sequence against the emitted context.
      const suites = spawnSync(
        "bash",
        [path.join(E2E_DIR, "runtime", "run-suites.sh"), "smoke", "inference"],
        {
          env: { ...process.env, E2E_CONTEXT_DIR: tmp, E2E_DRY_RUN: "1" },
          encoding: "utf8",
    timeout: Number(process.env.E2E_SPAWN_TIMEOUT_MS ?? 60_000),
          cwd: REPO_ROOT,
        },
      );
      expect(suites.status, `suite stderr:${suites.stderr}\nstdout:${suites.stdout}`).toBe(0);
      expect(suites.stdout).toMatch(/PASS smoke\/cli-available/);
      expect(suites.stdout).toMatch(/PASS inference\/models-health/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
