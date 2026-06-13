// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  enforceDockerGpuPatchPreserveNetwork,
  getSandboxRuntimeInferenceEndpoint,
  printDockerGpuSandboxInferenceVerificationFailure,
  shouldUseDockerGpuPatchHostNetwork,
  verifyDockerGpuSandboxLocalInference,
  verifyGpuSandboxAfterReady,
} from "../../../dist/lib/onboard/docker-gpu-local-inference";

const HOST_NETWORK_ENV = { NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host" } as NodeJS.ProcessEnv;
const GPU_CONFIG = { sandboxGpuEnabled: true };

function gpuPatchOptions(extra: Record<string, unknown> = {}) {
  return {
    sandboxName: "alpha",
    dockerDriverGateway: true,
    platform: "linux" as NodeJS.Platform,
    env: {} as NodeJS.ProcessEnv,
    ...extra,
  };
}

// The gate runs a single combined script via `openshell sandbox exec` that
// emits either `NO_CURL` or `HTTP_<code>`. This mock answers with `stdout`.
// Typed `(sandboxName, script)` so `.mock.calls[i][1]` (the script) type-checks.
function execEmitting(stdout: string, { status = 0, stderr = "" } = {}) {
  return vi.fn((_sandboxName: string, _script: string) => ({ status, stdout, stderr }));
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
    // Default (preserve) network mode.
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

describe("enforceDockerGpuPatchPreserveNetwork", () => {
  it("downgrades a LOCAL provider to preserve and re-checks the bridge (#4509)", async () => {
    const env = { ...HOST_NETWORK_ENV };
    const log = vi.fn();
    const reverifyBridgeReachability = vi.fn();
    const downgraded = await enforceDockerGpuPatchPreserveNetwork("ollama-local", GPU_CONFIG, {
      dockerDriverGateway: true,
      platform: "linux",
      env,
      log,
      reverifyBridgeReachability,
    });
    expect(downgraded).toBe(true);
    expect(env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK).toBe("preserve");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("OpenShell bridge networking"));
    // The bridge reachability probe is re-run now that we are committed to it.
    expect(reverifyBridgeReachability).toHaveBeenCalledTimes(1);
  });

  it("leaves host networking untouched for NON-local providers (cloud/routed/custom)", async () => {
    const env = { ...HOST_NETWORK_ENV };
    const reverifyBridgeReachability = vi.fn();
    expect(
      await enforceDockerGpuPatchPreserveNetwork("nvidia", GPU_CONFIG, {
        dockerDriverGateway: true,
        platform: "linux",
        env,
        reverifyBridgeReachability,
      }),
    ).toBe(false);
    expect(env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK).toBe("host");
    expect(reverifyBridgeReachability).not.toHaveBeenCalled();
  });

  it("is a no-op when host networking was not requested", async () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(
      await enforceDockerGpuPatchPreserveNetwork("ollama-local", GPU_CONFIG, {
        dockerDriverGateway: true,
        platform: "linux",
        env,
        reverifyBridgeReachability: vi.fn(),
      }),
    ).toBe(false);
    expect(env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK).toBeUndefined();
  });

  it("is a no-op when the GPU patch does not apply (no sandbox GPU)", async () => {
    const env = { ...HOST_NETWORK_ENV };
    expect(
      await enforceDockerGpuPatchPreserveNetwork(
        "ollama-local",
        { sandboxGpuEnabled: false },
        {
          dockerDriverGateway: true,
          platform: "linux",
          env,
          reverifyBridgeReachability: vi.fn(),
        },
      ),
    ).toBe(false);
    expect(env.NEMOCLAW_DOCKER_GPU_PATCH_NETWORK).toBe("host");
  });
});

