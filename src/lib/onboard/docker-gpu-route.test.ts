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
import {
  canFallbackToDockerGpuCompatibility,
  type DockerGpuRouteOptions,
  initialDockerGpuRoute,
  isDockerGpuCompatibilityRoute,
  renderCompatibilityFallbackCreateArgs,
  renderSandboxCreateArgsForGpuRoute,
  resolveDockerGpuRoutePlan,
  supportsDockerGpuCompatibility,
} from "./docker-gpu-route";
import { shouldApplyDockerGpuPatch } from "./docker-gpu-route-patch-adapter";
import { prepareSandboxGpuRoutePolicies } from "./sandbox-gpu-route-policy";

const GPU_CONFIG = { sandboxGpuEnabled: true };
const LINUX_DOCKER: DockerGpuRouteOptions = {
  dockerDriverGateway: true,
  platform: "linux",
  dockerDesktopWsl: false,
  env: {},
};
const HOST_NETWORK_ENV = {
  NEMOCLAW_DOCKER_GPU_PATCH: "1",
  NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host",
} as NodeJS.ProcessEnv;

describe("resolveDockerGpuRoutePlan", () => {
  it.each([
    ["disabled GPU", { sandboxGpuEnabled: false }, LINUX_DOCKER, "none"],
    [
      "non-Docker driver",
      GPU_CONFIG,
      { ...LINUX_DOCKER, dockerDriverGateway: false },
      "native-only",
    ],
    ["non-Linux host", GPU_CONFIG, { ...LINUX_DOCKER, platform: "darwin" }, "native-only"],
    ["unset control", GPU_CONFIG, LINUX_DOCKER, "native-with-fallback"],
    [
      "auto control",
      GPU_CONFIG,
      { ...LINUX_DOCKER, env: { NEMOCLAW_DOCKER_GPU_PATCH: "auto" } },
      "native-with-fallback",
    ],
    [
      "zero control",
      GPU_CONFIG,
      { ...LINUX_DOCKER, env: { NEMOCLAW_DOCKER_GPU_PATCH: "0" } },
      "native-only",
    ],
    [
      "one control",
      GPU_CONFIG,
      { ...LINUX_DOCKER, env: { NEMOCLAW_DOCKER_GPU_PATCH: "1" } },
      "compatibility-only",
    ],
  ] as const)("maps %s to %s", (_name, config, options, expected) => {
    expect(resolveDockerGpuRoutePlan(config, options)).toBe(expected);
  });

  it("preserves legacy nonzero compatibility routing with a visible warning", () => {
    const log = vi.fn();
    expect(
      resolveDockerGpuRoutePlan(GPU_CONFIG, {
        ...LINUX_DOCKER,
        env: { NEMOCLAW_DOCKER_GPU_PATCH: "true" },
        log,
      }),
    ).toBe("compatibility-only");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/unrecognized.*compatibility-only/i));
  });

  it("keeps Docker Desktop WSL on compatibility and explains why zero is ignored", () => {
    const log = vi.fn();
    expect(
      resolveDockerGpuRoutePlan(GPU_CONFIG, {
        ...LINUX_DOCKER,
        dockerDesktopWsl: true,
        env: { NEMOCLAW_DOCKER_GPU_PATCH: "0" },
        log,
      }),
    ).toBe("compatibility-only");
    expect(log.mock.calls.map(([message]) => message).join("\n")).toMatch(
      /0 ignored on Docker Desktop WSL.*--no-gpu/s,
    );
  });

  it.each([
    [undefined, "compatibility-only"],
    ["auto", "compatibility-only"],
    ["1", "compatibility-only"],
    ["0", "native-only"],
  ] as const)("maps Jetson control %s to %s", (control, expected) => {
    const log = vi.fn();
    const env = control === undefined ? {} : { NEMOCLAW_DOCKER_GPU_PATCH: control };
    expect(
      resolveDockerGpuRoutePlan(
        { sandboxGpuEnabled: true, hostGpuPlatform: "jetson" },
        { ...LINUX_DOCKER, env, log },
      ),
    ).toBe(expected);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("Docker GPU route helpers", () => {
  it.each([
    [GPU_CONFIG, {}, false],
    [GPU_CONFIG, { NEMOCLAW_DOCKER_GPU_PATCH: "auto" }, false],
    [GPU_CONFIG, { NEMOCLAW_DOCKER_GPU_PATCH: "0" }, false],
    [GPU_CONFIG, { NEMOCLAW_DOCKER_GPU_PATCH: "1" }, true],
    [{ sandboxGpuEnabled: false }, {}, false],
    [{ sandboxGpuEnabled: true, hostGpuPlatform: "jetson" }, {}, true],
    [
      { sandboxGpuEnabled: true, hostGpuPlatform: "jetson" },
      { NEMOCLAW_DOCKER_GPU_PATCH: "0" },
      false,
    ],
  ] as const)("adapts plan %j and control %j to patch enabled=%s", (config, env, expected) => {
    expect(
      shouldApplyDockerGpuPatch(config, {
        env,
        platform: "linux",
        dockerDriverGateway: true,
      }),
    ).toBe(expected);
  });

  it.each([
    ["none", "none", false, false],
    ["native-only", "native", false, false],
    ["compatibility-only", "compatibility", true, false],
    ["native-with-fallback", "native", true, true],
  ] as const)("describes %s", (plan, initialRoute, compatibilitySupported, fallbackSupported) => {
    expect(initialDockerGpuRoute(plan)).toBe(initialRoute);
    expect(supportsDockerGpuCompatibility(plan)).toBe(compatibilitySupported);
    expect(canFallbackToDockerGpuCompatibility(plan)).toBe(fallbackSupported);
  });

  it("identifies only the selected compatibility route", () => {
    expect(isDockerGpuCompatibilityRoute("compatibility")).toBe(true);
    expect(isDockerGpuCompatibilityRoute("native")).toBe(false);
    expect(isDockerGpuCompatibilityRoute("none")).toBe(false);
  });

  it("renders native and compatibility argv from one materialized plan", () => {
    const args = [
      "--from",
      "/tmp/build/Dockerfile",
      "--name",
      "alpha",
      "--policy",
      "/tmp/native-policy.yaml",
      "--gpu",
      "--gpu-device",
      "nvidia.com/gpu=0",
      "--provider",
      "provider-a",
    ];
    expect(renderSandboxCreateArgsForGpuRoute(args, "native")).toEqual(args);
    expect(
      renderSandboxCreateArgsForGpuRoute(args, "compatibility", {
        compatibilityPolicyPath: "/tmp/compatibility-policy.yaml",
      }),
    ).toEqual([
      "--from",
      "/tmp/build/Dockerfile",
      "--name",
      "alpha",
      "--policy",
      "/tmp/compatibility-policy.yaml",
      "--provider",
      "provider-a",
    ]);
  });

  it("reuses a proven image without rebuilding the fallback source", () => {
    const args = ["--from", "/tmp/build/Dockerfile", "--gpu", "--policy", "/tmp/native.yaml"];
    expect(
      renderCompatibilityFallbackCreateArgs(args, {
        imageRef: "openshell/sandbox-from:123",
        compatibilityPolicyPath: "/tmp/compatibility.yaml",
      }),
    ).toEqual(["--from", "openshell/sandbox-from:123", "--policy", "/tmp/compatibility.yaml"]);
    expect(
      renderCompatibilityFallbackCreateArgs(args, {
        allowUnbuiltSource: true,
        compatibilityPolicyPath: "/tmp/compatibility.yaml",
      }),
    ).toEqual(["--from", "/tmp/build/Dockerfile", "--policy", "/tmp/compatibility.yaml"]);
    expect(() =>
      renderCompatibilityFallbackCreateArgs(args, {
        compatibilityPolicyPath: "/tmp/compatibility.yaml",
      }),
    ).toThrow(/refusing to rebuild/i);
    expect(() => renderSandboxCreateArgsForGpuRoute(args, "compatibility")).toThrow(
      /route-specific sandbox policy/i,
    );
  });
});

describe("route-specific policy materialization", () => {
  it("keeps the native attempt narrow and prepares one broad fallback policy", () => {
    const nativeCleanup = vi.fn(() => true);
    const compatibilityCleanup = vi.fn(() => true);
    const preparePolicy = vi.fn((_base, _channels, options) => ({
      policyPath: options?.dockerGpuPatch ? "/tmp/compatibility.yaml" : "/tmp/native.yaml",
      appliedPresets: ["github"],
      cleanup: options?.dockerGpuPatch ? compatibilityCleanup : nativeCleanup,
    }));
    const policies = prepareSandboxGpuRoutePolicies(
      "/repo/policy.yaml",
      ["telegram"],
      { directGpu: true, additionalPresets: ["github"] },
      "native-with-fallback",
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
