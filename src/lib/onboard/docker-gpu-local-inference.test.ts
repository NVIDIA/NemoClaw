// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  printDockerGpuHostNetworkInferenceVerificationFailure,
  shouldUseDockerGpuPatchHostNetwork,
  verifyDockerGpuHostNetworkLocalInference,
  verifyGpuSandboxAfterReady,
} from "../../../dist/lib/onboard/docker-gpu-local-inference";

const HOST_NETWORK_ENV = { NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host" } as NodeJS.ProcessEnv;
const GPU_CONFIG = { sandboxGpuEnabled: true };

function hostNetworkOptions(extra: Record<string, unknown> = {}) {
  return {
    sandboxName: "alpha",
    dockerDriverGateway: true,
    platform: "linux" as NodeJS.Platform,
    env: HOST_NETWORK_ENV,
    ...extra,
  };
}

function inspectWithNetworkMode(mode: string): string {
  return JSON.stringify([{ HostConfig: { NetworkMode: mode } }]);
}

const CURL_CHECK_PROBE = "command -v curl >/dev/null 2>&1";

// Build a dockerRun mock that reports curl as present and returns `probeResult`
// for the actual reachability probe (curl -sf ...).
function dockerRunWithCurl(probeResult: { status: number; stderr?: string }) {
  return vi.fn((args: readonly string[]) => {
    if (args.includes(CURL_CHECK_PROBE)) return { status: 0 };
    return probeResult;
  });
}

describe("shouldUseDockerGpuPatchHostNetwork", () => {
  it("is true only on the Linux Docker-driver host-network path", () => {
    expect(
      shouldUseDockerGpuPatchHostNetwork(GPU_CONFIG, {
        dockerDriverGateway: true,
        platform: "linux",
        env: HOST_NETWORK_ENV,
      }),
    ).toBe(true);
    // Not host network mode.
    expect(
      shouldUseDockerGpuPatchHostNetwork(GPU_CONFIG, {
        dockerDriverGateway: true,
        platform: "linux",
        env: {},
      }),
    ).toBe(false);
    // Not linux.
    expect(
      shouldUseDockerGpuPatchHostNetwork(GPU_CONFIG, {
        dockerDriverGateway: true,
        platform: "darwin",
        env: HOST_NETWORK_ENV,
      }),
    ).toBe(false);
  });
});

describe("verifyDockerGpuHostNetworkLocalInference", () => {
  it("skips when the host-network GPU patch is not active", () => {
    const result = verifyDockerGpuHostNetworkLocalInference(
      GPU_CONFIG,
      "ollama-local",
      hostNetworkOptions({ env: {} }),
    );
    expect(result.status).toBe("skipped");
  });

  it("skips for non-local providers", () => {
    const result = verifyDockerGpuHostNetworkLocalInference(
      GPU_CONFIG,
      "build",
      hostNetworkOptions(),
    );
    expect(result).toEqual({ status: "skipped", reason: "not-local-provider" });
  });

  it("skips when the Docker GPU patch is explicitly disabled", () => {
    const dockerRun = vi.fn();
    const result = verifyDockerGpuHostNetworkLocalInference(
      GPU_CONFIG,
      "ollama-local",
      hostNetworkOptions({
        env: { ...HOST_NETWORK_ENV, NEMOCLAW_DOCKER_GPU_PATCH: "0" },
        deps: {
          findContainerIds: () => [],
          dockerCapture: vi.fn(),
          dockerRun,
          sleep: vi.fn(),
        },
      }),
    );
    expect(result.status).toBe("skipped");
    // No container lookup or probe is attempted when the patch is opted out.
    expect(dockerRun).not.toHaveBeenCalled();
  });

  it("passes when the container is on host network and the probe succeeds", () => {
    const dockerCapture = vi.fn(() => inspectWithNetworkMode("host"));
    const dockerRun = dockerRunWithCurl({ status: 0 });
    const result = verifyDockerGpuHostNetworkLocalInference(
      GPU_CONFIG,
      "vllm-local",
      hostNetworkOptions({
        deps: {
          findContainerIds: () => ["container-abc"],
          dockerCapture,
          dockerRun,
          sleep: vi.fn(),
        },
      }),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.containerId).toBe("container-abc");
      expect(result.networkMode).toBe("host");
      expect(result.endpoint).toContain("/v1/models");
    }
    // Probe runs curl inside the recreated container against the direct URL.
    expect(dockerRun).toHaveBeenCalledWith(
      expect.arrayContaining(["exec", "container-abc", "curl", "-sf"]),
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("fails when no recreated container is found", () => {
    const result = verifyDockerGpuHostNetworkLocalInference(
      GPU_CONFIG,
      "ollama-local",
      hostNetworkOptions({
        deps: {
          findContainerIds: () => [],
          dockerCapture: vi.fn(),
          dockerRun: vi.fn(),
          sleep: vi.fn(),
        },
      }),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.kind).toBe("container-not-found");
      expect(result.recovery.length).toBeGreaterThan(0);
    }
  });

  it("fails when the recreated container is not on host network", () => {
    const dockerRun = vi.fn(() => ({ status: 0 }));
    const result = verifyDockerGpuHostNetworkLocalInference(
      GPU_CONFIG,
      "ollama-local",
      hostNetworkOptions({
        deps: {
          findContainerIds: () => ["container-xyz"],
          dockerCapture: vi.fn(() => inspectWithNetworkMode("openshell-docker")),
          dockerRun,
          sleep: vi.fn(),
        },
      }),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.kind).toBe("network-mode");
      expect(result.networkMode).toBe("openshell-docker");
    }
    // Do not probe when the network mode is already wrong.
    expect(dockerRun).not.toHaveBeenCalled();
  });

  it("fails and retries when the direct endpoint probe never succeeds", () => {
    const dockerRun = dockerRunWithCurl({ status: 7, stderr: "Connection refused" });
    const sleep = vi.fn();
    const result = verifyDockerGpuHostNetworkLocalInference(
      GPU_CONFIG,
      "ollama-local",
      hostNetworkOptions({
        deps: {
          findContainerIds: () => ["container-xyz"],
          dockerCapture: vi.fn(() => inspectWithNetworkMode("host")),
          dockerRun,
          sleep,
        },
      }),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.kind).toBe("probe");
      expect(result.detail).toContain("Connection refused");
      expect(result.endpoint).toContain("/api/tags");
    }
    // 1 curl-availability check + 3 probe attempts.
    expect(dockerRun).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("soft-skips with a warning when the container image lacks curl", () => {
    // dockerRun reports curl missing (non-zero for the curl-availability check).
    const dockerRun = vi.fn(() => ({ status: 1 }));
    const log = vi.fn();
    const result = verifyDockerGpuHostNetworkLocalInference(
      GPU_CONFIG,
      "ollama-local",
      hostNetworkOptions({
        log,
        deps: {
          findContainerIds: () => ["container-xyz"],
          dockerCapture: vi.fn(() => inspectWithNetworkMode("host")),
          dockerRun,
          sleep: vi.fn(),
        },
      }),
    );
    expect(result).toEqual({ status: "skipped", reason: "probe-tool-unavailable" });
    // Only the curl-availability check runs; no curl probe is attempted.
    expect(dockerRun).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("curl is not available"));
  });

  it("surfaces the curl-missing skip warning even without a logger", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = verifyDockerGpuHostNetworkLocalInference(
        GPU_CONFIG,
        "ollama-local",
        hostNetworkOptions({
          // No log provided — the warning must still reach the operator.
          deps: {
            findContainerIds: () => ["container-xyz"],
            dockerCapture: vi.fn(() => inspectWithNetworkMode("host")),
            dockerRun: vi.fn(() => ({ status: 1 })),
            sleep: vi.fn(),
          },
        }),
      );
      expect(result).toEqual({ status: "skipped", reason: "probe-tool-unavailable" });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("curl is not available"));
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("verifyGpuSandboxAfterReady", () => {
  function baseOptions(extra: Record<string, unknown> = {}) {
    return {
      sandboxName: "alpha",
      dockerDriverGateway: true,
      platform: "linux" as NodeJS.Platform,
      env: HOST_NETWORK_ENV,
      useDockerGpuPatch: true,
      verifyDirectSandboxGpu: vi.fn(),
      selectedMode: () => null,
      runCaptureOpenshell: vi.fn(() => ""),
      log: vi.fn(),
      ...extra,
    };
  }

  it("runs the GPU proof and the host-network inference gate when the patch is active", () => {
    const log = vi.fn();
    const verifyDirectSandboxGpu = vi.fn();
    verifyGpuSandboxAfterReady(
      GPU_CONFIG,
      "vllm-local",
      baseOptions({
        verifyDirectSandboxGpu,
        log,
        deps: {
          findContainerIds: () => ["container-abc"],
          dockerCapture: vi.fn(() => inspectWithNetworkMode("host")),
          dockerRun: dockerRunWithCurl({ status: 0 }),
          sleep: vi.fn(),
        },
      }),
    );
    expect(verifyDirectSandboxGpu).toHaveBeenCalledWith("alpha");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("reachable from sandbox"));
  });

  it("uses Docker GPU patch verifier when supplied", () => {
    const verifyDirectSandboxGpu = vi.fn();
    const verifyGpuOrExit = vi.fn((proof: (sandboxName: string) => void) => proof("alpha"));
    verifyGpuSandboxAfterReady(
      GPU_CONFIG,
      "vllm-local",
      baseOptions({
        verifyDirectSandboxGpu,
        verifyGpuOrExit,
        deps: {
          findContainerIds: () => ["container-abc"],
          dockerCapture: vi.fn(() => inspectWithNetworkMode("host")),
          dockerRun: dockerRunWithCurl({ status: 0 }),
          sleep: vi.fn(),
        },
      }),
    );
    expect(verifyGpuOrExit).toHaveBeenCalledWith(verifyDirectSandboxGpu);
    expect(verifyDirectSandboxGpu).toHaveBeenCalledWith("alpha");
  });

  it("captures the CUDA-usability proof onto the config for status persistence (#4231)", () => {
    const proof = { status: "verified" as const, cudaVerified: true, at: "t" };
    // Fresh config so the assignment does not leak into the shared GPU_CONFIG.
    const config: { sandboxGpuEnabled: boolean; sandboxGpuProof?: typeof proof | null } = {
      sandboxGpuEnabled: true,
    };
    verifyGpuSandboxAfterReady(
      config,
      "vllm-local",
      baseOptions({
        verifyDirectSandboxGpu: vi.fn(() => proof),
        deps: {
          findContainerIds: () => ["container-abc"],
          dockerCapture: vi.fn(() => inspectWithNetworkMode("host")),
          dockerRun: dockerRunWithCurl({ status: 0 }),
          sleep: vi.fn(),
        },
      }),
    );
    expect(config.sandboxGpuProof).toEqual(proof);
  });

  it("does not duplicate proof diagnostics when Docker GPU patch verifier handles them", () => {
    const proofError = new Error("process.exit");
    const verifyGpuOrExit = vi.fn(() => {
      throw proofError;
    });
    const logError = vi.fn();
    expect(() =>
      verifyGpuSandboxAfterReady(
        GPU_CONFIG,
        "ollama-local",
        baseOptions({ verifyGpuOrExit, logError }),
      ),
    ).toThrow(proofError);
    expect(logError).not.toHaveBeenCalled();
  });

  it("routes failure diagnostics through the provided error sink and exits", () => {
    const logError = vi.fn();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    try {
      expect(() =>
        verifyGpuSandboxAfterReady(
          GPU_CONFIG,
          "ollama-local",
          baseOptions({
            logError,
            deps: {
              findContainerIds: () => ["container-xyz"],
              dockerCapture: vi.fn(() => inspectWithNetworkMode("host")),
              dockerRun: dockerRunWithCurl({ status: 7, stderr: "Connection refused" }),
              sleep: vi.fn(),
            },
          }),
        ),
      ).toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining("Local inference reachability check failed"),
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("skips the inference gate when the Docker GPU patch did not recreate the container", () => {
    const findContainerIds = vi.fn(() => ["container-abc"]);
    const verifyDirectSandboxGpu = vi.fn();
    verifyGpuSandboxAfterReady(
      GPU_CONFIG,
      "ollama-local",
      baseOptions({
        useDockerGpuPatch: false,
        verifyDirectSandboxGpu,
        deps: { findContainerIds, dockerCapture: vi.fn(), dockerRun: vi.fn(), sleep: vi.fn() },
      }),
    );
    expect(verifyDirectSandboxGpu).toHaveBeenCalledWith("alpha");
    // No container resolution happens when the patch is not in play.
    expect(findContainerIds).not.toHaveBeenCalled();
  });
});

describe("printDockerGpuHostNetworkInferenceVerificationFailure", () => {
  it("surfaces endpoint, network mode, container id, and recovery hints", () => {
    const lines: string[] = [];
    printDockerGpuHostNetworkInferenceVerificationFailure(
      {
        status: "failed",
        kind: "probe",
        provider: "ollama-local",
        message: "unreachable",
        containerId: "container-xyz",
        networkMode: "host",
        endpoint: "http://127.0.0.1:11434/api/tags",
        detail: "Connection refused",
        recovery: ["do the thing"],
      },
      (line) => lines.push(line),
    );
    const text = lines.join("\n");
    expect(text).toContain("container=container-xyz");
    expect(text).toContain("network_mode=host");
    expect(text).toContain("endpoint=http://127.0.0.1:11434/api/tags");
    expect(text).toContain("Local Ollama");
    expect(text).toContain("do the thing");
  });
});