describe("getSandboxRuntimeInferenceEndpoint", () => {
  it("uses the OpenShell inference route, not a host loopback or gateway alias", () => {
    expect(getSandboxRuntimeInferenceEndpoint("ollama-local")).toBe(
      "https://inference.local/v1/models",
    );
    expect(getSandboxRuntimeInferenceEndpoint("vllm-local")).toBe(
      "https://inference.local/v1/models",
    );
    expect(getSandboxRuntimeInferenceEndpoint("build")).toBeNull();
  });
});

describe("verifyDockerGpuSandboxLocalInference", () => {
  it("skips when the Docker GPU patch is not active", () => {
    const result = verifyDockerGpuSandboxLocalInference(
      GPU_CONFIG,
      "ollama-local",
      gpuPatchOptions({ env: { NEMOCLAW_DOCKER_GPU_PATCH: "0" } }),
    );
    expect(result).toEqual({ status: "skipped", reason: "not-docker-gpu-patch" });
  });

  it("skips for non-local providers", () => {
    const result = verifyDockerGpuSandboxLocalInference(GPU_CONFIG, "build", gpuPatchOptions());
    expect(result).toEqual({ status: "skipped", reason: "not-local-provider" });
  });

  it("probes inference.local from the runtime context, never a loopback or docker exec", () => {
    const execInSandbox = execEmitting("HTTP_200");
    const result = verifyDockerGpuSandboxLocalInference(
      GPU_CONFIG,
      "vllm-local",
      gpuPatchOptions({ deps: { execInSandbox, sleep: vi.fn() } }),
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.httpCode).toBe("200");
      expect(result.endpoint).toBe("https://inference.local/v1/models");
    }
    expect(execInSandbox).toHaveBeenCalledWith("alpha", expect.any(String));
    const script = execInSandbox.mock.calls[0][1];
    expect(script).toContain("command -v curl");
    expect(script).toContain("inference.local");
    expect(script).toContain("%{http_code}");
    expect(script).not.toContain("127.0.0.1");
    expect(script).not.toContain("docker exec");
  });

  it("fails on a 4xx — route reached but not usable (auth/route misconfig), not the #4509 proof", () => {
    const result = verifyDockerGpuSandboxLocalInference(
      GPU_CONFIG,
      "ollama-local",
      gpuPatchOptions({ deps: { execInSandbox: execEmitting("HTTP_404"), sleep: vi.fn() } }),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.kind).toBe("unreachable");
      expect(result.detail).toContain("404");
    }
  });

  it("fails (unreachable) and retries on HTTP 000 — the #4509 regression", () => {
    const execInSandbox = execEmitting("HTTP_000");
    const sleep = vi.fn();
    const result = verifyDockerGpuSandboxLocalInference(
      GPU_CONFIG,
      "ollama-local",
      gpuPatchOptions({ deps: { execInSandbox, sleep } }),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.kind).toBe("unreachable");
      expect(result.detail).toContain("HTTP 000");
      expect(result.endpoint).toBe("https://inference.local/v1/models");
      expect(result.recovery.length).toBeGreaterThan(0);
    }
    expect(execInSandbox).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("fails when the inference route is up but the local backend errors (HTTP 502)", () => {
    const result = verifyDockerGpuSandboxLocalInference(
      GPU_CONFIG,
      "ollama-local",
      gpuPatchOptions({ deps: { execInSandbox: execEmitting("HTTP_502"), sleep: vi.fn() } }),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.kind).toBe("unreachable");
      expect(result.detail).toContain("502");
    }
  });

  it("soft-skips when the sandbox image genuinely lacks curl (custom --from base)", () => {
    const log = vi.fn();
    const result = verifyDockerGpuSandboxLocalInference(
      GPU_CONFIG,
      "ollama-local",
      gpuPatchOptions({ log, deps: { execInSandbox: execEmitting("NO_CURL"), sleep: vi.fn() } }),
    );
    expect(result).toEqual({ status: "skipped", reason: "probe-tool-unavailable" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("curl is not available"));
  });

  it("fails (exec) — not soft-skip — when sandbox exec cannot run", () => {
    const result = verifyDockerGpuSandboxLocalInference(
      GPU_CONFIG,
      "ollama-local",
      gpuPatchOptions({ deps: { execInSandbox: vi.fn(() => null), sleep: vi.fn() } }),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.kind).toBe("exec");
      expect(result.detail).toContain("did not run");
    }
  });

  it("fails (exec) when exec runs but emits no sentinel (sandbox Error / exec denied)", () => {
    const result = verifyDockerGpuSandboxLocalInference(
      GPU_CONFIG,
      "ollama-local",
      gpuPatchOptions({
        deps: {
          execInSandbox: execEmitting("", { status: 1, stderr: "exec denied" }),
          sleep: vi.fn(),
        },
      }),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.kind).toBe("exec");
      expect(result.detail).toContain("exec denied");
    }
  });
});

