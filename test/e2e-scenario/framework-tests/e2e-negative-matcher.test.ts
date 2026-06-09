// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { compileRunPlans } from "../scenarios/compiler.ts";
import {
  evaluateNegativeContract,
  negativeContractPhaseResult,
} from "../scenarios/orchestrators/negative-matcher.ts";
import { ScenarioRunner } from "../scenarios/orchestrators/runner.ts";
import { listScenarios } from "../scenarios/registry.ts";
import { planFailed } from "../scenarios/run.ts";
import type {
  ExpectedFailureContract,
  PhaseName,
  PhaseResult,
  RunContext,
  RunPlan,
  RunPlanPhase,
} from "../scenarios/types.ts";

function freshCtx(): RunContext {
  return { contextDir: fs.mkdtempSync(path.join(os.tmpdir(), "e2e-neg-")) };
}

function planWithExpectedFailure(contract: ExpectedFailureContract): RunPlan {
  return {
    scenarioId: "synthetic-negative",
    status: "compiled",
    suiteIds: [],
    onboardingAssertionIds: [],
    phases: [
      { name: "environment", actions: [], assertionGroups: [] },
      { name: "onboarding", actions: [], assertionGroups: [] },
      { name: "runtime", actions: [], assertionGroups: [] },
    ],
    runnerRequirements: [],
    requiredSecrets: [],
    skippedCapabilities: [],
    expectedFailure: contract,
    sutBoundaries: [{ id: "host-cli", client: "HostCliClient" }],
  };
}

function phaseResult(
  phase: PhaseName,
  opts: {
    status?: PhaseResult["status"];
    failedActionId?: string;
    failedActionMessage?: string;
    failedAssertionId?: string;
    failedAssertionMessage?: string;
  } = {},
): PhaseResult {
  return {
    phase,
    status: opts.status ?? "passed",
    actions: opts.failedActionId
      ? [{ id: opts.failedActionId, status: "failed", durationMs: 1, message: opts.failedActionMessage }]
      : [],
    assertions: opts.failedAssertionId
      ? [
          {
            id: opts.failedAssertionId,
            status: "failed",
            attempts: 1,
            durationMs: 1,
            message: opts.failedAssertionMessage,
          },
        ]
      : [],
  };
}

function passedNegativeContractPhase(): PhaseResult {
  return {
    phase: "negative-contract",
    status: "passed",
    actions: [],
    assertions: [
      {
        id: "negative-contract.match",
        status: "passed",
        attempts: 1,
        durationMs: 0,
        message: "matched",
      },
    ],
  };
}

function stateValidationResult(
  status: PhaseResult["status"],
  actionIds: string[] = ["state-validation.gateway-absent", "state-validation.sandbox-absent"],
): PhaseResult {
  return {
    phase: "state-validation",
    status,
    actions: actionIds.map((id) => ({ id, status: "passed", durationMs: 1 })),
    assertions: [],
  };
}

