// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../adapters/docker", () => ({
  dockerInfoFormat: vi.fn(),
}));

import {
  createArm64WslDockerDesktopGpuProver,
  detectWslDockerDesktopStatus,
  isExecFormatErrorDiagnostic,
  isWslDockerDesktopRuntime,
  WSL_DOCKER_DESKTOP_GPU_COMPATIBILITY_REMOVAL_CONDITION,
  WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND,
  wslDockerDesktopGpuCompatibilityAction,
  wslDockerDesktopGpuCompatibilityRemediationLines,
  wslDockerDesktopGpuProofTimeoutMs,
} from "./wsl-docker-desktop-gpu";

describe("WSL Docker Desktop GPU compatibility helpers", () => {
  it("only matches Docker Desktop-backed WSL host assessments", () => {
    expect(isWslDockerDesktopRuntime({ isWsl: true, runtime: "docker-desktop" })).toBe(true);
    expect(isWslDockerDesktopRuntime({ isWsl: true, runtime: "docker" })).toBe(false);
    expect(isWslDockerDesktopRuntime({ isWsl: false, runtime: "docker-desktop" })).toBe(false);
  });

  it("detects Docker Desktop status only after WSL detection succeeds", () => {
    const dockerInfoFormat = vi.fn(() => '"Docker Desktop"');
    expect(
      detectWslDockerDesktopStatus({
        platform: "linux",
        env: { WSL_DISTRO_NAME: "Ubuntu" },
        dockerInfoFormat,
      }),
    ).toBe("docker-desktop");
    expect(dockerInfoFormat).toHaveBeenCalledWith(
      "{{json .OperatingSystem}}",
      expect.objectContaining({ ignoreError: true }),
    );

    expect(
      detectWslDockerDesktopStatus({
        platform: "linux",
        env: {},
        release: "6.8.0-generic",
        procVersion: "Linux version 6.8.0-generic",
        dockerInfoFormat: vi.fn(() => '"Docker Desktop"'),
      }),
    ).toBe("not-docker-desktop");
  });

  it("centralizes non-blocking Docker --gpus remediation and its removal condition", () => {
    const action = wslDockerDesktopGpuCompatibilityAction();
    expect(action.kind).toBe("info");
    expect(action.blocking).toBe(false);
    expect(action.reason).toContain("--gpus");
    expect(action.commands.join("\n")).not.toContain("nvidia-ctk");

    expect(
      wslDockerDesktopGpuCompatibilityRemediationLines("docker-desktop")?.join("\n"),
    ).toContain("Docker --gpus compatibility");
    expect(wslDockerDesktopGpuCompatibilityRemediationLines("unknown")?.join("\n")).toContain(
      "could not determine whether Docker is Docker Desktop",
    );
    expect(wslDockerDesktopGpuCompatibilityRemediationLines("not-docker-desktop")).toBeNull();
    expect(WSL_DOCKER_DESKTOP_GPU_COMPATIBILITY_REMOVAL_CONDITION).toContain("Remove");
  });
});

