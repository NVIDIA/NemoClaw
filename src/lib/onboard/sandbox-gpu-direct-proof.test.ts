// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../adapters/docker", () => ({
  dockerInfoFormat: vi.fn(),
}));

import {
  createDirectSandboxGpuVerifier,
  isExplicitNvidiaSmiDriverProofFailure,
} from "./sandbox-gpu-preflight";

describe("direct sandbox GPU proof", () => {
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

  it.each([
    "Failed to initialize NVML: Driver/library version mismatch",
    "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.",
    "No devices were found",
    "Unable to determine the device handle for GPU 0000:01:00.0: Unknown Error",
  ])("returns a structured required nvidia-smi failure for %s", (diagnostic) => {
    const verifier = createDirectSandboxGpuVerifier({
      runOpenshell: vi.fn(() => ({ status: 1, stdout: "", stderr: diagnostic })),
      detectNvidiaPlatform: () => "linux",
      buildDirectSandboxGpuProofCommands: vi.fn(() => [
        {
          id: "nvidia-smi",
          args: ["sandbox", "exec", "demo", "--", "nvidia-smi"],
          label: "nvidia-smi when available",
        },
      ]),
      compactText: (value) => value.trim(),
      redact: (value) => String(value),
    });

    const result = verifier("demo");

    expect(result).toMatchObject({
      status: "failed",
      cudaVerified: false,
      label: "nvidia-smi when available",
      detail: expect.stringContaining(diagnostic),
    });
    expect(isExplicitNvidiaSmiDriverProofFailure(result)).toBe(true);
  });

  it("keeps a required nvidia-smi exec or policy error on the hard-failure path", () => {
    const verifier = createDirectSandboxGpuVerifier({
      runOpenshell: vi.fn(() => ({
        status: 1,
        stdout: "",
        stderr: "openshell sandbox exec denied by policy",
      })),
      detectNvidiaPlatform: () => "linux",
      buildDirectSandboxGpuProofCommands: vi.fn(() => [
        {
          id: "nvidia-smi",
          args: ["sandbox", "exec", "demo", "--", "nvidia-smi"],
          label: "nvidia-smi when available",
        },
      ]),
      compactText: (value) => value.trim(),
      redact: (value) => String(value),
    });

    expect(() => verifier("demo")).toThrow(
      "GPU proof failed: nvidia-smi when available (status 1): openshell sandbox exec denied by policy",
    );
  });

  it("keeps an explicit nvidia-smi failure authoritative over a later CUDA pass", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "Failed to initialize NVML: Driver/library version mismatch",
      })
      .mockReturnValueOnce({ status: 0, stdout: "cuInit(0)=0", stderr: "" });
    const verifier = createDirectSandboxGpuVerifier({
      runOpenshell,
      detectNvidiaPlatform: () => "linux",
      buildDirectSandboxGpuProofCommands: vi.fn(() => [
        {
          id: "nvidia-smi",
          args: ["sandbox", "exec", "demo", "--", "nvidia-smi"],
          label: "nvidia-smi when available",
        },
        {
          id: "cuda-init",
          args: ["sandbox", "exec", "demo", "--", "cuda-init"],
          label: "cuInit(0) via libcuda.so.1",
          optional: true,
        },
      ]),
      compactText: (value) => value.trim(),
      redact: (value) => String(value),
    });

    const result = verifier("demo");

    expect(runOpenshell).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "failed",
      cudaVerified: false,
      label: "nvidia-smi when available",
      detail: expect.stringContaining("Failed to initialize NVML"),
    });
    expect(isExplicitNvidiaSmiDriverProofFailure(result)).toBe(true);
  });

  it("rejects lookalike structured nvidia-smi results", () => {
    expect(
      isExplicitNvidiaSmiDriverProofFailure({
        status: "failed",
        cudaVerified: false,
        label: "nvidia-smi when available",
        detail: "openshell sandbox exec denied by policy",
        at: "2026-07-07T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      isExplicitNvidiaSmiDriverProofFailure({
        status: "failed",
        cudaVerified: false,
        label: "cuInit(0) via libcuda.so.1",
        detail: "Failed to initialize NVML",
        at: "2026-07-07T00:00:00.000Z",
      }),
    ).toBe(false);
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
});
