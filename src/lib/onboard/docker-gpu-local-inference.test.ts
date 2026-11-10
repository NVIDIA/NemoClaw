// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nativeLocalIdentity, type NativeLocalBinding } from "../inference/native-local/contract";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type GpuSandboxInferenceRoute,
  enforceDockerGpuPatchPreserveNetwork,
  getSandboxRuntimeInferenceEndpoint,
  printDockerGpuSandboxInferenceVerificationFailure,
  shouldSkipGpuBridgeProbe,
  shouldUseDockerGpuPatchHostNetwork,
  verifyDockerGpuSandboxLocalInference,
  verifyGpuSandboxAfterReady,
  verifyGpuSandboxLocalInferenceAndCommitAfterReady,
} from "./docker-gpu-local-inference";

const HOST_NETWORK_ENV = {
  NEMOCLAW_DOCKER_GPU_PATCH: "1",
  NEMOCLAW_DOCKER_GPU_PATCH_NETWORK: "host",
} as NodeJS.ProcessEnv;
const LEGACY_PATCH_ENV = { NEMOCLAW_DOCKER_GPU_PATCH: "1" } as NodeJS.ProcessEnv;
const GPU_CONFIG = { sandboxGpuEnabled: true };

afterEach(() => vi.restoreAllMocks());

function gpuPatchOptions(extra: Record<string, unknown> = {}) {
  return {
    sandboxName: "alpha",
    resolveInferenceRoute: () => ({ kind: "shared" as const }),
    dockerDriverGateway: true,
    selectedRoute: "compatibility" as const,
    platform: "linux" as NodeJS.Platform,
    env: { ...LEGACY_PATCH_ENV },
    ...extra,
  };
}

// The gate runs a single combined script via `openshell sandbox exec` that
// emits either `NO_CURL` or `HTTP_<code>`. This mock answers with `stdout`.
// Typed `(sandboxName, script)` so `.mock.calls[i][1]` (the script) type-checks.
function execEmitting(stdout: string, { status = 0, stderr = "" } = {}) {
  return vi.fn(async (_sandboxName: string, _script: string) => ({ status, stdout, stderr }));
}

const NATIVE_BINDING: NativeLocalBinding = {
  provider: "ollama-local",
  agent: "openclaw",
  endpointUrl: "http://host.openshell.internal:11435/v1",
  gatewayName: "gpu-gateway",
  sandboxName: "alpha",
  authMode: "authenticated",
  credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
};
const NATIVE_ROUTE: GpuSandboxInferenceRoute = {
  kind: "native-local",
  gatewayName: NATIVE_BINDING.gatewayName,
  attachment: {
    ...NATIVE_BINDING,
    ...nativeLocalIdentity(NATIVE_BINDING),
    schemaVersion: 1,
    providerId: "native-provider",
  },
};
const SCOPED_HANDLE = "openshell:resolve:env:v1_NEMOCLAW_LOCAL_INFERENCE_TOKEN";