describe("createArm64WslDockerDesktopGpuProver (#4565)", () => {
  const passingProof = { passed: true, timedOut: false, exitCode: 0, diagnostic: "" };

  it("returns null on non-ARM64 hosts without running the proof", () => {
    const runProof = vi.fn(() => passingProof);
    const prover = createArm64WslDockerDesktopGpuProver({
      platform: "linux",
      arch: "x64",
      detectWslDockerDesktopStatus: () => "docker-desktop",
      runProof,
      log: () => undefined,
    });
    expect(prover(["JMJWOA-Generic-GPU"])).toBeNull();
    expect(runProof).not.toHaveBeenCalled();
  });

  it("proves a denylisted GPU name on native Linux ARM64 (#8096)", () => {
    // A native Linux ARM64 host reports a genuine GPU as `JMJWOA-Generic-GPU`.
    // Gating the proof on Docker Desktop left no way to verify that GPU, so
    // onboarding reported "no NVIDIA GPU detected" on a host where
    // `docker run --gpus all` runs a CUDA workload.
    const runProof = vi.fn(() => passingProof);
    const prover = createArm64WslDockerDesktopGpuProver({
      platform: "linux",
      arch: "arm64",
      env: {},
      release: "6.17.0-1029-nvidia",
      procVersion: "Linux version 6.17.0-1029-nvidia",
      runProof,
      log: () => undefined,
    });
    expect(prover(["JMJWOA-Generic-GPU"])).toEqual(passingProof);
    expect(runProof).toHaveBeenCalledTimes(1);
  });

  it("returns the failed bounded proof result on native Linux ARM64", () => {
    // The Snapdragon nvidia-smi shim reaches the same path; only the CUDA
    // workload separates it from real hardware (#3988/#4565).
    const failingProof = { passed: false, timedOut: false, exitCode: 1, diagnostic: "" };
    const runProof = vi.fn(() => failingProof);
    const prover = createArm64WslDockerDesktopGpuProver({
      platform: "linux",
      arch: "arm64",
      env: {},
      release: "6.17.0-1029-nvidia",
      procVersion: "Linux version 6.17.0-1029-nvidia",
      runProof,
      log: () => undefined,
    });
    expect(prover(["JMJWOA-Generic-GPU"])).toEqual(failingProof);
    expect(runProof).toHaveBeenCalledTimes(1);
  });

  it("leaves WSL hosts without Docker Desktop unproven (#8096)", () => {
    // Windows-on-ARM passthrough scope is unchanged: only native Linux is added.
    for (const status of ["not-docker-desktop", "unknown"] as const) {
      const runProof = vi.fn(() => passingProof);
      const prover = createArm64WslDockerDesktopGpuProver({
        platform: "linux",
        arch: "arm64",
        env: { WSL_DISTRO_NAME: "Ubuntu" },
        detectWslDockerDesktopStatus: () => status,
        runProof,
        log: () => undefined,
      });
      expect(prover(["JMJWOA-Generic-GPU"])).toBeNull();
      expect(runProof).not.toHaveBeenCalled();
    }
  });

  it("runs the bounded proof and reports the result on ARM64 Docker Desktop WSL", () => {
    const runProof = vi.fn((_argv: string[], _timeoutMs: number) => passingProof);
    const prover = createArm64WslDockerDesktopGpuProver({
      platform: "linux",
      arch: "arm64",
      detectWslDockerDesktopStatus: () => "docker-desktop",
      runProof,
      log: () => undefined,
    });
    expect(prover(["JMJWOA-Generic-GPU"])).toEqual(passingProof);
    expect(runProof).toHaveBeenCalledTimes(1);
    const argv = runProof.mock.calls[0]?.[0] ?? [];
    expect(argv[0]).toBe("docker");
    expect(argv).toContain("--gpus");
  });

  it("escapes terminal controls in a denylisted GPU name before logging", () => {
    const logs: string[] = [];
    const prover = createArm64WslDockerDesktopGpuProver({
      platform: "linux",
      arch: "arm64",
      env: {},
      release: "6.17.0-1029-nvidia",
      procVersion: "Linux version 6.17.0-1029-nvidia",
      runProof: () => passingProof,
      log: (message) => logs.push(message),
    });

    expect(prover(["JMJWOA-Generic-\u001b[2J\nforged status"])).toEqual(passingProof);
    expect(logs[0]).toContain("JMJWOA-Generic-\\u{001b}[2J\\u{000a}forged status");
    expect(logs.every((message) => !/[\u0000-\u001f\u007f-\u009f]/u.test(message))).toBe(true);
  });

  it("uses the approved immutable multi-architecture CUDA sample image on this ARM64 path", () => {
    // The proof only runs on ARM64, so the image must ship a real aarch64 CUDA
    // binary. `cuda-sample:nbody` packs an x86-64 binary in its arm64 tag and
    // fails with `exec format error` on the N1X target (#4565); the chosen
    // vectorAdd image ships a genuine aarch64 binary.
    expect(WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND).toBe(
      "docker run --rm --gpus all nvcr.io/nvidia/k8s/cuda-sample@sha256:7c7540bdf1f942d4fb6db97069fd6c289471b54ac29e3c7fcdf914cf77af7d41",
    );
    expect(WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND).not.toContain("vectoradd-cuda12.5.0");
    expect(WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND).not.toContain("nbody");
  });

  it("returns the failed bounded proof result on Docker Desktop WSL", () => {
    const failing = { passed: false, timedOut: false, exitCode: 1, diagnostic: "no CUDA device" };
    const prover = createArm64WslDockerDesktopGpuProver({
      platform: "linux",
      arch: "arm64",
      detectWslDockerDesktopStatus: () => "docker-desktop",
      runProof: () => failing,
      log: () => undefined,
    });
    expect(prover(["JMJWOA-Generic-GPU"])?.passed).toBe(false);
  });

  it("flags an exec-format-error proof as an image-arch problem, not a missing GPU (#4565)", () => {
    const execFormatFailure = {
      passed: false,
      timedOut: false,
      exitCode: 1,
      diagnostic: "exec /cuda-samples/sample: exec format error",
    };
    const logs: string[] = [];
    const prover = createArm64WslDockerDesktopGpuProver({
      platform: "linux",
      arch: "arm64",
      detectWslDockerDesktopStatus: () => "docker-desktop",
      runProof: () => execFormatFailure,
      log: (message) => logs.push(message),
    });
    // Still fail-closed (no false positive), but the operator-facing message
    // must distinguish an image-architecture bug from a missing GPU.
    expect(prover(["JMJWOA-Generic-GPU"])?.passed).toBe(false);
    const combined = logs.join("\n");
    expect(combined).toContain("architecture");
    expect(combined).not.toContain("treating GPU as unproven");
  });

  it("honors a positive NEMOCLAW_WSL_GPU_PROOF_TIMEOUT_MS override", () => {
    expect(wslDockerDesktopGpuProofTimeoutMs({ NEMOCLAW_WSL_GPU_PROOF_TIMEOUT_MS: "5000" })).toBe(
      5000,
    );
    expect(wslDockerDesktopGpuProofTimeoutMs({})).toBeGreaterThan(0);
    expect(
      wslDockerDesktopGpuProofTimeoutMs({ NEMOCLAW_WSL_GPU_PROOF_TIMEOUT_MS: "-1" }),
    ).toBeGreaterThan(0);
  });

  it("detects Docker exec-format-error diagnostics", () => {
    expect(isExecFormatErrorDiagnostic("exec /cuda-samples/sample: exec format error")).toBe(true);
    expect(isExecFormatErrorDiagnostic("standard_init_linux.go: exec format error")).toBe(true);
    expect(isExecFormatErrorDiagnostic("no CUDA-capable device is detected")).toBe(false);
    expect(isExecFormatErrorDiagnostic(null)).toBe(false);
    expect(isExecFormatErrorDiagnostic(undefined)).toBe(false);
  });
});