describe("verifyGpuSandboxAfterReady", () => {
  function baseOptions(extra: Record<string, unknown> = {}) {
    return {
      sandboxName: "alpha",
      dockerDriverGateway: true,
      platform: "linux" as NodeJS.Platform,
      env: {} as NodeJS.ProcessEnv,
      useDockerGpuPatch: true,
      verifyDirectSandboxGpu: vi.fn(),
      selectedMode: () => null,
      runCaptureOpenshell: vi.fn(() => ""),
      log: vi.fn(),
      ...extra,
    };
  }

  it("runs the GPU proof and the runtime inference gate when the patch is active", () => {
    const log = vi.fn();
    const verifyDirectSandboxGpu = vi.fn();
    verifyGpuSandboxAfterReady(
      GPU_CONFIG,
      "vllm-local",
      baseOptions({
        verifyDirectSandboxGpu,
        log,
        deps: { execInSandbox: execEmitting("HTTP_200"), sleep: vi.fn() },
      }),
    );
    expect(verifyDirectSandboxGpu).toHaveBeenCalledWith("alpha");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("reached local inference"));
  });

  it("captures the CUDA-usability proof onto the config for status persistence (#4231)", () => {
    const proof = { status: "verified" as const, cudaVerified: true, at: "t" };
    const config: { sandboxGpuEnabled: boolean; sandboxGpuProof?: typeof proof | null } = {
      sandboxGpuEnabled: true,
    };
    verifyGpuSandboxAfterReady(
      config,
      "vllm-local",
      baseOptions({
        verifyDirectSandboxGpu: vi.fn(() => proof),
        deps: { execInSandbox: execEmitting("HTTP_200"), sleep: vi.fn() },
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
            deps: { execInSandbox: execEmitting("HTTP_000"), sleep: vi.fn() },
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

  it("skips the inference gate when the Docker GPU patch did not run", () => {
    const execInSandbox = vi.fn();
    const verifyDirectSandboxGpu = vi.fn();
    verifyGpuSandboxAfterReady(
      GPU_CONFIG,
      "ollama-local",
      baseOptions({
        useDockerGpuPatch: false,
        verifyDirectSandboxGpu,
        deps: { execInSandbox, sleep: vi.fn() },
      }),
    );
    expect(verifyDirectSandboxGpu).toHaveBeenCalledWith("alpha");
    expect(execInSandbox).not.toHaveBeenCalled();
  });
});

describe("printDockerGpuSandboxInferenceVerificationFailure", () => {
  it("surfaces endpoint, provider label, detail, and recovery hints", () => {
    const lines: string[] = [];
    printDockerGpuSandboxInferenceVerificationFailure(
      {
        status: "failed",
        kind: "unreachable",
        provider: "ollama-local",
        endpoint: "https://inference.local/v1/models",
        message: "unreachable",
        detail: "returned HTTP 000",
        recovery: ["do the thing"],
      },
      (line) => lines.push(line),
    );
    const text = lines.join("\n");
    expect(text).toContain("endpoint=https://inference.local/v1/models");
    expect(text).toContain("Local Ollama");
    expect(text).toContain("HTTP 000");
    expect(text).toContain("do the thing");
  });
});