describe("GPU inference probe script (#14069)", { timeout: 15_000 }, () => {
  async function runScript(
    token: string,
    httpCode = "200",
    curlStatus = 0,
    route: GpuSandboxInferenceRoute = NATIVE_ROUTE,
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-native-probe-"));
    const argsPath = path.join(dir, "curl-args");
    try {
      fs.writeFileSync(
        path.join(dir, "curl"),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$CURL_ARGS"\nprintf "%s" "$HTTP_CODE"\nexit "$CURL_STATUS"\n',
        { mode: 0o755 },
      );
      const execInSandbox = vi.fn(async (_name: string, script: string) => {
        const result = spawnSync("/bin/sh", ["-c", script], {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            PATH: `${dir}:/usr/bin:/bin`,
            NEMOCLAW_LOCAL_INFERENCE_TOKEN: token,
            CURL_ARGS: argsPath,
            HTTP_CODE: httpCode,
            CURL_STATUS: String(curlStatus),
          },
        });
        expect(result.error).toBeUndefined();
        return {
          status: result.status ?? 1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      });
      const sleep = vi.fn();
      const result = await verifyDockerGpuSandboxLocalInference(GPU_CONFIG, "ollama-local", {
        ...gpuPatchOptions(),
        resolveInferenceRoute: () => route,
        deps: { execInSandbox, sleep },
      });
      const attempts = route.kind === "shared" && result.status === "failed" ? 3 : 1;
      expect(execInSandbox).toHaveBeenCalledTimes(attempts);
      expect(sleep).toHaveBeenCalledTimes(attempts - 1);
      return { result, args: fs.existsSync(argsPath) ? fs.readFileSync(argsPath, "utf8") : null };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each([
    SCOPED_HANDLE,
    `openshell:resolve:env:s${"a".repeat(64)}_NEMOCLAW_LOCAL_INFERENCE_TOKEN`,
  ])("uses an opaque scoped handle to verify the selected endpoint", async (handle) => {
    const { result, args } = await runScript(handle);
    expect(result).toMatchObject({
      status: "ok",
      endpoint: `${NATIVE_BINDING.endpointUrl}/models`,
      httpCode: "200",
    });
    expect(args?.split("\n")).toEqual([
      "-q",
      "-so",
      "/dev/null",
      "-w",
      "%{http_code}",
      "-H",
      `Authorization: Bearer ${handle}`,
      "--connect-timeout",
      "5",
      "--max-time",
      "10",
      `${NATIVE_BINDING.endpointUrl}/models`,
      "",
    ]);
    expect(JSON.stringify(result)).not.toContain(handle);
  });

  it.each([
    "",
    "raw-test-secret",
    "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
    `${SCOPED_HANDLE}\nraw-test-secret`,
    `${SCOPED_HANDLE}; echo unsafe`,
  ])("rejects missing, raw, and malformed credentials before making a request", async (token) => {
    const { result, args } = await runScript(token);
    expect(result).toMatchObject({
      status: "failed",
      kind: "unreachable",
      endpoint: `${NATIVE_BINDING.endpointUrl}/models`,
      recovery: expect.arrayContaining([
        "Re-run onboarding after restoring native endpoint access and scoped credentials.",
      ]),
    });
    expect(JSON.stringify(result)).not.toContain("sandbox runtime exec path did not respond");
    expect(args).toBeNull();
    expect(JSON.stringify(result)).not.toContain("raw-test-secret");
  });

  it.each(["401", "403", "503", "000", "200\nHTTP_200"])(
    "rejects unusable HTTP or malformed responses without shared fallback",
    async (code) => {
      const { result, args } = await runScript(SCOPED_HANDLE, code);
      expect(result.status).toBe("failed");
      expect(args).not.toContain("inference.local");
      expect(JSON.stringify(result)).not.toContain("inference set");
    },
  );

  it.each([
    { httpCode: "000", curlStatus: 6 },
    { httpCode: "", curlStatus: 7 },
    { httpCode: "000", curlStatus: 28 },
    { httpCode: "200", curlStatus: 28 },
  ])("reports native curl failures with endpoint recovery and no retry", async (failure) => {
    const { result, args } = await runScript(SCOPED_HANDLE, failure.httpCode, failure.curlStatus);
    expect(result).toMatchObject({
      status: "failed",
      kind: "unreachable",
      endpoint: `${NATIVE_BINDING.endpointUrl}/models`,
      recovery: expect.arrayContaining([
        "Check the selected local backend and its recorded native provider attachment.",
        "Do not configure shared inference as a fallback for this native route.",
      ]),
    });
    expect(JSON.stringify(result)).not.toContain("sandbox runtime exec path did not respond");
    expect(JSON.stringify(result)).not.toContain(SCOPED_HANDLE);
    expect(args).not.toContain("inference.local");
  });

  it("reports a native sandbox exec timeout without inferring an endpoint response", async () => {
    const execInSandbox = vi.fn(async () => null);
    const sleep = vi.fn();
    const result = await verifyDockerGpuSandboxLocalInference(GPU_CONFIG, "ollama-local", {
      ...gpuPatchOptions(),
      resolveInferenceRoute: () => NATIVE_ROUTE,
      deps: { execInSandbox, sleep },
    });
    expect(result).toMatchObject({ status: "failed", kind: "exec" });
    expect(execInSandbox).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    { httpCode: "000", curlStatus: 6 },
    { httpCode: "", curlStatus: 7 },
    { httpCode: "000", curlStatus: 28 },
    { httpCode: "200", curlStatus: 28 },
  ])("reports shared-route curl failures as unreachable after bounded retries", async (failure) => {
    const { result, args } = await runScript("", failure.httpCode, failure.curlStatus, {
      kind: "shared",
    });
    expect(result).toMatchObject({
      status: "failed",
      kind: "unreachable",
      endpoint: "https://inference.local/v1/models",
      recovery: expect.arrayContaining([
        "Check the sandbox can reach inference.local (proxy/router up):",
      ]),
    });
    expect(JSON.stringify(result)).not.toContain("sandbox runtime exec path did not respond");
    expect(args).not.toContain("Authorization:");
  });

  it.each([
    { status: 1, stdout: "HTTP_200", stderr: "raw-test-secret" },
    { status: 1, stdout: "NO_CURL", stderr: "raw-test-secret" },
    { status: 0, stdout: "noise HTTP_200", stderr: "raw-test-secret" },
    { status: 0, stdout: "HTTP_200\nHTTP_503", stderr: "raw-test-secret" },
    { status: 0, stdout: "NATIVE_INFERENCE_PROBE_FAILED", stderr: "raw-test-secret" },
    { status: 1, stdout: "NATIVE_INFERENCE_PROBE_FAILED\nHTTP_200", stderr: "raw-test-secret" },
  ])("rejects misleading exec output without disclosing it", async (response) => {
    const result = await verifyDockerGpuSandboxLocalInference(GPU_CONFIG, "ollama-local", {
      ...gpuPatchOptions(),
      resolveInferenceRoute: () => NATIVE_ROUTE,
      deps: { execInSandbox: vi.fn(async () => response), sleep: vi.fn() },
    });
    expect(result).toMatchObject({ status: "failed", kind: "exec" });
    expect(JSON.stringify(result)).not.toContain("raw-test-secret");
  });
});

describe("shouldUseDockerGpuPatchHostNetwork", () => {
  it("is true only on the Linux Docker-driver host-network path", () => {
    expect(
      shouldUseDockerGpuPatchHostNetwork(GPU_CONFIG, {
        dockerDriverGateway: true,
        selectedRoute: "compatibility",
        platform: "linux",
        env: HOST_NETWORK_ENV,
      }),
    ).toBe(true);
    // Default (preserve) network mode.
    expect(
      shouldUseDockerGpuPatchHostNetwork(GPU_CONFIG, {
        dockerDriverGateway: true,
        selectedRoute: "compatibility",
        platform: "linux",
        env: {},
      }),
    ).toBe(false);
    // Not linux.
    expect(
      shouldUseDockerGpuPatchHostNetwork(GPU_CONFIG, {
        dockerDriverGateway: true,
        selectedRoute: "compatibility",
        platform: "darwin",
        env: HOST_NETWORK_ENV,
      }),
    ).toBe(false);
  });
});

describe("shouldSkipGpuBridgeProbe", () => {
  it("forces the gateway context and skips only for an active legacy host-network patch", () => {
    expect(
      shouldSkipGpuBridgeProbe(true, "linux", "compatibility", {
        dockerDriverGateway: false,
        env: HOST_NETWORK_ENV,
        platform: "linux",
      }),
    ).toBe(true);
    expect(
      shouldSkipGpuBridgeProbe(false, "linux", "compatibility", {
        env: HOST_NETWORK_ENV,
        platform: "linux",
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
      selectedRoute: "compatibility",
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
        selectedRoute: "compatibility",
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
        selectedRoute: "compatibility",
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
          selectedRoute: "compatibility",
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
    expect(getSandboxRuntimeInferenceEndpoint("ollama-local", { kind: "shared" })).toBe(
      "https://inference.local/v1/models",
    );
    expect(getSandboxRuntimeInferenceEndpoint("vllm-local", { kind: "shared" })).toBe(
      "https://inference.local/v1/models",
    );
    expect(getSandboxRuntimeInferenceEndpoint("build", { kind: "shared" })).toBeNull();
  });
});

describe("verifyDockerGpuSandboxLocalInference", () => {
  it("skips for non-local providers", async () => {
    const result = await verifyDockerGpuSandboxLocalInference(
      GPU_CONFIG,
      "build",
      gpuPatchOptions(),
    );
    expect(result).toEqual({ status: "skipped", reason: "not-local-provider" });
  });

  it("skips the compatibility-only inference gate on the native route", async () => {
    const execInSandbox = vi.fn();
    const result = await verifyDockerGpuSandboxLocalInference(
      GPU_CONFIG,
      "ollama-local",
      gpuPatchOptions({ selectedRoute: "native", deps: { execInSandbox } }),
    );

    expect(result).toEqual({ status: "skipped", reason: "not-docker-gpu-patch" });
    expect(execInSandbox).not.toHaveBeenCalled();
  });

  it("probes inference.local from the runtime context, never a loopback or docker exec", async () => {
    const execInSandbox = execEmitting("HTTP_200");
    const result = await verifyDockerGpuSandboxLocalInference(
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

  it("fails on a 4xx because the route is reached but unusable instead of satisfying the proof (#4509)", async () => {
    const result = await verifyDockerGpuSandboxLocalInference(
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

  it("fails as unreachable and retries on HTTP 000 (#4509)", async () => {
    const execInSandbox = execEmitting("HTTP_000");
    const sleep = vi.fn();
    const result = await verifyDockerGpuSandboxLocalInference(
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

    expect(sleep).toHaveBeenNthCalledWith(1, 2_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000);
  });

  it("fails when the inference route is up but the local backend errors (HTTP 502)", async () => {
    const result = await verifyDockerGpuSandboxLocalInference(
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

  it("soft-skips when the sandbox image genuinely lacks curl (custom --from base)", async () => {
    const log = vi.fn();
    const result = await verifyDockerGpuSandboxLocalInference(
      GPU_CONFIG,
      "ollama-local",
      gpuPatchOptions({ log, deps: { execInSandbox: execEmitting("NO_CURL"), sleep: vi.fn() } }),
    );
    expect(result).toEqual({ status: "skipped", reason: "probe-tool-unavailable" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("curl is not available"));
  });

  it("fails (exec) — not soft-skip — when sandbox exec cannot run", async () => {
    const result = await verifyDockerGpuSandboxLocalInference(
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

  it("fails (exec) when exec runs but emits no sentinel (sandbox Error / exec denied)", async () => {
    const result = await verifyDockerGpuSandboxLocalInference(
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
      expect(result.detail).toContain("credential or transport error");
    }
  });
});

describe("verifyGpuSandboxAfterReady", () => {
  function baseOptions(extra: Record<string, unknown> = {}) {
    return {
      sandboxName: "alpha",
      resolveInferenceRoute: () => ({ kind: "shared" as const }),
      dockerDriverGateway: true,
      selectedRoute: "compatibility" as const,
      platform: "linux" as NodeJS.Platform,
      env: { ...LEGACY_PATCH_ENV },
      verifyDirectSandboxGpu: vi.fn(),
      selectedMode: () => null,
      runCaptureOpenshell: vi.fn(() => ""),
      log: vi.fn(),
      ...extra,
    };
  }

  it("runs the GPU proof and the runtime inference gate when the patch is active", async () => {
    const log = vi.fn();
    const verifyDirectSandboxGpu = vi.fn();
    await verifyGpuSandboxAfterReady(
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

  it("captures the CUDA-usability proof onto the config for status persistence (#4231)", async () => {
    const proof = { status: "verified" as const, cudaVerified: true, at: "t" };
    const config: { sandboxGpuEnabled: boolean; sandboxGpuProof?: typeof proof | null } = {
      sandboxGpuEnabled: true,
    };
    await verifyGpuSandboxAfterReady(
      config,
      "vllm-local",
      baseOptions({
        verifyDirectSandboxGpu: vi.fn(() => proof),
        deps: { execInSandbox: execEmitting("HTTP_200"), sleep: vi.fn() },
      }),
    );
    expect(config.sandboxGpuProof).toEqual(proof);
  });

  it("does not duplicate proof diagnostics when Docker GPU patch verifier handles them", async () => {
    const proofError = new Error("process.exit");
    const verifyGpuOrExit = vi.fn(() => {
      throw proofError;
    });
    const logError = vi.fn();
    await expect(
      verifyGpuSandboxAfterReady(
        GPU_CONFIG,
        "ollama-local",
        baseOptions({ verifyGpuOrExit, logError }),
      ),
    ).rejects.toBe(proofError);
    expect(logError).not.toHaveBeenCalled();
  });

  it("threads typed OpenShell diagnostics into the direct GPU proof failure path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gpu-proof-diagnostics-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const collect = vi.fn(() => []);
    const proofError = new Error("GPU proof failed");
    try {
      await expect(
        verifyGpuSandboxAfterReady(
          GPU_CONFIG,
          "ollama-local",
          baseOptions({
            verifyDirectSandboxGpu: vi.fn(() => {
              throw proofError;
            }),
            openShellGpuDiagnostics: { collect },
            dockerCapture: vi.fn(() => ""),
          }),
        ),
      ).rejects.toBe(proofError);
      expect(collect).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxName: "alpha", timeoutMs: 30_000 }),
      );
    } finally {
      fs.rmSync(tmpDir, { force: true, recursive: true });
    }
  });

  it("routes failure diagnostics through the provided error sink and throws for rollback", async () => {
    const logError = vi.fn();
    await expect(
      verifyGpuSandboxAfterReady(
        GPU_CONFIG,
        "ollama-local",
        baseOptions({
          logError,
          deps: { execInSandbox: execEmitting("HTTP_000"), sleep: vi.fn() },
        }),
      ),
    ).rejects.toThrow("GPU sandbox local inference reachability failed");
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("Local inference reachability check failed"),
    );
  });
});

describe("verifyGpuSandboxLocalInferenceAndCommitAfterReady", () => {
  function options() {
    return {
      ...gpuPatchOptions(),
      verifyDirectSandboxGpu: vi.fn(),
      runCaptureOpenshell: vi.fn(() => ""),
      log: vi.fn(),
    };
  }

  it("commits only after local-inference reachability returns HTTP 2xx", async () => {
    const events: string[] = [];
    const runtimePatch = {
      commitAfterReady: vi.fn(
        async (commitOptions?: {
          readonly beforeFinalHandoff?: (replacementRuntimeId: string | null) => void;
        }) => {
          commitOptions?.beforeFinalHandoff?.("b".repeat(64));
          events.push("commit-complete");
        },
      ),
      rollbackManagedStartupAfterCreateFailure: vi.fn(),
    };
    const persistFinalHandoffCommitStarted = vi.fn(() => events.push("commit-fence"));
    const persistFinalHandoffAcknowledgement = vi.fn(() => events.push("acknowledgement"));
    await verifyGpuSandboxLocalInferenceAndCommitAfterReady(
      GPU_CONFIG,
      "ollama-local",
      {
        ...options(),
        deps: { execInSandbox: execEmitting("HTTP_200"), sleep: vi.fn() },
      },
      runtimePatch,
      undefined,
      persistFinalHandoffCommitStarted,
      persistFinalHandoffAcknowledgement,
    );
    expect(runtimePatch.commitAfterReady).toHaveBeenCalledOnce();
    expect(persistFinalHandoffCommitStarted).toHaveBeenCalledOnce();
    expect(persistFinalHandoffAcknowledgement).toHaveBeenCalledOnce();
    expect(events).toEqual(["commit-fence", "commit-complete", "acknowledgement"]);
    expect(runtimePatch.rollbackManagedStartupAfterCreateFailure).not.toHaveBeenCalled();
  });

  it("rolls back before propagating an inference verification failure", async () => {
    const runtimePatch = {
      commitAfterReady: vi.fn(),
      rollbackManagedStartupAfterCreateFailure: vi.fn(),
    };
    await expect(
      verifyGpuSandboxLocalInferenceAndCommitAfterReady(
        GPU_CONFIG,
        "ollama-local",
        {
          ...options(),
          deps: { execInSandbox: execEmitting("HTTP_000"), sleep: vi.fn() },
        },
        runtimePatch,
      ),
    ).rejects.toThrow("GPU sandbox local inference reachability failed");
    expect(runtimePatch.rollbackManagedStartupAfterCreateFailure).toHaveBeenCalledOnce();
    expect(runtimePatch.commitAfterReady).not.toHaveBeenCalled();
  });

  it("redacts and retains a local inference rollback failure", async () => {
    const secret = `nvapi-${"f".repeat(60)}`;
    const rollbackError = new Error(`Rollback failed: ${secret}`);
    rollbackError.stack = `Rollback stack: ${secret}`;
    const runtimePatch = {
      commitAfterReady: vi.fn(),
      rollbackManagedStartupAfterCreateFailure: vi.fn(async () => {
        throw rollbackError;
      }),
    };

    const failure = await verifyGpuSandboxLocalInferenceAndCommitAfterReady(
      GPU_CONFIG,
      "ollama-local",
      {
        ...options(),
        deps: { execInSandbox: execEmitting("HTTP_000"), sleep: vi.fn() },
      },
      runtimePatch,
    ).then(
      () => {
        throw new Error("Expected local inference verification to fail.");
      },
      (error: unknown) => error as Error & { runtimeRollbackError?: unknown },
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain(
      "Runtime rollback requires attention: Rollback failed: <REDACTED>",
    );
    expect(failure.message).not.toContain(secret);
    expect(failure.runtimeRollbackError).toBe(rollbackError);
    expect(rollbackError.message).toBe("Rollback failed: <REDACTED>");
    expect(rollbackError.stack).not.toContain(secret);
    expect(rollbackError.stack).toContain("<REDACTED>");
    expect(runtimePatch.rollbackManagedStartupAfterCreateFailure).toHaveBeenCalledOnce();
    expect(runtimePatch.commitAfterReady).not.toHaveBeenCalled();
  });

  it("treats a failed commit as terminal without attempting rollback", async () => {
    const runtimePatch = {
      commitAfterReady: vi.fn(
        async (commitOptions?: {
          readonly beforeFinalHandoff?: (replacementRuntimeId: string | null) => void;
        }) => {
          commitOptions?.beforeFinalHandoff?.("b".repeat(64));
          throw new Error("durable commit acknowledgement failed");
        },
      ),
      rollbackManagedStartupAfterCreateFailure: vi.fn(),
    };
    const persistFinalHandoffCommitStarted = vi.fn();
    const persistFinalHandoffAcknowledgement = vi.fn();
    await expect(
      verifyGpuSandboxLocalInferenceAndCommitAfterReady(
        GPU_CONFIG,
        "ollama-local",
        {
          ...options(),
          deps: { execInSandbox: execEmitting("HTTP_200"), sleep: vi.fn() },
        },
        runtimePatch,
        undefined,
        persistFinalHandoffCommitStarted,
        persistFinalHandoffAcknowledgement,
      ),
    ).rejects.toThrow("durable commit acknowledgement failed");
    expect(runtimePatch.rollbackManagedStartupAfterCreateFailure).not.toHaveBeenCalled();
    expect(persistFinalHandoffCommitStarted).toHaveBeenCalledOnce();
    expect(persistFinalHandoffAcknowledgement).not.toHaveBeenCalled();
  });

  it("rechecks sandbox identity after verification and before GPU commit (#9833)", async () => {
    const runtimePatch = {
      commitAfterReady: vi.fn(),
      rollbackManagedStartupAfterCreateFailure: vi.fn(),
    };
    const log = vi.fn();

    await expect(
      verifyGpuSandboxLocalInferenceAndCommitAfterReady(
        GPU_CONFIG,
        "ollama-local",
        {
          ...options(),
          log,
          deps: { execInSandbox: execEmitting("HTTP_200"), sleep: vi.fn() },
        },
        runtimePatch,
        () => {
          throw new Error("sandbox identity changed");
        },
      ),
    ).rejects.toThrow("sandbox identity changed");

    expect(runtimePatch.commitAfterReady).not.toHaveBeenCalled();
    expect(runtimePatch.rollbackManagedStartupAfterCreateFailure).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("reached local inference"));
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
