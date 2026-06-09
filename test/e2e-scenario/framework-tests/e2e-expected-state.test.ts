// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { compileRunPlans } from "../scenarios/compiler.ts";
import {
  getExpectedState,
  listExpectedStates,
  probesForState,
  requireExpectedState,
} from "../scenarios/expected-states.ts";
import { ScenarioRunner } from "../scenarios/orchestrators/runner.ts";
import { listScenarios } from "../scenarios/registry.ts";
import type {
  ExpectedState,
  PhaseName,
  PhaseResult,
  RunContext,
  RunPlanPhase,
} from "../scenarios/types.ts";

function freshCtx(): RunContext {
  return { contextDir: fs.mkdtempSync(path.join(os.tmpdir(), "e2e-state-")) };
}

// The legacy parity tests against `nemoclaw_scenarios/expected-states.yaml`
// were retired alongside the YAML resolver path (see commit 9da75ac0a).
// The typed registry in `scenarios/expected-states.ts` is the single source
// of truth; these id-coverage assertions replace the YAML-mirror checks.
describe("typed expected-state registry id coverage", () => {
  it("exposes a non-empty list of registered expected-state ids", () => {
    const ids = listExpectedStates().map((s) => s.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("requireExpectedState throws on unknown id with available list", () => {
    expect(() => requireExpectedState("does-not-exist")).toThrow(/Unknown expected_state/);
  });

  it("getExpectedState returns the state for known ids", () => {
    expect(getExpectedState("cloud-openclaw-ready")?.id).toBe("cloud-openclaw-ready");
  });
});

describe("probesForState maps typed expected-state into probe ids", () => {
  it("ready cloud state emits cli-installed, gateway-healthy, sandbox-running", () => {
    expect(probesForState(requireExpectedState("cloud-openclaw-ready"))).toEqual([
      "cli-installed",
      "gateway-healthy",
      "sandbox-running",
    ]);
  });

  it("preflight-failure state emits cli-installed, gateway-absent, sandbox-absent", () => {
    expect(probesForState(requireExpectedState("preflight-failure-no-sandbox"))).toEqual([
      "cli-installed",
      "gateway-absent",
      "sandbox-absent",
    ]);
  });

  it("optional-dimension state emits cli-installed only", () => {
    expect(probesForState(requireExpectedState("macos-cli-ready-docker-optional"))).toEqual([
      "cli-installed",
    ]);
  });

  it("inference and credentials probes are intentionally NOT emitted yet", () => {
    // The typed registry declares inference.expected=available and
    // credentials.expected=present for ready states; the compiler does
    // not yet emit probe actions for those dimensions because the
    // probe scripts aren't written. This test pins that gap so a
    // future probe-script PR is forced to update probesForState too.
    const state: ExpectedState = {
      id: "synthetic",
      inference: { expected: "available", provider: "nvidia" },
      credentials: { expected: "present" },
    };
    expect(probesForState(state)).toEqual([]);
  });

  it("localRegistry.expected=present emits the local-registry-entry-present probe", () => {
    const state: ExpectedState = {
      id: "synthetic-local-registry",
      cli: { installed: true },
      localRegistry: { expected: "present" },
    };
    expect(probesForState(state)).toEqual(["cli-installed", "local-registry-entry-present"]);
  });

  it("dockerSandboxContainer.expected=present emits the docker-sandbox-container-present probe", () => {
    const state: ExpectedState = {
      id: "synthetic-docker-container",
      cli: { installed: true },
      dockerSandboxContainer: { expected: "present" },
    };
    expect(probesForState(state)).toEqual(["cli-installed", "docker-sandbox-container-present"]);
  });

  it("localRegistry/dockerSandboxContainer 'absent' emits no probe today", () => {
    // Negative-direction probes haven't landed yet. Pin the gap so a
    // future negative-scenario PR is forced to add the absent probes.
    const state: ExpectedState = {
      id: "synthetic-host-absent",
      localRegistry: { expected: "absent" },
      dockerSandboxContainer: { expected: "absent" },
    };
    expect(probesForState(state)).toEqual([]);
  });
});

describe("compiler emits state-validation phase actions from expected-state registry", () => {
  it("positive scenario gets cli-installed + gateway-healthy + sandbox-running probe actions", () => {
    const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
    const stateValidationPhase = plan.phases.find((p) => p.name === "state-validation");
    expect(stateValidationPhase).toBeTruthy();
    expect(stateValidationPhase!.actions.map((a) => a.id)).toEqual([
      "state-validation.cli-installed",
      "state-validation.gateway-healthy",
      "state-validation.sandbox-running",
    ]);
    // Probes are typed shell-fn actions that go through the shared
    // dispatcher; the orchestrator owns timeouts and redaction.
    for (const action of stateValidationPhase!.actions) {
      expect(action.kind).toBe("shell-fn");
      expect(action.fn).toBe("e2e_state_probe");
      expect(action.scriptRef).toBe("test/e2e-scenario/nemoclaw_scenarios/probes/dispatch.sh");
      expect(action.timeoutSeconds).toBe(30);
    }
  });

  it("negative scenario gets cli-installed + gateway-absent + sandbox-absent probe actions", () => {
    const [plan] = compileRunPlans(["ubuntu-no-docker-preflight-negative"]);
    const stateValidationPhase = plan.phases.find((p) => p.name === "state-validation");
    expect(stateValidationPhase).toBeTruthy();
    expect(stateValidationPhase!.actions.map((a) => a.id)).toEqual([
      "state-validation.cli-installed",
      "state-validation.gateway-absent",
      "state-validation.sandbox-absent",
    ]);
  });

  it("compiler fails hard on a scenario referencing an unknown expected-state ID", () => {
    expect(() =>
      compileRunPlans([
        {
          id: "synthetic-unknown-state",
          assertionGroups: [],
          expectedStateId: "definitely-not-a-state",
        },
      ]),
    ).toThrow(/unknown expected_state/);
  });

  it("phase order is environment -> onboarding -> state-validation -> lifecycle -> runtime", () => {
    const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
    // 'lifecycle' is the post-onboard state-mutation phase. Scenarios
    // without a `environment.lifecycle` profile (e.g. this one) emit
    // an empty action list for the phase but the phase still appears
    // in the plan so phase-order invariants stay deterministic.
    expect(plan.phases.map((p) => p.name)).toEqual([
      "environment",
      "onboarding",
      "state-validation",
      "lifecycle",
      "runtime",
    ]);
  });
});

describe("ScenarioRunner short-circuit semantics around state-validation", () => {
  it("onboarding action failure does NOT block state-validation (negative scenarios verify absent state)", async () => {
    const ctx = freshCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-no-docker-preflight-negative"]);
      const phase = (
        name: PhaseName,
        outcome: PhaseResult,
      ): { run: (ctx: RunContext, p: RunPlanPhase) => Promise<PhaseResult> } => ({
        run: async () => outcome,
      });

      let stateValidationCalled = false;
      let runtimeCalled = false;
      const runner = new ScenarioRunner({
        environment: phase("environment", {
          phase: "environment",
          status: "passed",
          actions: [],
          assertions: [],
        }),
        onboarding: phase("onboarding", {
          phase: "onboarding",
          status: "failed",
          actions: [
            {
              id: "onboarding.profile.cloud-openclaw-no-docker",
              status: "failed",
              durationMs: 1,
              message: "preflight detected docker-missing",
            },
          ],
          assertions: [],
        }),
        stateValidation: {
          run: async () => {
            stateValidationCalled = true;
            return {
              phase: "state-validation",
              status: "passed",
              actions: [],
              assertions: [],
            };
          },
        },
        runtime: {
          run: async () => {
            runtimeCalled = true;
            return { phase: "runtime", status: "passed", actions: [], assertions: [] };
          },
        },
      });

      const results = await runner.run(ctx, plan);
      expect(stateValidationCalled).toBe(true);
      expect(runtimeCalled).toBe(false);
      // state-validation has its real result; runtime is skipped with
      // the blocking-action message.
      const stateRes = results.find((r) => r.phase === "state-validation")!;
      expect(stateRes.status).toBe("passed");
      const runtimeRes = results.find((r) => r.phase === "runtime")!;
      expect(runtimeRes.status).toBe("skipped");
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("environment action failure blocks state-validation AND runtime", async () => {
    const ctx = freshCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
      let stateValidationCalled = false;
      let runtimeCalled = false;
      const runner = new ScenarioRunner({
        environment: {
          run: async () => ({
            phase: "environment",
            status: "failed",
            actions: [
              {
                id: "environment.install.repo-current",
                status: "failed",
                durationMs: 1,
                message: "install dispatcher exit 1",
              },
            ],
            assertions: [],
          }),
        },
        onboarding: {
          run: async () => ({ phase: "onboarding", status: "passed", actions: [], assertions: [] }),
        },
        stateValidation: {
          run: async () => {
            stateValidationCalled = true;
            return {
              phase: "state-validation",
              status: "passed",
              actions: [],
              assertions: [],
            };
          },
        },
        runtime: {
          run: async () => {
            runtimeCalled = true;
            return { phase: "runtime", status: "passed", actions: [], assertions: [] };
          },
        },
      });
      await runner.run(ctx, plan);
      expect(stateValidationCalled).toBe(false);
      expect(runtimeCalled).toBe(false);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("state-validation action failure blocks runtime", async () => {
    const ctx = freshCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
      let runtimeCalled = false;
      const runner = new ScenarioRunner({
        environment: {
          run: async () => ({
            phase: "environment",
            status: "passed",
            actions: [],
            assertions: [],
          }),
        },
        onboarding: {
          run: async () => ({ phase: "onboarding", status: "passed", actions: [], assertions: [] }),
        },
        stateValidation: {
          run: async () => ({
            phase: "state-validation",
            status: "failed",
            actions: [
              {
                id: "state-validation.gateway-healthy",
                status: "failed",
                durationMs: 1,
                message: "gateway unreachable at http://127.0.0.1:18789",
              },
            ],
            assertions: [],
          }),
        },
        runtime: {
          run: async () => {
            runtimeCalled = true;
            return { phase: "runtime", status: "passed", actions: [], assertions: [] };
          },
        },
      });
      const results = await runner.run(ctx, plan);
      expect(runtimeCalled).toBe(false);
      const runtimeRes = results.find((r) => r.phase === "runtime")!;
      expect(runtimeRes.status).toBe("skipped");
      expect(runtimeRes.assertions[0].message).toMatch(/state-validation\.gateway-healthy/);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });
});

describe("expected-state registry covers every scenario referenced in the typed registry", () => {
  it("every ScenarioDefinition.expectedStateId resolves in the typed expected-state registry", () => {
    const referenced = new Set<string>();
    for (const scenario of listScenarios()) {
      if (scenario.expectedStateId) {
        referenced.add(scenario.expectedStateId);
      }
    }
    expect(referenced.size).toBeGreaterThan(0);
    for (const id of referenced) {
      expect(
        getExpectedState(id),
        `expected_state '${id}' must be in the typed registry`,
      ).toBeDefined();
    }
  });
});
