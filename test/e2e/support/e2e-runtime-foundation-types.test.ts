// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, expectTypeOf, it } from "vitest";

import { test as e2eFixtureTest } from "../fixtures/e2e-test.ts";
import {
  EnvironmentPhaseFixture,
  LifecyclePhaseFixture,
  StateValidationPhaseFixture,
} from "../fixtures/phases/index.ts";
import type {
  RuntimeLifecycleEvidence,
  RuntimeProviderLifecycle,
} from "../fixtures/runtime-provider.ts";
import { defineExecutionProfile, executionProviderId } from "../registry/execution-profile.ts";
import type {
  ExecutionEvidenceInput,
  NonEmptyProviderReceipts,
} from "../registry/parity-evidence.ts";
import { hasRegisteredRuntimeProfile } from "../registry/registry.ts";
import { buildLiveTargetMatrix } from "../registry/run.ts";
import { defineRuntimeScenario, type RuntimeNeutralScenario } from "../registry/scenario.ts";
import { foundationProfiles, foundationScenarios } from "./cross-runtime-foundation-fixtures.ts";

describe("cross-runtime foundation types", () => {
  it("models Docker and socket-free fake MXC profiles without registering either", () => {
    const liveMatrixBefore = buildLiveTargetMatrix();
    const profiles = foundationProfiles();
    const [docker, mxc] = profiles;

    expect(docker).toMatchObject({
      provider: "docker",
      architecture: "amd64",
      rootMode: "rootful",
      acceleration: "cpu",
    });
    expect(docker?.capabilities).toContain("transport.docker-socket");
    expect(mxc).toMatchObject({
      provider: "test-mxc",
      architecture: "arm64",
      rootMode: "rootless",
      acceleration: "cpu",
    });
    expect(mxc?.capabilities).toContain("transport.socket-free");
    expect(mxc?.capabilities).not.toContain("transport.docker-socket");
    expect(buildLiveTargetMatrix()).toEqual(liveMatrixBefore);
    for (const profile of profiles) {
      expect(hasRegisteredRuntimeProfile(profile.id)).toBe(false);
    }
  });

  it("keeps OpenClaw, Hermes, and DCode scenarios provider-neutral and obligation-explicit", () => {
    const scenarios = foundationScenarios();

    expect(scenarios.map((scenario) => scenario.agent)).toEqual(["openclaw", "hermes", "dcode"]);
    for (const scenario of scenarios) {
      expect(scenario).not.toHaveProperty("provider");
      expect(scenario.journey.map((step) => step.action)).toEqual([
        "sandbox.provision",
        "agent.configure",
        "agent.turn",
        "state.observe",
      ]);
      expect(scenario.assertions.terminalOutcome).toEqual({
        status: "succeeded",
        state: "completed",
      });
      expect(scenario.supportObligations.map((obligation) => obligation.id)).toEqual([
        "provision",
        "configure",
        "turn",
        "observe",
      ]);
    }
  });

  it("omits undeclared provider fields from normalized scenarios", () => {
    const base = foundationScenarios()[0]!;
    const input = {
      ...base,
      provider: "docker",
      journey: base.journey.map((step) => ({ ...step, provider: "docker" })),
      assertions: { ...base.assertions, provider: "docker" },
      supportObligations: base.supportObligations.map((obligation) => ({
        ...obligation,
        provider: "docker",
      })),
    } as unknown as RuntimeNeutralScenario;

    const scenario = defineRuntimeScenario(input);

    expect(scenario).not.toHaveProperty("provider");
    expect(scenario.journey[0]).not.toHaveProperty("provider");
    expect(scenario.assertions).not.toHaveProperty("provider");
    expect(scenario.supportObligations[0]).not.toHaveProperty("provider");
  });

  it("requires provider receipt evidence from lifecycle and cleanup contracts", () => {
    expectTypeOf<
      RuntimeLifecycleEvidence["providerReceipts"]
    >().toEqualTypeOf<NonEmptyProviderReceipts>();
    expectTypeOf<
      Awaited<ReturnType<RuntimeProviderLifecycle["cleanup"]>>
    >().toEqualTypeOf<NonEmptyProviderReceipts>();
    expectTypeOf<
      ExecutionEvidenceInput["providerReceipts"]
    >().toEqualTypeOf<NonEmptyProviderReceipts>();
  });

  it("keeps provider ids open while rejecting invalid profiles", () => {
    const valid = foundationProfiles()[0]!;
    expect(
      defineExecutionProfile({
        ...valid,
        id: "future-provider-profile",
        provider: executionProviderId("future-provider"),
      }).provider,
    ).toBe("future-provider");
    expect(() => executionProviderId("../unsafe")).toThrow(/provider id/);
    expect(() =>
      defineExecutionProfile({
        ...valid,
        runner: { ...valid.runner, maxShards: 0 },
      }),
    ).toThrow(/maxShards must be between/);
    expect(() =>
      defineExecutionProfile({
        ...valid,
        capabilities: [...valid.capabilities, valid.capabilities[0]!],
      }),
    ).toThrow(/duplicate capabilities/);
  });

  it("rejects missing and duplicate support obligations", () => {
    const valid = foundationScenarios()[0]!;
    expect(() =>
      defineRuntimeScenario({
        ...valid,
        supportObligations: [],
      }),
    ).toThrow(/must declare support obligations/);
    expect(() =>
      defineRuntimeScenario({
        ...valid,
        supportObligations: [valid.supportObligations[0]!, valid.supportObligations[0]!],
      }),
    ).toThrow(/duplicate obligation/);
  });

  it("rejects scenarios without a user journey or normalized assertions", () => {
    const valid = foundationScenarios()[0]!;
    expect(() => defineRuntimeScenario({ ...valid, journey: [] })).toThrow(
      /must declare a user journey/,
    );
    expect(() =>
      defineRuntimeScenario({
        ...valid,
        assertions: undefined,
      } as unknown as typeof valid),
    ).toThrow(/must declare normalized assertions/);
  });
});

e2eFixtureTest(
  "keeps the existing Docker phase fixtures unchanged",
  async ({ environment, lifecycle, stateValidation }) => {
    expect(environment).toBeInstanceOf(EnvironmentPhaseFixture);
    expect(lifecycle).toBeInstanceOf(LifecyclePhaseFixture);
    expect(stateValidation).toBeInstanceOf(StateValidationPhaseFixture);
  },
);
