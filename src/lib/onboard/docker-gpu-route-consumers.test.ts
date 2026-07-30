// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  enforceDockerGpuPatchPreserveNetwork,
  shouldSkipGpuBridgeProbe,
  shouldUseDockerGpuPatchHostNetwork,
  verifyDockerGpuSandboxLocalInference,
  verifyGpuSandboxAfterReady,
} from "./docker-gpu-local-inference";
import { resolveDockerGpuRoutePlan } from "./docker-gpu-route";
import { prepareSandboxGpuRoutePolicies } from "./sandbox-gpu-route-policy";

const GPU_CONFIG = { sandboxGpuEnabled: true };
const HOST_NETWORK_ENV = {
  NEMOCLAW_DOCKER_GPU_PATCH: "1",
  NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host",
} as NodeJS.ProcessEnv;

describe("route-specific policy materialization", () => {
  it("keeps the native attempt narrow and prepares one broad fallback policy", () => {
    const nativeCleanup = vi.fn(() => true);
    const compatibilityCleanup = vi.fn(() => true);
    const preparePolicy = vi.fn((_base, _channels, options) => ({
      policyPath: options?.dockerGpuPatch ? "/tmp/compatibility.yaml" : "/tmp/native.yaml",
      appliedPresets: ["github"],
      cleanup: options?.dockerGpuPatch ? compatibilityCleanup : nativeCleanup,
    }));
    const explicitFallbackPlan = resolveDockerGpuRoutePlan(GPU_CONFIG, {
      dockerDriverGateway: true,
      env: { NEMOCLAW_DOCKER_GPU_PATCH: "fallback" },
      platform: "linux",
    });
    const policies = prepareSandboxGpuRoutePolicies(
      "/repo/policy.yaml",
      ["telegram"],
      { directGpu: true, additionalPresets: ["github"] },
      explicitFallbackPlan,
      preparePolicy,
    );

    expect(preparePolicy).toHaveBeenNthCalledWith(
      1,
      "/repo/policy.yaml",
      ["telegram"],
      expect.objectContaining({ directGpu: true, dockerGpuPatch: false }),
    );
    expect(preparePolicy).toHaveBeenNthCalledWith(
      2,
      "/repo/policy.yaml",
      ["telegram"],
      expect.objectContaining({ directGpu: true, dockerGpuPatch: true }),
    );
    expect(policies.initialSandboxPolicy.policyPath).toBe("/tmp/native.yaml");
    expect(policies.compatibilityPolicyPath).toBe("/tmp/compatibility.yaml");
    expect(policies.initialSandboxPolicy.cleanup?.()).toBe(true);
    expect(nativeCleanup).toHaveBeenCalledOnce();
    expect(compatibilityCleanup).toHaveBeenCalledOnce();
  });

  it("does not materialize a broader compatibility policy for ordinary Linux defaults (#6110)", () => {
    const preparePolicy = vi.fn((_base, _channels, options) => ({
      policyPath: options?.dockerGpuPatch ? "/tmp/compatibility.yaml" : "/tmp/native.yaml",
      appliedPresets: [],
    }));
    const defaultPlan = resolveDockerGpuRoutePlan(GPU_CONFIG, {
      dockerDriverGateway: true,
      env: { NEMOCLAW_DOCKER_GPU_PATCH: "auto" },
      platform: "linux",
    });

    const policies = prepareSandboxGpuRoutePolicies(
      "/repo/policy.yaml",
      [],
      { directGpu: true },
      defaultPlan,
      preparePolicy,
    );

    expect(defaultPlan).toBe("native-only");
    expect(preparePolicy).toHaveBeenCalledOnce();
    expect(preparePolicy).toHaveBeenCalledWith(
      "/repo/policy.yaml",
      [],
      expect.objectContaining({ dockerGpuPatch: false }),
    );
    expect(policies.compatibilityPolicyPath).toBeNull();
  });

  it("cleans the initial temporary policy when fallback policy materialization fails", () => {
    const nativeCleanup = vi.fn(() => true);
    const preparePolicy = vi
      .fn()
      .mockReturnValueOnce({
        policyPath: "/tmp/native.yaml",
        appliedPresets: [],
        cleanup: nativeCleanup,
      })
      .mockImplementationOnce(() => {
        throw new Error("compatibility policy failed");
      });

    expect(() =>
      prepareSandboxGpuRoutePolicies(
        "/repo/policy.yaml",
        [],
        { directGpu: true },
        "native-with-fallback",
        preparePolicy,
      ),
    ).toThrow("compatibility policy failed");
    expect(nativeCleanup).toHaveBeenCalledOnce();
  });
});

describe("selected route consumers", () => {
  it("keeps native selection out of compatibility networking", async () => {
    const env = { ...HOST_NETWORK_ENV };
    const reverifyBridgeReachability = vi.fn();
    const options = {
      dockerDriverGateway: true,
      selectedRoute: "native" as const,
      platform: "linux" as NodeJS.Platform,
      env,
    };
    expect(shouldUseDockerGpuPatchHostNetwork(GPU_CONFIG, options)).toBe(false);
    expect(shouldSkipGpuBridgeProbe(true, "linux", "native", options)).toBe(false);
    expect(
      await enforceDockerGpuPatchPreserveNetwork("ollama-local", GPU_CONFIG, {
        ...options,
        reverifyBridgeReachability,
      }),
    ).toBe(false);
    expect(env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK).toBe("host");
    expect(reverifyBridgeReachability).not.toHaveBeenCalled();
  });

  it("skips compatibility-only inference gates after native wins", () => {
    const execInSandbox = vi.fn();
    expect(
      verifyDockerGpuSandboxLocalInference(GPU_CONFIG, "ollama-local", {
        sandboxName: "alpha",
        dockerDriverGateway: true,
        selectedRoute: "native",
        env: HOST_NETWORK_ENV,
      }),
    ).toEqual({ status: "skipped", reason: "not-docker-gpu-patch" });

    const verifyDirectSandboxGpu = vi.fn();
    verifyGpuSandboxAfterReady(GPU_CONFIG, "ollama-local", {
      sandboxName: "alpha",
      dockerDriverGateway: true,
      selectedRoute: "native",
      verifyDirectSandboxGpu,
      selectedMode: () => null,
      runCaptureOpenshell: vi.fn(() => ""),
      deps: { execInSandbox, sleep: vi.fn() },
    });
    expect(verifyDirectSandboxGpu).toHaveBeenCalledWith("alpha");
    expect(execInSandbox).not.toHaveBeenCalled();
  });

  it("defers native proof diagnostics while automatic fallback owns recovery", () => {
    const proofError = new Error("native CUDA proof failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        verifyGpuSandboxAfterReady(GPU_CONFIG, "ollama-local", {
          sandboxName: "alpha",
          dockerDriverGateway: true,
          selectedRoute: "native",
          verifyDirectSandboxGpu: vi.fn(() => {
            throw proofError;
          }),
          reportGpuProofFailure: false,
          selectedMode: () => null,
          runCaptureOpenshell: vi.fn(() => ""),
        }),
      ).toThrow(proofError);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
