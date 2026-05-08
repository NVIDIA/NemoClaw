// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateExpectedState,
  type ProbeResults,
} from "./e2e/resolver/validator.ts";
import type { ExpectedStateConfig, ResolvedSuite } from "./e2e/resolver/schema.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const RUN_SCENARIO = path.join(REPO_ROOT, "test/e2e/run-scenario.sh");

function cloudOpenclawReady(): ExpectedStateConfig {
  return {
    cli: { installed: true },
    gateway: { expected: "present", health: "healthy" },
    sandbox: { expected: "present", status: "running", agent: "openclaw" },
    inference: {
      expected: "available",
      provider: "nvidia",
      route: "inference-local",
      mode: "gateway-routed",
    },
    credentials: { expected: "present", storage: "gateway-managed" },
  };
}

function passingProbes(): ProbeResults {
  return {
    "cli.installed": true,
    "gateway.health": "healthy",
    "gateway.expected": "present",
    "sandbox.status": "running",
    "sandbox.expected": "present",
    "sandbox.agent": "openclaw",
    "inference.expected": "available",
    "inference.provider": "nvidia",
    "inference.route": "inference-local",
    "inference.mode": "gateway-routed",
    "credentials.expected": "present",
    "credentials.storage": "gateway-managed",
  };
}

describe("expected state validator", () => {
  it("should_validate_matching_state", () => {
    const report = validateExpectedState({
      stateId: "cloud-openclaw-ready",
      state: cloudOpenclawReady(),
      probes: passingProbes(),
      suites: [],
    });
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });

  it("should_fail_when_gateway_expected_but_unhealthy", () => {
    const probes = passingProbes();
    probes["gateway.health"] = "unhealthy";
    const report = validateExpectedState({
      stateId: "cloud-openclaw-ready",
      state: cloudOpenclawReady(),
      probes,
      suites: [],
    });
    expect(report.ok).toBe(false);
    const failing = report.checks.find((c) => c.key === "gateway.health");
    expect(failing?.ok).toBe(false);
    expect(failing?.expected).toBe("healthy");
    expect(failing?.actual).toBe("unhealthy");
  });

  it("should_fail_when_sandbox_expected_but_absent", () => {
    const probes = passingProbes();
    probes["sandbox.status"] = "absent";
    probes["sandbox.expected"] = "absent";
    const report = validateExpectedState({
      stateId: "cloud-openclaw-ready",
      state: cloudOpenclawReady(),
      probes,
      suites: [],
    });
    expect(report.ok).toBe(false);
    expect(report.checks.some((c) => c.key === "sandbox.status" && !c.ok)).toBe(true);
  });

  it("should_fail_when_suite_requires_state_unmet_at_runtime", () => {
    // Expected state claims inference.expected=available, but the probe
    // reports unavailable; the smoke suite happens to pass but an inference
    // suite's requires_state should trigger a runtime failure before
    // execution.
    const state = cloudOpenclawReady();
    const probes = passingProbes();
    probes["inference.expected"] = "unavailable";
    const inferenceSuite: ResolvedSuite = {
      id: "inference",
      requires_state: { "inference.expected": "available" },
      steps: [{ id: "models-health", script: "suites/inference/00-models-health.sh" }],
    };
    const report = validateExpectedState({
      stateId: "cloud-openclaw-ready",
      state,
      probes,
      suites: [inferenceSuite],
    });
    expect(report.ok).toBe(false);
    const msg = report.checks
      .filter((c) => !c.ok)
      .map((c) => `${c.key}=${c.actual ?? "<missing>"} (wanted ${c.expected})`)
      .join("; ");
    expect(msg).toMatch(/inference\.expected/);
    expect(msg).toMatch(/available/);
    expect(msg).toMatch(/unavailable/);
    // Should also reference the suite that made the requirement.
    expect(report.checks.some((c) => c.suite === "inference" && !c.ok)).toBe(true);
  });
});

describe("runner_should_not_run_suites_when_expected_state_fails", () => {
  it("runs expected-state validation and skips suites on failure", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-es-"));
    try {
      const trace = path.join(tmp, "trace.log");
      // Simulate gateway-unhealthy probe by setting an override env var.
      const r = spawnSync(
        "bash",
        [RUN_SCENARIO, "ubuntu-repo-cloud-openclaw", "--dry-run"],
        {
          env: {
            ...process.env,
            E2E_CONTEXT_DIR: tmp,
            E2E_TRACE_FILE: trace,
            // validator reads these overrides in dry-run mode to fake probes
            E2E_PROBE_OVERRIDE_GATEWAY_HEALTH: "unhealthy",
            E2E_VALIDATE_EXPECTED_STATE: "1",
          },
          encoding: "utf8",
          cwd: REPO_ROOT,
        },
      );
      // Dry-run execution should now fail because the expected state
      // validation runs and sees gateway.health=unhealthy.
      expect(r.status).not.toBe(0);
      // Validator must run (its report file should exist) but suites must not.
      const reportPath = path.join(tmp, "expected-state-report.json");
      expect(fs.existsSync(reportPath), `missing ${reportPath}`).toBe(true);
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      expect(report.ok).toBe(false);
      expect(report.checks.some((c: { key: string; ok: boolean }) => c.key === "gateway.health" && !c.ok)).toBe(true);
      // And the run's failure output should reference expected-state, not suites.
      expect(`${r.stdout}${r.stderr}`).toMatch(/expected.state/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
