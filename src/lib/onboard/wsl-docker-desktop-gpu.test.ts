// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createInMemoryRuntimeProviderBundle } from "../../../test/helpers/runtime-provider-bundle";
import { selectDefaultOllamaModel } from "../inference/local";
import { detectGpu } from "../inference/nim";

vi.mock("../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker")>()),
  dockerInfoFormat: vi.fn(),
}));

import {
  detectWslDockerDesktopStatus,
  isWslDockerDesktopRuntime,
  WSL_DOCKER_DESKTOP_GPU_COMPATIBILITY_REMOVAL_CONDITION,
  WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND,
  wslDockerDesktopGpuCompatibilityAction,
  wslDockerDesktopGpuCompatibilityRemediationLines,
} from "./wsl-docker-desktop-gpu";
import { createDockerRuntimeProviderBundle } from "./runtime-provider/docker";
import {
  containerGpuProofTimeoutMs,
  createArm64ContainerGpuProver,
  isExecFormatErrorDiagnostic,
  parseContainerGpuProofCapacity,
} from "./runtime-provider/nvidia-container-proof";
import { createPodmanRuntimeProviderBundle } from "./runtime-provider/podman";

const PROOF_WORKLOAD_PROFILE = createDockerRuntimeProviderBundle().workload.profile;
const GPU_PROOF_NAME_PATTERN =
  /^nemoclaw-gpu-proof-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function proofProvider(providerId: "docker" | "podman") {
  return createInMemoryRuntimeProviderBundle({
    providerId,
    workloadProfile: PROOF_WORKLOAD_PROFILE,
  });
}

