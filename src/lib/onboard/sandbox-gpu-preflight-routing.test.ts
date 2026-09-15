// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../adapters/docker", () => ({
  dockerInfoFormat: vi.fn(),
}));

import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import {
  formatSandboxGpuPassthroughNote,
  sandboxGpuRemediationLines,
  validatePodmanSandboxGpuPreflight,
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
describe("sandbox GPU preflight routing", () => {
  it("formats Jetson sandbox GPU notes around native OpenShell CDI", () => {
    expect(formatSandboxGpuPassthroughNote({ hostGpuPlatform: "jetson" })).toContain(
      "native OpenShell CDI",
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

  it("checks Jetson sandbox GPU support through the CDI specification", () => {
    const getDockerCdiSpecDirs = vi.fn(() => ["/var/run/cdi"]);
    const findReadableNvidiaCdiSpecFiles = vi.fn(() => ["/var/run/cdi/nvidia.yaml"]);
    expect(() =>
      validateSandboxGpuPreflight(sandboxGpuConfig({ hostGpuPlatform: "jetson" }), {
        platform: "linux",
        getDockerCdiSpecDirs,
        findReadableNvidiaCdiSpecFiles,
      }),
    ).not.toThrow();
    expect(getDockerCdiSpecDirs).toHaveBeenCalledOnce();
    expect(findReadableNvidiaCdiSpecFiles).toHaveBeenCalledWith(["/var/run/cdi"]);
  });

  it("keeps generic Linux sandbox GPU preflight on the CDI path", () => {
    const getDockerCdiSpecDirs = vi.fn(() => ["/etc/cdi"]);
    const findReadableNvidiaCdiSpecFiles = vi.fn(() => ["/etc/cdi/nvidia.yaml"]);
    const dockerInfo = vi.fn(() => '{"runc":{},"nvidia":{}}');

    expect(() =>
      validateSandboxGpuPreflight(sandboxGpuConfig(), {
        platform: "linux",
        env: {},
        release: "6.8.0-generic",
        procVersion: "Linux version 6.8.0-generic",
        dockerInfoFormat: dockerInfo,
        getDockerCdiSpecDirs,
        findReadableNvidiaCdiSpecFiles,
      }),
    ).not.toThrow();
    expect(getDockerCdiSpecDirs).toHaveBeenCalled();
    expect(findReadableNvidiaCdiSpecFiles).toHaveBeenCalledWith(["/etc/cdi"]);
    expect(dockerInfo).not.toHaveBeenCalled();
  });

  it("falls back to Docker's default CDI spec dirs when docker info reports none (#7330)", () => {
    const getDockerCdiSpecDirs = vi.fn(() => []);
    const findReadableNvidiaCdiSpecFiles = (dirs: string[]) =>
      dirs.length === 2 && dirs[0] === "/etc/cdi" && dirs[1] === "/var/run/cdi"
        ? ["/etc/cdi/nvidia.yaml"]
        : [];
    const exitProcess = (code: number): never => {
      throw new Error(`exit:${code}`);
    };

    expect(() =>
      validateSandboxGpuPreflight(
        sandboxGpuConfig(),
        {
          platform: "linux",
          env: {},
          release: "6.8.0-generic",
          procVersion: "Linux version 6.8.0-generic",
          dockerInfoFormat: vi.fn(),
          getDockerCdiSpecDirs,
          findReadableNvidiaCdiSpecFiles,
        },
        exitProcess,
      ),
    ).not.toThrow();
  });

  it("validates native Podman GPU support through CDI without Docker inspection", () => {
    const findReadableNvidiaCdiSpecFiles = vi.fn(() => ["/etc/cdi/nvidia.yaml"]);

    expect(() =>
      validatePodmanSandboxGpuPreflight(sandboxGpuConfig(), {
        platform: "linux",
        findReadableNvidiaCdiSpecFiles,
      }),
    ).not.toThrow();
    expect(findReadableNvidiaCdiSpecFiles).toHaveBeenCalledWith(["/etc/cdi", "/var/run/cdi"]);
  });

  it("reports native Podman CDI admission failures without Docker remediation", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitProcess = (code: number): never => {
      throw new Error(`exit:${code}`);
    };

    try {
      expect(() =>
        validatePodmanSandboxGpuPreflight(
          sandboxGpuConfig(),
          { platform: "linux", findReadableNvidiaCdiSpecFiles: vi.fn(() => []) },
          exitProcess,
        ),
      ).toThrow("exit:1");
      const message = errorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(message).toContain("Podman CDI GPU support was not detected");
      expect(message).not.toContain("Docker");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("still fails when the fallback CDI spec dirs hold no NVIDIA spec (#7330)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number | string | null,
    ) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      expect(() =>
        validateSandboxGpuPreflight(sandboxGpuConfig(), {
          platform: "linux",
          env: {},
          release: "6.8.0-generic",
          procVersion: "Linux version 6.8.0-generic",
          dockerInfoFormat: vi.fn(),
          getDockerCdiSpecDirs: vi.fn(() => []),
          findReadableNvidiaCdiSpecFiles: vi.fn(() => []),
        }),
      ).toThrow("exit:1");
      const message = errorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(message).toContain("Docker CDI GPU support was not detected");
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("skips CDI spec validation on Docker Desktop WSL so Docker --gpus can be used", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const getDockerCdiSpecDirs = vi.fn(() => ["/etc/cdi"]);
    const findReadableNvidiaCdiSpecFiles = vi.fn(() => []);

    try {
      expect(() =>
        validateSandboxGpuPreflight(sandboxGpuConfig(), {
          platform: "linux",
          env: { WSL_DISTRO_NAME: "Ubuntu" },
          dockerInfoFormat: vi.fn(() => '"Docker Desktop"'),
          getDockerCdiSpecDirs,
          findReadableNvidiaCdiSpecFiles,
        }),
      ).not.toThrow();
      expect(getDockerCdiSpecDirs).not.toHaveBeenCalled();
      expect(findReadableNvidiaCdiSpecFiles).not.toHaveBeenCalled();
      expect(logSpy.mock.calls.map((call) => call[0]).join("\n")).toContain(
        "Docker --gpus compatibility path",
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints neutral WSL remediation when Docker runtime cannot be determined", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number | string | null,
    ) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      expect(() =>
        validateSandboxGpuPreflight(sandboxGpuConfig(), {
          platform: "linux",
          env: { WSL_DISTRO_NAME: "Ubuntu" },
          dockerInfoFormat: vi.fn(() => ""),
          getDockerCdiSpecDirs: vi.fn(() => ["/etc/cdi"]),
          findReadableNvidiaCdiSpecFiles: vi.fn(() => []),
        }),
      ).toThrow("exit:1");
      const message = errorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(message).toContain("could not determine whether Docker is Docker Desktop");
      expect(message).toContain("If using Docker Desktop");
      expect(message).toContain("If using native Docker Engine inside WSL");
      expect(message).not.toContain("sudo systemctl restart docker");
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("keeps generic Linux CDI remediation outside Docker Desktop WSL", () => {
    expect(sandboxGpuRemediationLines().join("\n")).toContain("sudo nvidia-ctk");
    expect(sandboxGpuRemediationLines({ wslDockerDesktop: true }).join("\n")).toContain(
      "Docker Desktop WSL",
    );
    expect(sandboxGpuRemediationLines({ wslDockerDesktopStatus: "unknown" }).join("\n")).toContain(
      "could not determine",
    );
  });

  it("exits with CDI remediation when Jetson has no NVIDIA CDI specification", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: number | string | null,
    ) => {
      throw new Error(`exit:${code}`);
    }) as never);

    try {
      expect(() =>
        validateSandboxGpuPreflight(sandboxGpuConfig({ hostGpuPlatform: "jetson" }), {
          platform: "linux",
          getDockerCdiSpecDirs: vi.fn(() => ["/var/run/cdi"]),
          findReadableNvidiaCdiSpecFiles: vi.fn(() => []),
        }),
      ).toThrow("exit:1");
      const message = errorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(message).toContain("Docker CDI GPU support was not detected");
      expect(message).toContain("nvidia-ctk cdi generate");
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
