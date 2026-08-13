// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ preparePortableExperimentalHost: vi.fn() }));

vi.mock("./experimental/portable-host-preparation", () => ({
  preparePortableExperimentalHost: mocks.preparePortableExperimentalHost,
}));

import type { DetectGpuDeps, GpuDetection } from "../inference/nim";
import type { GatewayReadinessProjection } from "../readiness/gateway";
import type { SystemReadinessReport } from "../readiness/types";
import { isLinuxDockerDriverGatewayEnabled } from "./docker-driver-platform";
import {
  assertOnboardGatewayReadiness,
  assertOnboardHostReadiness,
  assertOnboardSystemReadiness,
  runFatalOnboardRuntimePreflight,
  runOnboardRuntimeEffectfulPreflightChecks,
  runReadinessGatedRuntimePreflight,
} from "./fatal-runtime-preflight";
import type { HostAssessment } from "./preflight";

function hostWithRuntime(runtime: HostAssessment["runtime"]): HostAssessment {
  return {
    platform: "linux",
    isWsl: false,
    runtime,
    dockerInstalled: true,
    dockerRunning: true,
    dockerReachable: true,
    nodeInstalled: true,
    openshellInstalled: true,
    isContainerRuntimeUnderProvisioned: false,
    hasNestedOverlayConflict: false,
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: runtime === "podman",
    isHeadlessLikely: false,
    hasNvidiaGpu: false,
    dockerCdiSpecDirs: [],
    cdiNvidiaGpuSpecMissing: false,
    nvidiaContainerToolkitInstalled: false,
    notes: [],
  };
}

function hostWithMissingGpuIntegration(): HostAssessment {
  return {
    ...hostWithRuntime("docker"),
    hasNvidiaGpu: true,
    dockerCdiSpecDirs: ["/etc/cdi"],
    cdiNvidiaGpuSpecMissing: true,
    cdiNvidiaGpuSpecStale: false,
    cdiNvidiaGpuSpecNeedsRepair: true,
    nvidiaContainerToolkitInstalled: false,
  };
}

function wslDockerDesktopHost(): HostAssessment {
  return {
    ...hostWithRuntime("docker-desktop"),
    isWsl: true,
    hasNvidiaGpu: true,
    nvidiaContainerToolkitInstalled: false,
  };
}