function podmanProofProvider(
  capture: (
    args: readonly string[],
    timeoutMs?: number,
  ) => {
    status: number;
    stdout: string;
    stderr: string;
  },
) {
  const engine = (operation: "host-doctor" | "host-local-inference" | "sandbox-lifecycle") => ({
    operation,
    engineId: "podman",
    displayName: "Podman",
    authorityId: `podman:${operation}`,
    endpointAuthorityId: "podman:test-endpoint",
    capture,
    captureHost: capture,
  });
  return createPodmanRuntimeProviderBundle({
    engines: {
      hostDoctor: engine("host-doctor"),
      hostLocalInference: engine("host-local-inference"),
      sandboxLifecycle: engine("sandbox-lifecycle"),
    },
    hostLocalInference: {} as never,
  });
}

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
    expect(
      detectWslDockerDesktopStatus({
        platform: "linux",
        env: { WSL_DISTRO_NAME: "Ubuntu" },
        dockerInfoFormat: vi.fn(() => '"Podman Engine"'),
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

describe("createArm64ContainerGpuProver (#4565)", () => {
  const passingProof = {
    providerId: "docker",
    passed: true,
    timedOut: false,
    exitCode: 0,
    diagnostic: "",
  };

  it("returns null on non-ARM64 hosts without running the proof", () => {
    const runProof = vi.fn(() => passingProof);
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "x64",
      runProof,
      log: () => undefined,
    });
    expect(prover(["JMJWOA-Generic-GPU"])).toBeNull();
    expect(runProof).not.toHaveBeenCalled();
  });

  it("fails closed when the selected provider has no NVIDIA container capability", () => {
    const base = proofProvider("docker");
    const { nvidiaContainer: _capability, ...containerEngine } = base.containerEngine;
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      resolveRuntimeProvider: () => ({ ...base, containerEngine }),
      log: () => undefined,
    });

    expect(prover(["JMJWOA-Generic-GPU"])).toMatchObject({
      providerId: "docker",
      passed: false,
      diagnostic: "configured runtime provider has no NVIDIA container proof capability",
    });
  });

  it("proves a denylisted GPU name on native Linux ARM64 (#8096)", () => {
    // A native Linux ARM64 host reports a genuine GPU as `JMJWOA-Generic-GPU`.
    // Gating the proof on Docker Desktop left no way to verify that GPU, so
    // onboarding reported "no NVIDIA GPU detected" on a host where
    // `docker run --gpus all` runs a CUDA workload.
    const runProof = vi.fn(() => passingProof);
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      env: {},
      runProof,
      log: () => undefined,
    });
    expect(prover(["JMJWOA-Generic-GPU"])).toEqual(passingProof);
    expect(runProof).toHaveBeenCalledTimes(1);
  });

  it("returns the failed bounded proof result on native Linux ARM64", () => {
    // The Snapdragon nvidia-smi shim reaches the same path; only the CUDA
    // workload separates it from real hardware (#3988/#4565).
    const failingProof = {
      providerId: "docker",
      passed: false,
      timedOut: false,
      exitCode: 1,
      diagnostic: "",
    };
    const runProof = vi.fn(() => failingProof);
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      env: {},
      runProof,
      log: () => undefined,
    });
    expect(prover(["JMJWOA-Generic-GPU"])).toEqual(failingProof);
    expect(runProof).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Docker", "docker"],
    ["Podman", "podman"],
  ] as const)(
    "runs the bounded proof through the configured %s provider on WSL",
    (_case, providerId) => {
      const provider = proofProvider(providerId);
      const runProof = vi.fn(() => passingProof);
      const logs: string[] = [];
      const prover = createArm64ContainerGpuProver({
        platform: "linux",
        arch: "arm64",
        env: { WSL_DISTRO_NAME: "Ubuntu" },
        resolveRuntimeProvider: () => provider,
        runProof,
        log: (message) => logs.push(message),
      });
      expect(prover(["JMJWOA-Generic-GPU"])).toEqual({ ...passingProof, providerId });
      expect(runProof).toHaveBeenCalledWith(provider, expect.any(Number));
      expect(logs.join("\n")).toContain(`${provider.identity.displayName} GPU proof`);
      expect(logs.join("\n")).toContain("compute-intensive Ollama models remain disabled");
    },
  );

  it("binds CUDA success and capacity to the same provider-owned container capture", () => {
    const base = proofProvider("podman");
    const captureNvidiaContainer = vi.fn(() => ({
      status: 0,
      stdout: "Test PASSED\nNEMOCLAW_GPU_MEMORY_MIB=63936, 60000\n",
      stderr: "",
    }));
    const provider = {
      ...base,
      containerEngine: {
        ...base.containerEngine,
        nvidiaContainer: {
          ...base.containerEngine.nvidiaContainer!,
          capture: captureNvidiaContainer,
          cleanup: () => ({ status: "absent" as const }),
        },
      },
    };
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      resolveRuntimeProvider: () => provider,
      log: () => undefined,
    });

    expect(prover(["JMJWOA-Generic-GPU"])).toMatchObject({
      providerId: "podman",
      passed: true,
      verifiedCapacity: { totalMemoryMB: 63_936, availableMemoryMB: 60_000 },
    });
    expect(captureNvidiaContainer).toHaveBeenCalledWith(
      "host-local-inference",
      expect.objectContaining({
        image:
          "nvcr.io/nvidia/k8s/cuda-sample@sha256:7c7540bdf1f942d4fb6db97069fd6c289471b54ac29e3c7fcdf914cf77af7d41",
        entrypoint: "/bin/sh",
        command: ["-c", expect.stringContaining("NEMOCLAW_GPU_MEMORY_MIB")],
      }),
      expect.any(Number),
    );
  });

  it("carries a real Podman capture through GPU detection to Ollama selection", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174010";
    const resourceName = `nemoclaw-gpu-proof-${uuid}`;
    const containerId = "d".repeat(64);
    const capture = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: "Test PASSED\nNEMOCLAW_GPU_MEMORY_MIB=63936, 60000\n",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: `${containerId}\t${resourceName}\n`,
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: containerId, stderr: "" });
    const provider = podmanProofProvider(capture);
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      randomUUID: () => uuid,
      resolveRuntimeProvider: () => provider,
      log: () => undefined,
    });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    Object.defineProperty(process, "arch", { ...arch, value: "arm64" });
    try {
      const gpu = detectGpu({
        proveArm64ContainerGpu: prover,
        runCaptureImpl: vi.fn((command: readonly string[]) =>
          command[0] === "nvidia-smi"
            ? "NVIDIA RTX Spark N1X (6144-core Blackwell RTX GPU), 999999, 999999\n"
            : "",
        ),
        isWsl: true,
        n1xWslProduct: true,
      });

      expect(gpu).toMatchObject({
        containerGpuProof: { providerId: "podman", passed: true },
        totalMemoryMB: 63_936,
        availableMemoryMB: 60_000,
      });
      expect(selectDefaultOllamaModel(["qwen3.5:9b", "qwen3.6:35b"], gpu)).toBe("qwen3.6:35b");
      expect(capture).toHaveBeenCalledWith(
        expect.arrayContaining(["--device", "nvidia.com/gpu=all"]),
        expect.any(Number),
      );
      expect(capture).toHaveBeenCalledWith(
        expect.arrayContaining(["rm", "-f", containerId]),
        expect.any(Number),
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
      Object.defineProperty(process, "arch", arch);
    }
  });

  it("carries a real Docker capture through GPU detection to Ollama selection", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174011";
    const resourceName = `nemoclaw-gpu-proof-${uuid}`;
    const containerId = "e".repeat(64);
    const captureHostCommand = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: "Test PASSED\nNEMOCLAW_GPU_MEMORY_MIB=63936, 60000\n",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: `${containerId}\t${resourceName}\n`,
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: containerId, stderr: "" });
    const provider = createDockerRuntimeProviderBundle({ captureHostCommand });
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      randomUUID: () => uuid,
      resolveRuntimeProvider: () => provider,
      log: () => undefined,
    });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    Object.defineProperty(process, "arch", { ...arch, value: "arm64" });
    try {
      const gpu = detectGpu({
        proveArm64ContainerGpu: prover,
        runCaptureImpl: vi.fn((command: readonly string[]) =>
          command[0] === "nvidia-smi"
            ? "NVIDIA RTX Spark N1X (6144-core Blackwell RTX GPU), 999999, 999999\n"
            : "",
        ),
        isWsl: true,
        n1xWslProduct: true,
      });

      expect(gpu).toMatchObject({
        containerGpuProof: { providerId: "docker", passed: true },
        totalMemoryMB: 63_936,
        availableMemoryMB: 60_000,
      });
      expect(selectDefaultOllamaModel(["qwen3.5:9b", "qwen3.6:35b"], gpu)).toBe("qwen3.6:35b");
      expect(captureHostCommand).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["--gpus", "all"]),
        expect.any(Number),
      );
      expect(captureHostCommand).toHaveBeenCalledWith(
        "docker",
        ["rm", "-f", containerId],
        expect.any(Number),
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
      Object.defineProperty(process, "arch", arch);
    }
  });

  it("maps a nonzero provider-owned container capture to a failed proof", () => {
    const base = proofProvider("docker");
    const captureNvidiaContainer = vi.fn(() => ({
      status: 1,
      stdout: "",
      stderr: "no CUDA-capable device is detected",
    }));
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      resolveRuntimeProvider: () => ({
        ...base,
        containerEngine: {
          ...base.containerEngine,
          nvidiaContainer: {
            ...base.containerEngine.nvidiaContainer!,
            capture: captureNvidiaContainer,
          },
        },
      }),
      log: () => undefined,
    });

    expect(prover(["JMJWOA-Generic-GPU"])).toMatchObject({
      providerId: "docker",
      passed: false,
      timedOut: false,
      exitCode: 1,
      diagnostic: "no CUDA-capable device is detected",
    });
  });

  it("reports failed reconciliation after a successful proof capture", () => {
    const base = proofProvider("docker");
    const uuid = "123e4567-e89b-42d3-a456-426614174012";
    const resourceName = `nemoclaw-gpu-proof-${uuid}`;
    const logs: string[] = [];
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      randomUUID: () => uuid,
      resolveRuntimeProvider: () => ({
        ...base,
        containerEngine: {
          ...base.containerEngine,
          nvidiaContainer: {
            capture: () => ({
              status: 0,
              stdout: "Test PASSED\nNEMOCLAW_GPU_MEMORY_MIB=63936, 60000\n",
              stderr: "",
            }),
            cleanup: () => ({ status: "failed" }),
          },
        },
      }),
      log: (message) => logs.push(message),
    });

    const result = prover(["JMJWOA-Generic-GPU"]);
    expect(result).toMatchObject({
      passed: false,
      cleanup: { resourceName, status: "failed" },
    });
    expect(result).not.toHaveProperty("verifiedCapacity");
    expect(logs.join("\n")).toContain("could not prove absence or removal");
    expect(logs.join("\n")).toContain(resourceName);

    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    Object.defineProperty(process, "arch", { ...arch, value: "arm64" });
    try {
      expect(
        detectGpu({
          proveArm64ContainerGpu: () => result,
          runCaptureImpl: vi.fn((command: readonly string[]) =>
            command[0] === "nvidia-smi"
            ? "NVIDIA RTX Spark N1X (6144-core Blackwell RTX GPU), 999999, 999999\n"
            : "",
        ),
          isWsl: true,
          n1xWslProduct: true,
        }),
      ).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", platform);
      Object.defineProperty(process, "arch", arch);
    }
  });

  it("fails closed and cleans the exact provider-owned container after timeout", () => {
    const base = proofProvider("podman");
    const timeout = Object.assign(new Error("proof timed out"), { code: "ETIMEDOUT" });
    const cleanupNvidiaContainer = vi.fn(() => ({ status: "failed" as const }));
    const logs: string[] = [];
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      resolveRuntimeProvider: () => ({
        ...base,
        containerEngine: {
          ...base.containerEngine,
          nvidiaContainer: {
            capture: () => ({
              status: 1,
              stdout: "NEMOCLAW_GPU_MEMORY_MIB=63936, 60000\n",
              stderr: "",
              error: timeout,
            }),
            cleanup: cleanupNvidiaContainer,
          },
        },
      }),
      log: (message) => logs.push(message),
    });

    const result = prover(["JMJWOA-Generic-GPU"]);
    expect(result).toMatchObject({
      providerId: "podman",
      passed: false,
      timedOut: true,
      exitCode: 1,
      cleanup: { status: "failed" },
    });
    expect(result).not.toHaveProperty("verifiedCapacity");
    expect(cleanupNvidiaContainer).toHaveBeenCalledWith(
      "host-local-inference",
      expect.objectContaining({
        name: expect.stringMatching(GPU_PROOF_NAME_PATTERN),
        ownership: { label: "com.nvidia.nemoclaw.gpu-proof", value: "true" },
      }),
      { timeoutMs: 15_000, observation: "until-deadline" },
    );
    expect(logs.join("\n")).toContain("timed out");
    expect(logs.join("\n")).toContain(result?.cleanup?.resourceName ?? "missing-resource");
  });

  it("removes a proof container that appears after the former five-poll cleanup window", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174001";
    const resourceName = `nemoclaw-gpu-proof-${uuid}`;
    const containerId = "c".repeat(64);
    const timeout = Object.assign(new Error("proof timed out"), { code: "ETIMEDOUT" });
    const captureHostCommand = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "", error: timeout })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: `${containerId}\t${resourceName}\n`,
        stderr: "",
      })
      .mockReturnValueOnce({ status: 0, stdout: containerId, stderr: "" });
    const provider = createDockerRuntimeProviderBundle({ captureHostCommand });
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      randomUUID: () => uuid,
      resolveRuntimeProvider: () => provider,
      log: () => undefined,
    });

    expect(prover(["JMJWOA-Generic-GPU"])).toMatchObject({
      passed: false,
      timedOut: true,
      cleanup: { resourceName, status: "removed" },
    });
    expect(captureHostCommand).toHaveBeenNthCalledWith(
      9,
      "docker",
      ["rm", "-f", containerId],
      expect.any(Number),
    );
  });

  it("reports unresolved cleanup when an interrupted launch stays absent through its deadline", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174002";
    const resourceName = `nemoclaw-gpu-proof-${uuid}`;
    const timeout = Object.assign(new Error("proof timed out"), { code: "ETIMEDOUT" });
    const captureHostCommand = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "", error: timeout })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    const provider = createDockerRuntimeProviderBundle({ captureHostCommand });
    const logs: string[] = [];
    let clockReads = 0;
    const performanceNow = vi.spyOn(performance, "now").mockImplementation(() => {
      clockReads += 1;
      return clockReads < 3 ? 0 : 15_000;
    });
    try {
      const prover = createArm64ContainerGpuProver({
        platform: "linux",
        arch: "arm64",
        randomUUID: () => uuid,
        resolveRuntimeProvider: () => provider,
        log: (message) => logs.push(message),
      });

      expect(prover(["JMJWOA-Generic-GPU"])).toMatchObject({
        passed: false,
        timedOut: true,
        cleanup: { resourceName, status: "failed" },
      });
    } finally {
      performanceNow.mockRestore();
    }
    expect(captureHostCommand).toHaveBeenCalledTimes(2);
    expect(logs.join("\n")).toContain("could not prove absence or removal");
    expect(logs.join("\n")).toContain(resourceName);
  });

  it("cleans the exact provider-owned container after an interrupted non-timeout capture", () => {
    const base = proofProvider("docker");
    const interrupted = Object.assign(new Error("proof interrupted"), { code: "EINTR" });
    const cleanupNvidiaContainer = vi.fn(() => ({ status: "removed" as const }));
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      resolveRuntimeProvider: () => ({
        ...base,
        containerEngine: {
          ...base.containerEngine,
          nvidiaContainer: {
            capture: () => ({
              status: 1,
              stdout: "",
              stderr: "proof interrupted",
              error: interrupted,
            }),
            cleanup: cleanupNvidiaContainer,
          },
        },
      }),
      log: () => undefined,
    });

    expect(prover(["JMJWOA-Generic-GPU"])).toMatchObject({
      providerId: "docker",
      passed: false,
      timedOut: false,
      cleanup: { status: "removed" },
    });
    expect(cleanupNvidiaContainer).toHaveBeenCalledWith(
      "host-local-inference",
      expect.objectContaining({ name: expect.stringMatching(GPU_PROOF_NAME_PATTERN) }),
      { timeoutMs: 15_000, observation: "until-deadline" },
    );
  });

  it("uses an unpredictable per-proof resource before cleaning a name collision", () => {
    const base = proofProvider("docker");
    const cleanupNvidiaContainer = vi.fn(() => ({ status: "absent" as const }));
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      randomUUID: () => uuid,
      resolveRuntimeProvider: () => ({
        ...base,
        containerEngine: {
          ...base.containerEngine,
          nvidiaContainer: {
            capture: () => ({
              status: 125,
              stdout: "",
              stderr: "container name is already in use",
            }),
            cleanup: cleanupNvidiaContainer,
          },
        },
      }),
      log: () => undefined,
    });

    expect(prover(["JMJWOA-Generic-GPU"])).toMatchObject({
      passed: false,
      cleanup: { resourceName: `nemoclaw-gpu-proof-${uuid}`, status: "absent" },
    });
    expect(cleanupNvidiaContainer).toHaveBeenCalledWith(
      "host-local-inference",
      expect.objectContaining({ name: `nemoclaw-gpu-proof-${uuid}` }),
      { timeoutMs: 15_000, observation: "immediate" },
    );
    expect(`nemoclaw-gpu-proof-${uuid}`).not.toBe(`nemoclaw-gpu-proof-${String(process.pid)}`);
  });

  it("parses one capacity row from the container-bound CUDA proof", () => {
    expect(
      parseContainerGpuProofCapacity("Test PASSED\nNEMOCLAW_GPU_MEMORY_MIB=63936, 60000\n"),
    ).toEqual({ totalMemoryMB: 63_936, availableMemoryMB: 60_000 });
  });

  it.each([
    ["a missing marker", "Test PASSED\n"],
    [
      "duplicate markers",
      "NEMOCLAW_GPU_MEMORY_MIB=63936, 60000\nNEMOCLAW_GPU_MEMORY_MIB=63936, 60000\n",
    ],
    ["multiple device rows", "NEMOCLAW_GPU_MEMORY_MIB=63936, 60000\n63936, 60000\n"],
    ["free memory above total memory", "NEMOCLAW_GPU_MEMORY_MIB=63936, 70000\n"],
    ["zero total memory", "NEMOCLAW_GPU_MEMORY_MIB=0, 0\n"],
    ["nonnumeric memory", "NEMOCLAW_GPU_MEMORY_MIB=not-a-number\n"],
  ])("rejects container capacity with %s", (_scenario, output) => {
    expect(parseContainerGpuProofCapacity(output)).toBeNull();
  });

  it("escapes terminal controls in a denylisted GPU name before logging", () => {
    const logs: string[] = [];
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      env: {},
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
    expect(WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND).toContain(
      "nvcr.io/nvidia/k8s/cuda-sample@sha256:7c7540bdf1f942d4fb6db97069fd6c289471b54ac29e3c7fcdf914cf77af7d41",
    );
    expect(WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND).toContain("--entrypoint /bin/sh");
    expect(WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND).toContain("NEMOCLAW_GPU_MEMORY_MIB");
    expect(WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND).not.toContain("vectoradd-cuda12.5.0");
    expect(WSL_DOCKER_DESKTOP_GPU_PROOF_COMMAND).not.toContain("nbody");
  });

  it("returns the failed bounded proof result on Docker Desktop WSL", () => {
    const failing = {
      providerId: "docker",
      passed: false,
      timedOut: false,
      exitCode: 1,
      diagnostic: "no CUDA device",
    };
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
      runProof: () => failing,
      log: () => undefined,
    });
    expect(prover(["JMJWOA-Generic-GPU"])?.passed).toBe(false);
  });

  it("flags an exec-format-error proof as an image-arch problem, not a missing GPU (#4565)", () => {
    const execFormatFailure = {
      providerId: "docker",
      passed: false,
      timedOut: false,
      exitCode: 1,
      diagnostic: "exec /cuda-samples/sample: exec format error",
    };
    const logs: string[] = [];
    const prover = createArm64ContainerGpuProver({
      platform: "linux",
      arch: "arm64",
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
    expect(containerGpuProofTimeoutMs({ NEMOCLAW_WSL_GPU_PROOF_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(containerGpuProofTimeoutMs({})).toBeGreaterThan(0);
    expect(containerGpuProofTimeoutMs({ NEMOCLAW_WSL_GPU_PROOF_TIMEOUT_MS: "-1" })).toBeGreaterThan(
      0,
    );
    expect(containerGpuProofTimeoutMs({ NEMOCLAW_WSL_GPU_PROOF_TIMEOUT_MS: "864000000" })).toBe(
      900_000,
    );
  });

  it("detects Docker exec-format-error diagnostics", () => {
    expect(isExecFormatErrorDiagnostic("exec /cuda-samples/sample: exec format error")).toBe(true);
    expect(isExecFormatErrorDiagnostic("standard_init_linux.go: exec format error")).toBe(true);
    expect(isExecFormatErrorDiagnostic("no CUDA-capable device is detected")).toBe(false);
    expect(isExecFormatErrorDiagnostic(null)).toBe(false);
    expect(isExecFormatErrorDiagnostic(undefined)).toBe(false);
  });
});
