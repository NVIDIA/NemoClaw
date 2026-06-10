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

  it("returns null when the host is not Docker Desktop-backed WSL", () => {
    const runProof = vi.fn(() => passingProof);
    const prover = createArm64WslDockerDesktopGpuProver({
      platform: "linux",
      arch: "arm64",
      detectWslDockerDesktopStatus: () => "not-docker-desktop",
      runProof,
      log: () => undefined,
    });
    expect(prover(["JMJWOA-Generic-GPU"])).toBeNull();
    expect(runProof).not.toHaveBeenCalled();
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

  it("uses an arch-correct CUDA sample image (not the amd64-only nbody) on this ARM64 path", () => {
    // The proof only runs on ARM64, so the image must ship a real aarch64 CUDA
    // binary. `cuda-sample:nbody` packs an x86-64 binary in its arm64 tag and
    // fails with `exec format error` on the N1X target (#4565); the chosen
    // vectorAdd image ships a genuine aarch64 binary.
    expect(WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND).toContain("cuda-sample:vectoradd");
    expect(WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND).not.toContain("nbody");
  });

  it("propagates a failing proof so detection stays fail-closed", () => {
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
