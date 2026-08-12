// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CuaRuntimeReadiness } from "../../cua/contract";
import type { CuaStateObservationDeps } from "../../cua/state";
import type { SandboxEntry } from "../../state/registry";
import { collectCuaRuntimeDoctorChecks } from "./doctor";
import { getSandboxStatusReport } from "./status";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function candidateReadiness(): CuaRuntimeReadiness {
  const component = (name: string, character: string) => ({
    name,
    version: "1.0.0",
    digest: digest(character),
    owner: "NVIDIA",
  });
  return {
    schemaVersion: "1.0.0",
    kind: "runtime-readiness",
    agent: "nemocua",
    mode: "standalone",
    status: "candidate",
    sourceRevision: "a".repeat(40),
    sourceClean: true,
    runtimeManifestDigest: digest("b"),
    providerAuthorityDigest: digest("c"),
    qualification: {
      state: "candidate",
      environmentDigest: digest("d"),
      bundleReceiptDigest: digest("e"),
    },
    components: {
      openshell: component("openshell", "1"),
      runtime: component("nemocua-runtime", "2"),
      sandboxImage: component("nemocua-sandbox", "3"),
      targetAdapter: component("target-adapter", "4"),
      policy: component("nemocua-policy", "5"),
      taskProtocol: component("task-protocol", "6"),
      securityVerifier: component("security-verifier", "7"),
    },
    inference: {
      provider: "nvidia",
      model: "nvidia/model",
      routeDigest: digest("8"),
    },
    appliedPolicy: { revision: 2, digest: digest("9") },
    commands: { interactive: true, headless: true, version: true, smoke: true },
    limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
    requiredCapabilities: ["browser", "computer", "terminal"],
    targetOperations: [],
    securityOperations: [],
    taskOperations: [],
  };
}

function candidateEntry(readiness: CuaRuntimeReadiness): SandboxEntry {
  return {
    name: "alpha",
    agent: "nemocua",
    provider: readiness.inference.provider,
    model: readiness.inference.model,
    cuaRuntimeReadiness: readiness,
  };
}

function observationDeps(
  readiness: CuaRuntimeReadiness,
  liveProvider = readiness.inference.provider,
): CuaStateObservationDeps {
  return {
    observeLiveInference: () => ({
      provider: liveProvider,
      model: readiness.inference.model,
      providerAuthorityDigest: readiness.providerAuthorityDigest,
    }),
    observeLiveAppliedPolicy: () => readiness.appliedPolicy,
    validation: {
      validateRuntimeReadiness: (_value, context) => {
        assert.deepEqual(
          {
            provider: context.liveInference?.provider,
            model: context.liveInference?.model,
            providerAuthorityDigest: context.liveProviderAuthorityDigest,
            appliedPolicy: context.liveAppliedPolicy,
          },
          {
            provider: readiness.inference.provider,
            model: readiness.inference.model,
            providerAuthorityDigest: readiness.providerAuthorityDigest,
            appliedPolicy: readiness.appliedPolicy,
          },
          "candidate authority changed",
        );
        return readiness;
      },
    },
  };
}

function statusDeps(entry: SandboxEntry, observation: CuaStateObservationDeps) {
  return {
    getSandbox: () => entry,
    listSandboxes: () => ({ sandboxes: [entry], defaultSandbox: "alpha" }),
    reconcile: async () => ({ state: "present" as const, output: "Name: alpha\nPhase: Ready\n" }),
    captureOpenshellForStatusImpl: async () => ({
      status: 0,
      output: `Gateway inference:\n  Provider: ${entry.provider}\n  Model: ${entry.model}\n`,
    }),
    probeProviderHealthImpl: vi.fn(() => null),
    probeSandboxInferenceGatewayHealthImpl: vi.fn(async () => null),
    probeTerminalRuntimeHealth: vi.fn(() => ({ kind: "ok" as const, oomKillCount: 0 as const })),
    observeCuaLiveInference: observation.observeLiveInference,
    observeCuaLiveAppliedPolicy: observation.observeLiveAppliedPolicy,
    validateCuaRuntimeReadiness: observation.validation?.validateRuntimeReadiness,
  };
}

describe("private CUA candidate status and doctor projection (#7755)", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_CUA_ENABLED", "1");
    vi.stubEnv("NEMOCLAW_CUA_QUALIFICATION", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("projects matching candidate readiness and fails closed after route authority changes", async () => {
    const readiness = candidateReadiness();
    const entry = candidateEntry(readiness);
    const matching = observationDeps(readiness);
    const stale = observationDeps(readiness, "changed-provider");

    await expect(
      getSandboxStatusReport("alpha", statusDeps(entry, matching)),
    ).resolves.toMatchObject({
      cuaRuntime: readiness,
    });
    await expect(getSandboxStatusReport("alpha", statusDeps(entry, stale))).resolves.toMatchObject({
      cuaRuntime: null,
    });
  });

  it("reports matching candidate readiness and fails stale authority in doctor", () => {
    const readiness = candidateReadiness();
    const entry = candidateEntry(readiness);

    expect(collectCuaRuntimeDoctorChecks(entry, observationDeps(readiness))).toEqual([
      expect.objectContaining({ label: "CUA runtime", status: "ok" }),
    ]);
    expect(
      collectCuaRuntimeDoctorChecks(entry, observationDeps(readiness, "changed-provider")),
    ).toEqual([expect.objectContaining({ label: "CUA runtime", status: "fail" })]);
  });
});
