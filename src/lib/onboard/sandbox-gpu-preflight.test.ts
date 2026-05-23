// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../adapters/docker", () => ({
  dockerInfoFormat: vi.fn(),
}));

import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import {
  dockerNvidiaRuntimeAvailable,
  formatSandboxGpuPassthroughNote,
  parseDockerRuntimeNames,
  validateSandboxGpuPreflight,
} from "./sandbox-gpu-preflight";

function sandboxGpuConfig(overrides: Partial<SandboxGpuConfig> = {}): SandboxGpuConfig {
  return {
    mode: "auto",
    hostGpuDetected: true,
    hostGpuPlatform: "linux",
    sandboxGpuEnabled: true,
    sandboxGpuDevice: null,
    errors: [],
    ...overrides,
  };
}

describe("sandbox GPU preflight", () => {
  it("formats Jetson sandbox GPU notes around the NVIDIA runtime backend", () => {
    expect(formatSandboxGpuPassthroughNote({ hostGpuPlatform: "jetson" })).toContain(
      "Docker NVIDIA runtime",
    );
    expect(
      formatSandboxGpuPassthroughNote({
        resumeHasResolvedGpuIntent: true,
        recordedGpuPassthroughBeforePreflight: true,
      }),
    ).toContain("Continuing GPU passthrough");
    expect(formatSandboxGpuPassthroughNote({ requestedGpuPassthrough: true })).toContain(
      "GPU passthrough requested",
    );
  });

  it("parses Docker runtime names from JSON and plain-text output", () => {
    expect(parseDockerRuntimeNames('{"io.containerd.runc.v2":{},"nvidia":{}}')).toContain(
      "nvidia",
    );
    expect(parseDockerRuntimeNames("runc nvidia io.containerd.runc.v2")).toContain("nvidia");
    expect(parseDockerRuntimeNames("<no value>")).toEqual([]);
  });

  it("checks Jetson sandbox GPU support through Docker NVIDIA runtime availability", () => {
    const dockerInfo = vi.fn(() => '{"runc":{},"nvidia":{}}');
    expect(dockerNvidiaRuntimeAvailable({ dockerInfoFormat: dockerInfo })).toBe(true);

    expect(() =>
      validateSandboxGpuPreflight(sandboxGpuConfig({ hostGpuPlatform: "jetson" }), {
        platform: "linux",
        dockerInfoFormat: dockerInfo,
        getDockerCdiSpecDirs: vi.fn(() => {
          throw new Error("Jetson preflight must not require CDI");
        }),
        findReadableNvidiaCdiSpecFiles: vi.fn(() => {
          throw new Error("Jetson preflight must not inspect CDI specs");
        }),
      }),
    ).not.toThrow();
    expect(dockerInfo).toHaveBeenCalledWith(
      "{{json .Runtimes}}",
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("keeps generic Linux sandbox GPU preflight on the CDI path", () => {
    const getDockerCdiSpecDirs = vi.fn(() => ["/etc/cdi"]);
    const findReadableNvidiaCdiSpecFiles = vi.fn(() => ["/etc/cdi/nvidia.yaml"]);
    const dockerInfo = vi.fn(() => '{"runc":{},"nvidia":{}}');

    expect(() =>
      validateSandboxGpuPreflight(sandboxGpuConfig(), {
        platform: "linux",
        dockerInfoFormat: dockerInfo,
        getDockerCdiSpecDirs,
        findReadableNvidiaCdiSpecFiles,
      }),
    ).not.toThrow();
    expect(getDockerCdiSpecDirs).toHaveBeenCalled();
    expect(findReadableNvidiaCdiSpecFiles).toHaveBeenCalledWith(["/etc/cdi"]);
    expect(dockerInfo).not.toHaveBeenCalled();
  });

  it("exits with an explicit Jetson NVIDIA runtime message when runtime support is missing", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      expect(() =>
        validateSandboxGpuPreflight(sandboxGpuConfig({ hostGpuPlatform: "jetson" }), {
          platform: "linux",
          dockerInfoFormat: vi.fn(() => '{"runc":{}}'),
        }),
      ).toThrow("exit:1");
      const message = errorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(message).toContain("Docker NVIDIA runtime was not detected");
      expect(message).toContain("NVIDIA Container Runtime semantics, not CDI");
      expect(message).toContain("nvidia-ctk runtime configure --runtime=docker");
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
