// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { HostCliClient } from "../scenarios/clients/host-cli.ts";
import { compileRunPlans } from "../scenarios/compiler.ts";
import { PhaseOrchestrator } from "../scenarios/orchestrators/phase.ts";
import { ScenarioRunner } from "../scenarios/orchestrators/runner.ts";
import type { AssertionStep, PhaseName, PhaseResult, RunContext, RunPlanPhase } from "../scenarios/types.ts";

function fakeCtx(): RunContext {
  return { contextDir: fs.mkdtempSync(path.join(process.cwd(), ".tmp-e2e-phase-")), dryRun: true };
}

function fakeStep(id: string, phase: PhaseName, ref = "fake-pass"): AssertionStep {
  return {
    id,
    phase,
    implementation: { kind: "probe", ref },
    evidencePath: `.e2e/assertions/${id}.json`,
  };
}

function fakePhase(step: AssertionStep): RunPlanPhase {
  return {
    name: step.phase,
    actions: [],
    assertionGroups: [{ id: `group.${step.id}`, phase: step.phase, migrationStatus: "complete", steps: [step] }],
  };
}

describe("phase orchestrators", () => {
  it("test_should_execute_phase_assertions_from_phase_orchestrators_not_top_level_runner", async () => {
    const ctx = fakeCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
      const calls: string[] = [];
      const fakeOrchestrator = (phase: PhaseName) => ({
        run: async (_ctx: RunContext, runPhase: RunPlanPhase, _prior?: PhaseResult[]): Promise<PhaseResult> => {
          calls.push(runPhase.name);
          return { phase, status: "passed", assertions: [] };
        },
      });
      const runner = new ScenarioRunner({
        environment: fakeOrchestrator("environment"),
        onboarding: fakeOrchestrator("onboarding"),
        runtime: fakeOrchestrator("runtime"),
      });

      const results = await runner.run(ctx, plan);

      expect(calls).toEqual(["environment", "onboarding", "runtime"]);
      expect(results.map((result) => result.phase)).toEqual(["environment", "onboarding", "runtime"]);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("test_should_record_step_status_attempts_duration_classifier_and_evidence", async () => {
    const ctx = fakeCtx();
    try {
      const step = fakeStep("runtime.retry-pass", "runtime", "fake-retry-once-pass");
      step.reliability = { retry: { attempts: 2, on: ["gateway-transient"] } };
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, fakePhase(step));

      expect(result.status).toBe("passed");
      expect(result.assertions[0]).toEqual(
        expect.objectContaining({
          id: "runtime.retry-pass",
          status: "passed",
          attempts: 2,
          classifier: "gateway-transient",
          evidence: ".e2e/assertions/runtime.retry-pass.json",
        }),
      );
      expect(result.assertions[0].durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("test_should_enforce_timeout_and_retry_policy_in_orchestrator", async () => {
    const ctx = fakeCtx();
    try {
      const step = fakeStep("runtime.retry-fail", "runtime", "fake-always-transient");
      step.reliability = { timeoutSeconds: 1, retry: { attempts: 2, on: ["provider-transient"] } };
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, fakePhase(step));

      expect(result.status).toBe("failed");
      expect(result.assertions[0]).toEqual(
        expect.objectContaining({
          id: "runtime.retry-fail",
          status: "failed",
          attempts: 2,
          classifier: "provider-transient",
        }),
      );
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("test_should_keep_clients_free_of_pass_fail_and_retry_semantics", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "test/e2e-scenario/scenarios/clients/host-cli.ts"),
      "utf8",
    );
    const observation = new HostCliClient().observeVersion();

    expect(observation).toEqual(expect.objectContaining({ command: ["nemoclaw", "--version"] }));
    expect(source).not.toMatch(/AssertionResult|PhaseResult|retry|timeout|passed|failed/);
  });
});
