// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  canFallbackToDockerGpuCompatibility,
  initialDockerGpuRoute,
  isDockerGpuCompatibilityRoute,
  renderCompatibilityFallbackCreateArgs,
  renderSandboxCreateArgsForGpuRoute,
  supportsDockerGpuCompatibility,
} from "./docker-gpu-route";
import { shouldApplyDockerGpuPatch } from "./docker-gpu-route-patch-adapter";

const GPU_CONFIG = { sandboxGpuEnabled: true };
const IMAGE_ID = `sha256:${"a".repeat(64)}`;

describe("Docker GPU route rendering", () => {
  it.each([
    [GPU_CONFIG, {}, false],
    [GPU_CONFIG, { NEMOCLAW_DOCKER_GPU_PATCH: "auto" }, false],
    [GPU_CONFIG, { NEMOCLAW_DOCKER_GPU_PATCH: "fallback" }, false],
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
        imageRef: IMAGE_ID,
        compatibilityPolicyPath: "/tmp/compatibility.yaml",
      }),
    ).toEqual(["--from", IMAGE_ID, "--policy", "/tmp/compatibility.yaml"]);
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