describe("evaluateNegativeContract - phase + errorClass matching", () => {
  it("matches when expected phase fails with the declared errorClass", () => {
    const plan = planWithExpectedFailure({
      phase: "onboarding",
      errorClass: "invalid-nvidia-api-key",
      forbiddenSideEffects: ["gateway-started"],
    });
    const results: PhaseResult[] = [
      phaseResult("environment", { status: "passed" }),
      phaseResult("onboarding", {
        status: "failed",
        failedActionId: "onboarding.profile.cloud-openclaw-invalid-nvidia-key",
        failedActionMessage: "phase action onboarding exit 1: invalid-nvidia-api-key auth failed",
      }),
    ];
    const result = evaluateNegativeContract(plan, results);
    expect(result.matched).toBe(true);
    expect(result.outcome).toBe("matched");
    expect(result.observed.failedPhase).toBe("onboarding");
  });

  it("resolves preflight expected phase to onboarding orchestrator", () => {
    const plan = planWithExpectedFailure({
      phase: "preflight",
      errorClass: "docker-missing",
    });
    const results: PhaseResult[] = [
      phaseResult("environment", { status: "passed" }),
      phaseResult("onboarding", {
        status: "failed",
        failedActionId: "onboarding.profile.cloud-openclaw",
        failedActionMessage: "preflight detected docker-missing on the runner host",
      }),
    ];
    const result = evaluateNegativeContract(plan, results);
    expect(result.matched).toBe(true);
    expect(result.outcome).toBe("matched");
  });

  it("fails when no failure was observed at all", () => {
    const plan = planWithExpectedFailure({ phase: "onboarding", errorClass: "docker-missing" });
    const results: PhaseResult[] = [
      phaseResult("environment", { status: "passed" }),
      phaseResult("onboarding", { status: "passed" }),
      phaseResult("runtime", { status: "passed" }),
    ];
    const result = evaluateNegativeContract(plan, results);
    expect(result.matched).toBe(false);
    expect(result.outcome).toBe("no-failure-observed");
    expect(result.message).toMatch(/all phases passed/);
  });

  it("matches when a passed expected-failure assertion handled the failure", () => {
    const plan = planWithExpectedFailure({
      phase: "preflight",
      errorClass: "docker-missing",
      forbiddenSideEffects: ["gateway-started", "sandbox-created"],
    });
    const results: PhaseResult[] = [
      phaseResult("environment", { status: "passed" }),
      {
        phase: "onboarding",
        status: "passed",
        actions: [
          {
            id: "onboarding.profile.cloud-openclaw-no-docker",
            status: "passed",
            durationMs: 1,
          },
        ],
        assertions: [
          {
            id: "onboarding.preflight.expected-failed",
            status: "passed",
            attempts: 1,
            durationMs: 1,
          },
        ],
      },
      phaseResult("state-validation", { status: "passed" }),
    ];

    const result = evaluateNegativeContract(plan, results);
    expect(result.matched).toBe(true);
    expect(result.outcome).toBe("matched");
    expect(result.observed).toMatchObject({
      failedPhase: "onboarding",
      handledAssertionId: "onboarding.preflight.expected-failed",
    });
  });

  it("matches handled expected-failure actions using scenario error-class aliases", () => {
    const plan = planWithExpectedFailure({
      phase: "onboarding",
      errorClass: "invalid-nvidia-api-key",
    });
    const results: PhaseResult[] = [
      {
        phase: "onboarding",
        status: "passed",
        actions: [
          {
            id: "onboarding.profile.cloud-openclaw-invalid-nvidia-key",
            status: "passed",
            durationMs: 1,
          },
        ],
        assertions: [],
      },
    ];

    const result = evaluateNegativeContract(plan, results);
    expect(result.matched).toBe(true);
    expect(result.observed.handledActionId).toBe("onboarding.profile.cloud-openclaw-invalid-nvidia-key");
  });

  it("fails when the wrong phase failed", () => {
    const plan = planWithExpectedFailure({ phase: "onboarding", errorClass: "docker-missing" });
    const results: PhaseResult[] = [
      phaseResult("environment", {
        status: "failed",
        failedActionId: "environment.install.ubuntu-repo-no-docker",
        failedActionMessage: "install dispatcher exit 1: docker-missing",
      }),
    ];
    const result = evaluateNegativeContract(plan, results);
    expect(result.matched).toBe(false);
    expect(result.outcome).toBe("wrong-phase");
    expect(result.message).toMatch(/expected onboarding failure/);
    expect(result.observed.failedPhase).toBe("environment");
  });

  it("fails when the right phase failed for the wrong errorClass", () => {
    const plan = planWithExpectedFailure({
      phase: "onboarding",
      errorClass: "gateway-port-conflict",
    });
    const results: PhaseResult[] = [
      phaseResult("onboarding", {
        status: "failed",
        failedActionId: "onboarding.profile.cloud-openclaw-gateway-port-conflict",
        failedActionMessage: "onboard exit 1: invalid-nvidia-api-key authentication failed",
      }),
    ];
    const result = evaluateNegativeContract(plan, results);
    expect(result.matched).toBe(false);
    expect(result.outcome).toBe("wrong-error-class");
    expect(result.message).toMatch(/errorClass mismatch/);
  });

  it("ignores the runtime side-effect probe step when scanning for observed failure", () => {
    const plan = planWithExpectedFailure({ phase: "onboarding", errorClass: "docker-missing" });
    const results: PhaseResult[] = [
      phaseResult("environment", { status: "passed" }),
      phaseResult("onboarding", {
        status: "failed",
        failedActionId: "onboarding.profile.cloud-openclaw",
        failedActionMessage: "onboard exit 1: docker-missing daemon unreachable",
      }),
      // runtime phase has only the required pending side-effect step
      // that fails closed until the probe lands. The matcher must NOT
      // treat that as the observed failure mode.
      {
        phase: "runtime",
        status: "failed",
        actions: [],
        assertions: [
          {
            id: "runtime.expected-failure.no-side-effects",
            status: "failed",
            attempts: 1,
            durationMs: 0,
            message: "required pending step not implemented: expectedFailureNoSideEffectsProbe",
          },
        ],
      },
    ];
    const result = evaluateNegativeContract(plan, results);
    expect(result.matched).toBe(true);
    expect(result.observed.failedActionId).toBe("onboarding.profile.cloud-openclaw");
  });

  it("matches errorClass case-insensitively and across separator variants", () => {
    const plan = planWithExpectedFailure({ phase: "onboarding", errorClass: "docker-missing" });
    const results: PhaseResult[] = [
      phaseResult("onboarding", {
        status: "failed",
        failedActionId: "onboarding",
        failedActionMessage: "Onboard exit 1: Docker_Missing daemon socket unreachable",
      }),
    ];
    expect(evaluateNegativeContract(plan, results).matched).toBe(true);
  });

  it("throws if invoked for a plan without expectedFailure", () => {
    const plan: RunPlan = { ...planWithExpectedFailure({ phase: "onboarding", errorClass: "x" }), expectedFailure: undefined };
    expect(() => evaluateNegativeContract(plan, [])).toThrow(/no expectedFailure declared/);
  });

  it("synthetic phase result reflects matched status", () => {
    const plan = planWithExpectedFailure({ phase: "onboarding", errorClass: "docker-missing" });
    const results: PhaseResult[] = [
      phaseResult("onboarding", {
        status: "failed",
        failedActionId: "onboarding",
        failedActionMessage: "docker-missing",
      }),
    ];
    const synthetic = negativeContractPhaseResult(evaluateNegativeContract(plan, results));
    expect(synthetic.phase).toBe("negative-contract");
    expect(synthetic.status).toBe("passed");
    expect(synthetic.assertions[0]).toEqual(
      expect.objectContaining({ id: "negative-contract.match", status: "passed" }),
    );
  });
});

