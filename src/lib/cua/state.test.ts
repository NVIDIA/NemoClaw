// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { CuaRuntimeReadiness } from "./contract";
import { getObservedValidatedCuaState } from "./state";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function readiness(): CuaRuntimeReadiness {
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
      runtime: component("runtime", "2"),
      sandboxImage: component("sandbox-image", "3"),
      targetAdapter: component("target-adapter", "4"),
      policy: component("policy", "5"),
      taskProtocol: component("task-protocol", "6"),
      securityVerifier: component("security-verifier", "7"),
    },
    inference: { provider: "nvidia", model: "nvidia/model", routeDigest: digest("8") },
    appliedPolicy: { revision: 2, digest: digest("9") },
    commands: { interactive: true, headless: true, version: true, smoke: true },
    limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
    requiredCapabilities: ["browser", "computer", "terminal"],
    targetOperations: [],
    securityOperations: [],
    taskOperations: [],
  };
}

describe("CUA candidate readiness projection", () => {
  it.each([
    ["feature disabled", {}],
    ["qualification disabled", { NEMOCLAW_CUA_ENABLED: "1" }],
  ])("stays opaque with %s", (_label, env) => {
    const observeLiveInference = vi.fn();
    const observeLiveAppliedPolicy = vi.fn();
    const result = getObservedValidatedCuaState(
      { name: "alpha", agent: "nemocua", cuaRuntimeReadiness: readiness() },
      env,
      { observeLiveInference, observeLiveAppliedPolicy },
    );

    expect(result).toEqual({ observation: "not-applicable", readiness: null });
    expect(observeLiveInference).not.toHaveBeenCalled();
    expect(observeLiveAppliedPolicy).not.toHaveBeenCalled();
  });

  it("projects only validated candidate readiness when both exact gates are enabled", () => {
    const value = readiness();
    const validateRuntimeReadiness = vi.fn(() => value);
    const result = getObservedValidatedCuaState(
      { name: "alpha", agent: "nemocua", cuaRuntimeReadiness: value },
      { NEMOCLAW_CUA_ENABLED: "1", NEMOCLAW_CUA_QUALIFICATION: "1" },
      {
        observeLiveInference: () => ({
          provider: "nvidia",
          model: "nvidia/model",
          providerAuthorityDigest: digest("c"),
        }),
        observeLiveAppliedPolicy: () => ({ revision: 2, digest: digest("9") }),
        validation: { validateRuntimeReadiness },
      },
    );

    expect(result).toEqual({ observation: "verified", readiness: value });
    expect(validateRuntimeReadiness).toHaveBeenCalledOnce();
  });
});
