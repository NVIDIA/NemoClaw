// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../adapters/docker", () => ({
  dockerInfoFormat: vi.fn(),
}));

import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import {
  createDirectSandboxGpuVerifier,
  dockerNvidiaRuntimeAvailable,
  formatSandboxGpuPassthroughNote,
  parseDockerRuntimeNames,
  sandboxGpuRemediationLines,
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
    expect(parseDockerRuntimeNames('{"io.containerd.runc.v2":{},"nvidia":{}}')).toContain("nvidia");
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

  it("treats optional direct sandbox GPU proof failures as non-fatal and reports unverified", () => {
    const runOpenshell = vi.fn(() => ({ status: 1, stdout: "", stderr: "optional proof failed" }));
    const verifier = createDirectSandboxGpuVerifier({
      runOpenshell,
      detectNvidiaPlatform: () => "linux",
      buildDirectSandboxGpuProofCommands: vi.fn(() => [
        {
          id: "nvidia-smi",
          args: ["sandbox", "exec", "demo", "--", "nvidia-smi"],
          label: "nvidia-smi",
          optional: true,
        },
        {
          id: "cuda-init",
          args: ["sandbox", "exec", "demo", "--", "false"],
          label: "cuda-init",
          optional: true,
        },
      ]),
      compactText: (value) => value.trim(),
      redact: (value) => String(value),
    });

    let result: ReturnType<typeof verifier> | undefined;
    expect(() => {
      result = verifier("demo");
    }).not.toThrow();
    // Optional failures no longer short-circuit; every optional proof runs so
    // the CUDA-usability outcome is observed rather than swallowed (#4231).
    expect(runOpenshell).toHaveBeenCalledTimes(2);
    expect(result?.status).toBe("unverified");
    expect(result?.cudaVerified).toBe(false);
  });

  it("reports failed when the CUDA usability proof reaches the driver and fails (#4231)", () => {
    const verifier = createDirectSandboxGpuVerifier({
      runOpenshell: vi.fn((args: string[]) => {
        if (args.includes("cuda-init-cmd")) {
          return { status: 1, stdout: "cuInit(0)=999", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      }),
      detectNvidiaPlatform: () => "jetson",
      buildDirectSandboxGpuProofCommands: vi.fn(() => [
        {
          id: "nvidia-smi",
          args: ["sandbox", "exec", "demo", "--", "nvidia-smi"],
          label: "nvidia-smi",
        },
        {
          id: "cuda-init",
          args: ["sandbox", "exec", "demo", "--", "cuda-init-cmd"],
          label: "cuInit(0)",
          optional: true,
        },
      ]),
      compactText: (value) => value.trim(),
      redact: (value) => String(value),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = verifier("demo");
      expect(result.status).toBe("failed");
      expect(result.cudaVerified).toBe(false);
      expect(result.detail).toContain("cuInit(0)=999");
      const warnings = warnSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(warnings).toContain("/dev/nvmap");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("reports verified when the CUDA usability proof passes", () => {
    const verifier = createDirectSandboxGpuVerifier({
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "cuInit(0)=0", stderr: "" })),
      detectNvidiaPlatform: () => "linux",
      buildDirectSandboxGpuProofCommands: vi.fn(() => [
        {
          id: "cuda-init",
          args: ["sandbox", "exec", "demo", "--", "cuda"],
          label: "cuInit(0)",
          optional: true,
        },
      ]),
      compactText: (value) => value.trim(),
      redact: (value) => String(value),
    });

    const result = verifier("demo");
    expect(result.status).toBe("verified");
    expect(result.cudaVerified).toBe(true);
  });

  it("does not report verified when cuda-init exits 0 without the cuInit marker", () => {
    // A zero exit that never printed `cuInit(0)=` (e.g. a wrapper that swallowed
    // the real exit code) must not be trusted as CUDA-verified.
    const verifier = createDirectSandboxGpuVerifier({
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      detectNvidiaPlatform: () => "linux",
      buildDirectSandboxGpuProofCommands: vi.fn(() => [
        {
          id: "cuda-init",
          args: ["sandbox", "exec", "demo", "--", "cuda"],
          label: "cuInit(0)",
          optional: true,
        },
      ]),
      compactText: (value) => value.trim(),
      redact: (value) => String(value),
    });

    const result = verifier("demo");
    expect(result.status).toBe("unverified");
    expect(result.cudaVerified).toBe(false);
  });

  it("treats a zero exit with a non-zero cuInit code as failed, not verified (#4231)", () => {
    // A wrapper that swallows the probe's non-zero exit but still prints a
    // non-zero `cuInit(0)=<err>` reached the driver and CUDA failed; it must not
    // read as verified just because the process exited 0.
    const verifier = createDirectSandboxGpuVerifier({
      runOpenshell: vi.fn(() => ({ status: 0, stdout: "cuInit(0)=999", stderr: "" })),
      detectNvidiaPlatform: () => "linux",
      buildDirectSandboxGpuProofCommands: vi.fn(() => [
        {
          id: "cuda-init",
          args: ["sandbox", "exec", "demo", "--", "cuda"],
          label: "cuInit(0)",
          optional: true,
        },
      ]),
      compactText: (value) => value.trim(),
      redact: (value) => String(value),
    });

    const result = verifier("demo");
    expect(result.status).toBe("failed");
    expect(result.cudaVerified).toBe(false);
    expect(result.detail).toContain("cuInit(0)=999");
  });

  it("throws on required direct sandbox GPU proof failures", () => {
    const verifier = createDirectSandboxGpuVerifier({
      runOpenshell: vi.fn(() => ({ status: 1, stdout: "", stderr: "required proof failed" })),
      detectNvidiaPlatform: () => "linux",
      buildDirectSandboxGpuProofCommands: vi.fn(() => [
        { args: ["sandbox", "exec", "demo", "--", "false"], label: "fatal proof" },
      ]),
      compactText: (value) => value.trim(),
      redact: (value) => String(value),
    });

    expect(() => verifier("demo")).toThrow("GPU proof failed: fatal proof");
  });

  it("uses Docker Desktop WSL guidance when direct sandbox GPU proof fails there", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const verifier = createDirectSandboxGpuVerifier({
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      dockerInfoFormat: vi.fn(() => '"Docker Desktop"'),
      runOpenshell: vi.fn(() => ({ status: 1, stdout: "", stderr: "required proof failed" })),
      detectNvidiaPlatform: () => "linux",
      buildDirectSandboxGpuProofCommands: vi.fn(() => [
        { args: ["sandbox", "exec", "demo", "--", "false"], label: "fatal proof" },
      ]),
      compactText: (value) => value.trim(),
      redact: (value) => String(value),
    });

    try {
      expect(() => verifier("demo")).toThrow("GPU proof failed: fatal proof");
      const message = errorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(message).toContain("Docker Desktop WSL");
      expect(message).toContain("--gpus");
      expect(message).not.toContain("sudo nvidia-ctk");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("exits with an explicit Jetson NVIDIA runtime message when runtime support is missing", () => {
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