describe("negative plan exit-code contract", () => {
  const plan = planWithExpectedFailure({
    phase: "preflight",
    errorClass: "docker-missing",
    forbiddenSideEffects: ["gateway-started", "sandbox-created"],
  });

  it("passes when negative contract and forbidden-side-effect probes pass", () => {
    expect(planFailed(plan, [passedNegativeContractPhase(), stateValidationResult("passed")])).toBe(false);
  });

  it("fails when state-validation is missing", () => {
    expect(planFailed(plan, [passedNegativeContractPhase()])).toBe(true);
  });

  it("fails when state-validation is skipped", () => {
    expect(planFailed(plan, [passedNegativeContractPhase(), stateValidationResult("skipped")])).toBe(true);
  });

  it("fails when a declared forbidden-side-effect probe did not run", () => {
    expect(
      planFailed(plan, [
        passedNegativeContractPhase(),
        stateValidationResult("passed", ["state-validation.gateway-absent"]),
      ]),
    ).toBe(true);
  });
});

describe("ScenarioRunner appends negative-contract phase", () => {
  it("invokes matcher and appends a passing synthetic phase when contract matched", async () => {
    const ctx = freshCtx();
    try {
      const fakePhase = (
        phase: PhaseName,
        outcome: PhaseResult,
      ) => ({
        run: async (
          _ctx: RunContext,
          _runPhase: RunPlanPhase,
          _prior?: PhaseResult[],
        ): Promise<PhaseResult> => outcome,
      });

      const runner = new ScenarioRunner({
        environment: fakePhase("environment", { phase: "environment", status: "passed", actions: [], assertions: [] }),
        onboarding: fakePhase("onboarding", {
          phase: "onboarding",
          status: "failed",
          actions: [
            {
              id: "onboarding.profile.cloud-openclaw",
              status: "failed",
              durationMs: 1,
              message: "onboard exit 1: docker-missing daemon unreachable",
            },
          ],
          assertions: [],
        }),
        runtime: fakePhase("runtime", { phase: "runtime", status: "passed", actions: [], assertions: [] }),
      });

      const plan = planWithExpectedFailure({ phase: "preflight", errorClass: "docker-missing" });
      const results = await runner.run(ctx, plan);

      const contractPhase = results[results.length - 1];
      expect(contractPhase.phase).toBe("negative-contract");
      expect(contractPhase.status).toBe("passed");

      // Artifact emitted to ctx.contextDir/.e2e/negative-contract.json
      const artifact = path.join(ctx.contextDir, ".e2e", "negative-contract.json");
      expect(fs.existsSync(artifact)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(artifact, "utf8"));
      expect(parsed.matched).toBe(true);
      expect(parsed.outcome).toBe("matched");
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("emits a failed synthetic phase when the wrong phase failed", async () => {
    const ctx = freshCtx();
    try {
      const fakePhase = (outcome: PhaseResult) => ({
        run: async (): Promise<PhaseResult> => outcome,
      });

      const runner = new ScenarioRunner({
        environment: fakePhase({
          phase: "environment",
          status: "failed",
          actions: [
            {
              id: "environment.install.ubuntu-repo-no-docker",
              status: "failed",
              durationMs: 1,
              message: "install dispatcher exit 1: dns-resolution-error",
            },
          ],
          assertions: [],
        }),
        onboarding: fakePhase({ phase: "onboarding", status: "skipped", actions: [], assertions: [] }),
        runtime: fakePhase({ phase: "runtime", status: "skipped", actions: [], assertions: [] }),
      });

      const plan = planWithExpectedFailure({ phase: "onboarding", errorClass: "docker-missing" });
      const results = await runner.run(ctx, plan);

      const contractPhase = results[results.length - 1];
      expect(contractPhase.phase).toBe("negative-contract");
      expect(contractPhase.status).toBe("failed");
      expect(contractPhase.assertions[0].message).toMatch(/expected onboarding failure/);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("does NOT append negative-contract phase for positive scenarios", async () => {
    const ctx = freshCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
      expect(plan.expectedFailure).toBeUndefined();

      const fakePhase = (phase: PhaseName) => ({
        run: async (): Promise<PhaseResult> => ({
          phase,
          status: "passed",
          actions: [],
          assertions: [],
        }),
      });
      const runner = new ScenarioRunner({
        environment: fakePhase("environment"),
        onboarding: fakePhase("onboarding"),
        stateValidation: fakePhase("state-validation"),
        lifecycle: fakePhase("lifecycle"),
        runtime: fakePhase("runtime"),
      });

      const results = await runner.run(ctx, plan);
      expect(results.map((r) => r.phase)).toEqual([
        "environment",
        "onboarding",
        "state-validation",
        "lifecycle",
        "runtime",
      ]);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });
});

describe("registry contract: negative scenarios use typed state-validation side-effect probes", () => {
  it("scenario.expectedFailure does not inject the legacy runtime no-side-effects pending step", () => {
    const negatives = listScenarios().filter((scenario) => scenario.expectedFailure);
    expect(negatives.length).toBeGreaterThan(0);
    for (const scenario of negatives) {
      const hasLegacyPendingStep = scenario.assertionGroups.some((group) =>
        group.steps.some((step) => step.id === "runtime.expected-failure.no-side-effects"),
      );
      expect(hasLegacyPendingStep, `scenario ${scenario.id} must rely on state-validation, not the legacy pending step`).toBe(false);
    }
  });
});

describe("compiler validates the typed expected-failure contract", () => {
  it("rejects an invalid phase value", () => {
    expect(() =>
      compileRunPlans([
        {
          id: "synthetic-bad-phase",
          assertionGroups: [],
          // Force the bad shape the compiler must reject.
          expectedFailure: { phase: "bogus" as never, errorClass: "x" },
        },
      ]),
    ).toThrow(/expectedFailure\.phase invalid/);
  });

  it("rejects an empty errorClass", () => {
    expect(() =>
      compileRunPlans([
        {
          id: "synthetic-empty-class",
          assertionGroups: [],
          expectedFailure: { phase: "onboarding", errorClass: "" },
        },
      ]),
    ).toThrow(/errorClass must be a non-empty string/);
  });
});