function managedGatewayReadiness(
  overrides: Partial<GatewayReadinessProjection> = {},
): GatewayReadinessProjection {
  return {
    observations: [{ id: "gateway.management.mode", state: "present", value: "nemoclaw-managed" }],
    capabilities: [
      { id: "gateway.authority.resolved", state: "present" },
      { id: "gateway.attachment.valid", state: "present" },
      { id: "gateway.reuse.ready", state: "present" },
      { id: "gateway.version.compatible", state: "present" },
      { id: "gateway.port.uncontested", state: "present" },
    ],
    findings: [],
    evidence: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("report-backed runtime readiness (#7411)", () => {
  it("requires explicit managed-vLLM intent for the Deferred N1x readiness exception (#8574)", () => {
    const readiness: SystemReadinessReport = {
      schemaVersion: "1.1.0",
      status: "incompatible",
      exitCode: 2,
      mutated: false,
      provenance: {
        nemoclawVersion: "0.1.0",
        sourceRevision: "a".repeat(40),
        observedAt: "2026-08-12T00:00:00.000Z",
      },
      observations: [],
      capabilities: [
        { id: "host.docker.available", state: "present" },
        { id: "host.docker.daemon_reachable", state: "present" },
        { id: "host.docker.runtime_supported", state: "present" },
        { id: "host.docker.storage_compatible", state: "present" },
        { id: "host.docker.storage_remediation_available", state: "absent" },
        { id: "host.gpu.nvidia_available", state: "present" },
        { id: "host.gpu.container_toolkit_available", state: "present" },
        { id: "host.gpu.cdi_healthy", state: "present" },
        { id: "host.platform.supported", state: "absent" },
        { id: "host.platform.n1x", state: "present" },
      ],
      qualifications: [],
      findings: [
        {
          id: "host.platform.n1x_validation_pending",
          severity: "blocking",
          summary: "N1x validation is pending.",
        },
      ],
      evidence: [],
    };
    const exit = vi.fn(() => {
      throw new Error("exit");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() =>
      assertOnboardSystemReadiness(readiness, hostWithRuntime("docker"), {
        explicitlyOptedOutGpuPassthrough: false,
        exitProcess: exit as never,
      }),
    ).toThrow("exit");

    vi.stubEnv("NEMOCLAW_PROVIDER", "install-vllm");
    expect(
      assertOnboardSystemReadiness(readiness, hostWithRuntime("docker"), {
        explicitlyOptedOutGpuPassthrough: false,
        exitProcess: exit as never,
      }),
    ).toBe(readiness);
  });

  it("rejects ambiguous gateway ownership before the caller can run effects", () => {
    const exit = vi.fn(() => {
      throw new Error("exit");
    });
    const gateway: GatewayReadinessProjection = {
      observations: [],
      capabilities: [
        { id: "gateway.authority.resolved", state: "present" },
        { id: "gateway.attachment.valid", state: "absent" },
        { id: "gateway.reuse.ready", state: "present" },
        { id: "gateway.version.compatible", state: "present" },
        { id: "gateway.port.uncontested", state: "absent" },
      ],
      findings: [
        {
          id: "gateway.ownership.multiple",
          severity: "blocking",
          summary: "Multiple gateway owners were observed.",
        },
      ],
      evidence: [
        {
          id: "gateway.attachment.failure",
          summary: "Stop the competing listener on port 8080 and retry.",
        },
      ],
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => assertOnboardGatewayReadiness(gateway, exit as never)).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith("  Stop the competing listener on port 8080 and retry.");
  });

  it("preserves actionable managed port evidence at the readiness gate", () => {
    const exit = vi.fn(() => {
      throw new Error("exit");
    });
    const gateway = managedGatewayReadiness({
      capabilities: [
        { id: "gateway.authority.resolved", state: "present" },
        { id: "gateway.attachment.valid", state: "present" },
        { id: "gateway.reuse.ready", state: "present" },
        { id: "gateway.version.compatible", state: "present" },
        { id: "gateway.port.uncontested", state: "absent" },
      ],
      findings: [
        {
          id: "gateway.port.owner_mismatch",
          severity: "blocking",
          summary: "The gateway port has an incompatible owner.",
          evidenceIds: ["gateway.port.conflict"],
        },
      ],
      evidence: [
        {
          id: "gateway.port.conflict",
          summary: "Inspect port 8080 and stop only its owning process before retrying.",
        },
      ],
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => assertOnboardGatewayReadiness(gateway, exit as never)).toThrow("exit");
    expect(error).toHaveBeenCalledWith(
      "  Inspect port 8080 and stop only its owning process before retrying.",
    );
  });

  // The Docker-driver gateway path is forced on Linux and Apple Silicon macOS;
  // the reject gate only fires there. Gate the test on the same predicate via
  // it.skipIf (not an in-body `if`) so it runs on the Linux CI runner.
  it.skipIf(!isLinuxDockerDriverGatewayEnabled())(
    "exits when Podman is detected on a Docker-driver gateway platform",
    () => {
      const exit = vi.fn(() => {
        throw new Error("exit");
      });
      expect(() =>
        assertOnboardHostReadiness(hostWithRuntime("podman"), null, {
          explicitlyOptedOutGpuPassthrough: false,
          exitProcess: exit as never,
        }),
      ).toThrow("exit");
      expect(exit).toHaveBeenCalledWith(1);
    },
  );

  it("does not exit for a supported Docker runtime", () => {
    const exit = vi.fn();
    assertOnboardHostReadiness(hostWithRuntime("docker"), null, {
      explicitlyOptedOutGpuPassthrough: false,
      exitProcess: exit as never,
    });
    expect(exit).not.toHaveBeenCalled();
  });

  it("rejects an unsupported DOCKER_HOST before runtime probe effects (#7411)", async () => {
    const bridge = vi.fn();
    const validateGpu = vi.fn();
    const exitProcess = vi.fn((_code: number): never => {
      throw new Error("invalid Docker endpoint");
    });

    await expect(
      runReadinessGatedRuntimePreflight(
        {},
        {
          nonInteractive: true,
          collectGatewayReadiness: async () => managedGatewayReadiness(),
          assessHost: () => ({
            ...hostWithRuntime("docker"),
            dockerHostInvalid: true,
          }),
          detectGpu: () => null,
          warnIfHostProxyMissesLoopback: vi.fn(),
          assertDockerBridgeAndContainerDnsHealthy: bridge,
          validateSandboxGpuPreflight: validateGpu,
          exitProcess,
        },
      ),
    ).rejects.toThrow("invalid Docker endpoint");

    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(bridge).not.toHaveBeenCalled();
    expect(validateGpu).not.toHaveBeenCalled();
  });

  it("preserves Jetson NVIDIA runtime remediation before GPU-enabled effects (#7411)", () => {
    const exit = vi.fn((_code: number): never => {
      throw new Error("exit");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const host = {
      ...hostWithRuntime("docker"),
      hasNvidiaGpu: true,
      dockerNvidiaRuntimeAvailable: false,
      cdiNvidiaGpuSpecMissing: true,
      cdiNvidiaGpuSpecNeedsRepair: true,
      nvidiaContainerToolkitInstalled: true,
    };
    const gpu: GpuDetection = {
      type: "nvidia",
      platform: "jetson",
      count: 1,
      totalMemoryMB: 8_192,
      perGpuMB: 8_192,
      nimCapable: true,
    };

    expect(() =>
      assertOnboardHostReadiness(host, gpu, {
        explicitlyOptedOutGpuPassthrough: false,
        exitProcess: exit,
      }),
    ).toThrow("exit");
    const output = error.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("sudo nvidia-ctk runtime configure --runtime=docker");
    expect(output).not.toContain("Generate NVIDIA CDI device specs");
    expect(output).not.toContain("nvidia-ctk cdi generate");

    const optOutExit = vi.fn();
    assertOnboardHostReadiness(host, gpu, {
      explicitlyOptedOutGpuPassthrough: true,
      exitProcess: optOutExit as never,
    });
    expect(optOutExit).not.toHaveBeenCalled();
  });

  it.skipIf(!isLinuxDockerDriverGatewayEnabled())(
    "allows Podman only when the portable profile is explicit",
    () => {
      vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
      const exit = vi.fn();
      assertOnboardHostReadiness(hostWithRuntime("podman"), null, {
        explicitlyOptedOutGpuPassthrough: false,
        exitProcess: exit as never,
      });
      expect(exit).not.toHaveBeenCalled();
    },
  );
});

describe("runFatalOnboardRuntimePreflight", () => {
  it.each([
    ["the CLI disable flag", { sandboxGpu: "disable" as const }, {}],
    ["the environment CPU-only mode", {}, { NEMOCLAW_SANDBOX_GPU: "0" }],
  ])("treats %s as explicit CPU-only intent", (_label, options, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const result = runFatalOnboardRuntimePreflight(options, {
      nonInteractive: true,
      assessHost: () => hostWithMissingGpuIntegration(),
      detectGpu: () => ({
        type: "nvidia",
        count: 1,
        totalMemoryMB: 24_576,
        perGpuMB: 24_576,
        nimCapable: true,
      }),
      warnIfHostProxyMissesLoopback: vi.fn(),
      assertDockerBridgeAndContainerDnsHealthy: vi.fn(),
      validateSandboxGpuPreflight: vi.fn(),
      exitProcess: vi.fn(() => {
        throw new Error("unexpected exit");
      }) as never,
    });

    expect(result.sandboxGpuConfig.mode).toBe("0");
  });

  it("admits the read-only host report before portable preparation effects", () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    mocks.preparePortableExperimentalHost.mockImplementationOnce(() => {
      throw new Error("portable host prepared");
    });
    const assess = vi.fn(() => hostWithRuntime("docker"));

    expect(() =>
      runFatalOnboardRuntimePreflight(
        {},
        { nonInteractive: true, assessHost: assess, detectGpu: () => null },
      ),
    ).toThrow("portable host prepared");
    expect(assess).toHaveBeenCalledOnce();
    expect(mocks.preparePortableExperimentalHost).toHaveBeenCalledWith(process.env);
    expect(assess.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.preparePortableExperimentalHost.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("defers image and container checks until the caller explicitly runs them", () => {
    const bridge = vi.fn();
    const gpu = vi.fn();
    const context = {
      nonInteractive: true,
      deferEffectfulChecks: true,
      assessHost: () => hostWithRuntime("docker"),
      detectGpu: () => null,
      warnIfHostProxyMissesLoopback: vi.fn(),
      assertDockerBridgeAndContainerDnsHealthy: bridge,
      validateSandboxGpuPreflight: gpu,
    };

    const result = runFatalOnboardRuntimePreflight({}, context);
    expect(bridge).not.toHaveBeenCalled();
    expect(gpu).not.toHaveBeenCalled();

    runOnboardRuntimeEffectfulPreflightChecks(result, context);
    expect(bridge).toHaveBeenCalledOnce();
    expect(gpu).toHaveBeenCalledOnce();
  });

  it("disables the container-backed WSL GPU prover during host admission", () => {
    const detect = vi.fn((_deps?: DetectGpuDeps): GpuDetection | null => null);

    runFatalOnboardRuntimePreflight(
      {},
      {
        nonInteractive: true,
        deferEffectfulChecks: true,
        assessHost: wslDockerDesktopHost,
        detectGpu: detect,
      },
    );

    expect(detect).toHaveBeenCalledOnce();
    expect(detect).toHaveBeenCalledWith({ proveArm64WslDockerDesktopGpu: null });
  });

  it("rejects known GPU configuration errors before bridge or GPU container probes (#7411)", () => {
    const bridge = vi.fn();
    const validateGpu = vi.fn();
    const exitProcess = vi.fn((_code: number): never => {
      throw new Error("invalid GPU configuration");
    });
    const context = {
      nonInteractive: true,
      deferEffectfulChecks: true,
      assessHost: () => hostWithRuntime("docker"),
      detectGpu: () => null,
      warnIfHostProxyMissesLoopback: vi.fn(),
      assertDockerBridgeAndContainerDnsHealthy: bridge,
      validateSandboxGpuPreflight: validateGpu,
      exitProcess,
    };
    const result = runFatalOnboardRuntimePreflight({ sandboxGpu: "enable" }, context);

    expect(() => runOnboardRuntimeEffectfulPreflightChecks(result, context)).toThrow(
      "invalid GPU configuration",
    );
    expect(bridge).not.toHaveBeenCalled();
    expect(validateGpu).not.toHaveBeenCalled();
  });
});

describe("readiness-gated runtime preflight", () => {
  it("rejects a host assessment that exceeds the freshness window before effects (#7411)", async () => {
    let currentTime = Date.parse("2026-08-07T12:00:00.000Z");
    const bridge = vi.fn();
    const validateGpu = vi.fn();
    const exitProcess = vi.fn((_code: number): never => {
      throw new Error("stale host blocked");
    });

    await expect(
      runReadinessGatedRuntimePreflight(
        {},
        {
          nonInteractive: true,
          now: () => new Date(currentTime),
          collectGatewayReadiness: async () => managedGatewayReadiness(),
          assessHost: () => {
            currentTime += 30_001;
            return hostWithRuntime("docker");
          },
          detectGpu: () => null,
          assertDockerBridgeAndContainerDnsHealthy: bridge,
          validateSandboxGpuPreflight: validateGpu,
          exitProcess,
        },
      ),
    ).rejects.toThrow("stale host blocked");
    expect(bridge).not.toHaveBeenCalled();
    expect(validateGpu).not.toHaveBeenCalled();
  });

  it("rejects the initial gateway snapshot before collecting host facts", async () => {
    const assessHost = vi.fn(wslDockerDesktopHost);
    const detectGpu = vi.fn((_deps?: DetectGpuDeps): GpuDetection | null => null);
    const exitProcess = vi.fn(() => {
      throw new Error("gateway blocked");
    });
    const blocked = managedGatewayReadiness({
      capabilities: [
        { id: "gateway.authority.resolved", state: "absent" },
        { id: "gateway.attachment.valid", state: "absent" },
        { id: "gateway.reuse.ready", state: "absent" },
        { id: "gateway.version.compatible", state: "unknown" },
        { id: "gateway.port.uncontested", state: "unknown" },
      ],
      findings: [
        {
          id: "gateway.ownership.multiple",
          severity: "blocking",
          summary: "Multiple gateway owners were observed.",
        },
      ],
    });

    await expect(
      runReadinessGatedRuntimePreflight(
        {},
        {
          nonInteractive: true,
          collectGatewayReadiness: async () => blocked,
          assessHost,
          detectGpu,
          exitProcess: exitProcess as never,
        },
      ),
    ).rejects.toThrow("gateway blocked");
    expect(assessHost).not.toHaveBeenCalled();
    expect(detectGpu).not.toHaveBeenCalled();
  });

  it("runs the bounded WSL GPU proof only after host and gateway admission", async () => {
    const calls: string[] = [];
    const detectGpu = vi.fn((deps?: DetectGpuDeps): GpuDetection | null => {
      const isObservation = deps?.proveArm64WslDockerDesktopGpu === null;
      calls.push(isObservation ? "gpu-observation" : "gpu-runtime-proof");
      return isObservation
        ? null
        : {
            type: "nvidia",
            count: 1,
            totalMemoryMB: 32_768,
            perGpuMB: 32_768,
            nimCapable: true,
            wslDockerDesktopGpuProofPassed: true,
          };
    });

    const result = await runReadinessGatedRuntimePreflight(
      {},
      {
        nonInteractive: true,
        collectGatewayReadiness: async () => {
          calls.push("gateway-admission");
          return managedGatewayReadiness();
        },
        assessHost: () => {
          calls.push("host-observation");
          return wslDockerDesktopHost();
        },
        detectGpu,
        warnIfHostProxyMissesLoopback: vi.fn(),
        assertDockerBridgeAndContainerDnsHealthy: () => calls.push("bridge-dns"),
        validateSandboxGpuPreflight: () => calls.push("gpu-validation"),
      },
    );

    expect(calls).toEqual([
      "gateway-admission",
      "host-observation",
      "gpu-observation",
      "gateway-admission",
      "host-observation",
      "gpu-observation",
      "gpu-runtime-proof",
      "gateway-admission",
      "host-observation",
      "gpu-validation",
      "bridge-dns",
    ]);
    expect(result.gpu).toMatchObject({ wslDockerDesktopGpuProofPassed: true });
  });

  it("preserves a failed bounded WSL GPU proof as an absent readiness capability (#7411)", async () => {
    const detectGpu = vi.fn((_deps?: DetectGpuDeps): GpuDetection | null => null);

    const result = await runReadinessGatedRuntimePreflight(
      {},
      {
        nonInteractive: true,
        collectGatewayReadiness: async () => managedGatewayReadiness(),
        assessHost: wslDockerDesktopHost,
        detectGpu,
        warnIfHostProxyMissesLoopback: vi.fn(),
        assertDockerBridgeAndContainerDnsHealthy: vi.fn(),
        validateSandboxGpuPreflight: vi.fn(),
      },
    );

    expect(result.readinessReport.capabilities).toContainEqual({
      id: "host.platform.wsl_gpu_passthrough",
      state: "absent",
    });
    expect(result.readinessReport.findings).toContainEqual(
      expect.objectContaining({ id: "host.platform.wsl_gpu_passthrough_unavailable" }),
    );
  });

  it("rejects an explicit GPU request after a failed WSL proof before later container probes (#7411)", async () => {
    const bridge = vi.fn();
    const validateGpu = vi.fn();
    const exitProcess = vi.fn((_code: number): never => {
      throw new Error("GPU proof rejected");
    });

    await expect(
      runReadinessGatedRuntimePreflight(
        { sandboxGpu: "enable" },
        {
          nonInteractive: true,
          collectGatewayReadiness: async () => managedGatewayReadiness(),
          assessHost: wslDockerDesktopHost,
          detectGpu: () => null,
          warnIfHostProxyMissesLoopback: vi.fn(),
          assertDockerBridgeAndContainerDnsHealthy: bridge,
          validateSandboxGpuPreflight: validateGpu,
          exitProcess,
        },
      ),
    ).rejects.toThrow("GPU proof rejected");

    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(bridge).not.toHaveBeenCalled();
    expect(validateGpu).not.toHaveBeenCalled();
  });

  it("recollects gateway facts before bridge and GPU probe effects", async () => {
    const calls: string[] = [];
    const collectGatewayReadiness = vi.fn(async () => {
      calls.push("gateway");
      return managedGatewayReadiness();
    });

    await runReadinessGatedRuntimePreflight(
      {},
      {
        nonInteractive: true,
        collectGatewayReadiness,
        assessHost: () => {
          calls.push("host");
          return hostWithRuntime("docker");
        },
        detectGpu: () => null,
        warnIfHostProxyMissesLoopback: vi.fn(),
        assertDockerBridgeAndContainerDnsHealthy: () => calls.push("bridge"),
        validateSandboxGpuPreflight: () => calls.push("gpu"),
      },
    );

    expect(calls).toEqual(["gateway", "host", "gateway", "host", "gpu", "bridge"]);
  });

  it("replaces portable host and gateway facts before runtime probe effects", async () => {
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "portable");
    const calls: string[] = [];
    mocks.preparePortableExperimentalHost.mockImplementationOnce(() => {
      calls.push("portable");
    });

    await runReadinessGatedRuntimePreflight(
      {},
      {
        nonInteractive: true,
        collectGatewayReadiness: async () => {
          calls.push("gateway");
          return managedGatewayReadiness();
        },
        assessHost: () => {
          calls.push("host");
          return hostWithRuntime("docker");
        },
        detectGpu: () => null,
        warnIfHostProxyMissesLoopback: vi.fn(),
        assertDockerBridgeAndContainerDnsHealthy: () => calls.push("bridge"),
        validateSandboxGpuPreflight: () => calls.push("gpu"),
      },
    );

    expect(calls).toEqual([
      "gateway",
      "host",
      "portable",
      "host",
      "gateway",
      "host",
      "gpu",
      "bridge",
    ]);
  });

  it("does not run image or container checks when refreshed gateway facts block", async () => {
    const bridge = vi.fn();
    const gpu = vi.fn();
    const exit = vi.fn(() => {
      throw new Error("blocked");
    });
    const blocked = managedGatewayReadiness({
      capabilities: [
        { id: "gateway.authority.resolved", state: "present" },
        { id: "gateway.attachment.valid", state: "present" },
        { id: "gateway.reuse.ready", state: "present" },
        { id: "gateway.version.compatible", state: "present" },
        { id: "gateway.port.uncontested", state: "absent" },
      ],
      findings: [
        {
          id: "gateway.port.owner_mismatch",
          severity: "blocking",
          summary: "The gateway port owner changed.",
        },
      ],
    });
    const collectGatewayReadiness = vi
      .fn<() => Promise<GatewayReadinessProjection>>()
      .mockResolvedValueOnce(managedGatewayReadiness())
      .mockResolvedValueOnce(blocked);

    await expect(
      runReadinessGatedRuntimePreflight(
        {},
        {
          nonInteractive: true,
          collectGatewayReadiness,
          assessHost: () => hostWithRuntime("docker"),
          detectGpu: () => null,
          warnIfHostProxyMissesLoopback: vi.fn(),
          assertDockerBridgeAndContainerDnsHealthy: bridge,
          validateSandboxGpuPreflight: gpu,
          exitProcess: exit as never,
        },
      ),
    ).rejects.toThrow("blocked");
    expect(collectGatewayReadiness).toHaveBeenCalledTimes(2);
    expect(bridge).not.toHaveBeenCalled();
    expect(gpu).not.toHaveBeenCalled();
  });
});
