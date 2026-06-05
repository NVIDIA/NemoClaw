// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  classifySandboxContainerFailureForStatus,
  classifySandboxStatusPreflightFailure,
  getSandboxStatusInferenceHealth,
  isDockerDaemonUnreachableForStatus,
  maybeGetSandboxStatusInferenceHealth,
  sandboxGpuProofStatusSuffix,
  sandboxGpuProofUnverified,
} from "../../../../dist/lib/actions/sandbox/status";
import type { ProviderHealthProbeOptions } from "../../../../dist/lib/inference/health";

describe("sandbox status inference health", () => {
  it("passes the current model with the current provider", () => {
    let observed: { provider: string; options?: ProviderHealthProbeOptions } | null = null;

    const result = getSandboxStatusInferenceHealth(
      true,
      "nvidia-prod",
      "moonshotai/kimi-k2.6",
      (provider, options) => {
        observed = { provider, options };
        return {
          ok: true,
          probed: true,
          providerLabel: "NVIDIA Endpoints",
          endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
          detail: "healthy",
        };
      },
    );

    expect(result?.ok).toBe(true);
    expect(observed).toEqual({
      provider: "nvidia-prod",
      options: { model: "moonshotai/kimi-k2.6" },
    });
  });

  it("does not probe when the sandbox gateway is not present", () => {
    let called = false;

    const result = getSandboxStatusInferenceHealth(
      false,
      "nvidia-prod",
      "moonshotai/kimi-k2.6",
      () => {
        called = true;
        return null;
      },
    );

    expect(result).toBeNull();
    expect(called).toBe(false);
  });
});

describe("isDockerDaemonUnreachableForStatus", () => {
  it("returns false when sandbox entry is null", () => {
    expect(isDockerDaemonUnreachableForStatus(null, () => false)).toBe(false);
  });

  it("returns false when the openshell driver is not docker", () => {
    expect(
      isDockerDaemonUnreachableForStatus(
        { name: "alpha", openshellDriver: "vm" } as never,
        () => false,
      ),
    ).toBe(false);
  });

  it("returns true when driver is docker and the probe reports unreachable", () => {
    expect(
      isDockerDaemonUnreachableForStatus(
        { name: "alpha", openshellDriver: "docker" } as never,
        () => false,
      ),
    ).toBe(true);
  });

  it("returns false when driver is docker and the probe reports reachable", () => {
    expect(
      isDockerDaemonUnreachableForStatus(
        { name: "alpha", openshellDriver: "docker" } as never,
        () => true,
      ),
    ).toBe(false);
  });
});

describe("classifySandboxContainerFailureForStatus", () => {
  it("returns null when sandbox entry is null", async () => {
    const probe = async () => {
      throw new Error("probe should not be invoked");
    };
    await expect(
      classifySandboxContainerFailureForStatus(null, probe),
    ).resolves.toBeNull();
  });

  it("returns null when the openshell driver is not docker", async () => {
    let called = false;
    const probe = async () => {
      called = true;
      return null;
    };
    await expect(
      classifySandboxContainerFailureForStatus(
        { name: "alpha", openshellDriver: "vm" } as never,
        probe,
      ),
    ).resolves.toBeNull();
    expect(called).toBe(false);
  });

  it("forwards the sandbox name and dashboard port to the probe and propagates its verdict", async () => {
    const observed: { sandboxName: string; port: number | null }[] = [];
    const probe = async (sandboxName: string, dashboardPort: number | null) => {
      observed.push({ sandboxName, port: dashboardPort });
      return {
        layer: "sandbox_dashboard_port_conflict" as const,
        detail: "stub failure",
      };
    };
    const result = await classifySandboxContainerFailureForStatus(
      {
        name: "alpha",
        openshellDriver: "docker",
        dashboardPort: 18900,
      } as never,
      probe,
    );
    expect(result).toEqual({
      layer: "sandbox_dashboard_port_conflict",
      detail: "stub failure",
    });
    expect(observed).toEqual([{ sandboxName: "alpha", port: 18900 }]);
  });

  it("passes null when the sandbox entry has no dashboard port recorded", async () => {
    const observed: { sandboxName: string; port: number | null }[] = [];
    const probe = async (sandboxName: string, dashboardPort: number | null) => {
      observed.push({ sandboxName, port: dashboardPort });
      return null;
    };
    await expect(
      classifySandboxContainerFailureForStatus(
        { name: "alpha", openshellDriver: "docker" } as never,
        probe,
      ),
    ).resolves.toBeNull();
    expect(observed).toEqual([{ sandboxName: "alpha", port: null }]);
  });
});

describe("maybeGetSandboxStatusInferenceHealth", () => {
  it("does not invoke the provider probe when suppressInferenceProbe is true even with a present gateway and string provider", () => {
    let probeCalls = 0;
    const result = maybeGetSandboxStatusInferenceHealth(
      true,
      true,
      "nvidia-prod",
      "nvidia/nemotron",
      (...args) => {
        probeCalls += 1;
        throw new Error(`probeProviderHealth should not be invoked (args=${JSON.stringify(args)})`);
      },
    );
    expect(result).toBeNull();
    expect(probeCalls).toBe(0);
  });

  it("delegates to the probe when suppressInferenceProbe is false", () => {
    const calls: { provider: string; options?: ProviderHealthProbeOptions }[] = [];
    const result = maybeGetSandboxStatusInferenceHealth(
      false,
      true,
      "nvidia-prod",
      "nvidia/nemotron",
      (provider, options) => {
        calls.push({ provider, options });
        return {
          ok: true,
          probed: true,
          providerLabel: "NVIDIA Endpoints",
          endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
          detail: "healthy",
        };
      },
    );
    expect(result?.ok).toBe(true);
    expect(calls).toEqual([
      { provider: "nvidia-prod", options: { model: "nvidia/nemotron" } },
    ]);
  });
});

describe("classifySandboxStatusPreflightFailure", () => {
  it("returns docker_unreachable when the daemon probe reports unreachable", async () => {
    let sandboxProbeCalled = false;
    const result = await classifySandboxStatusPreflightFailure(
      { name: "alpha", openshellDriver: "docker" } as never,
      {
        dockerProbe: () => false,
        sandboxContainerProbe: async () => {
          sandboxProbeCalled = true;
          return null;
        },
      },
    );
    expect(result).toEqual({ layer: "docker_unreachable", dockerUnreachable: true });
    // Short-circuits: a daemon that is already known to be down must not
    // trigger a follow-up `docker ps` round trip.
    expect(sandboxProbeCalled).toBe(false);
  });

  it("returns the sandbox container failure when the daemon is reachable", async () => {
    const result = await classifySandboxStatusPreflightFailure(
      { name: "alpha", openshellDriver: "docker", dashboardPort: 18789 } as never,
      {
        dockerProbe: () => true,
        sandboxContainerProbe: async (sandboxName, dashboardPort) => {
          expect(sandboxName).toBe("alpha");
          expect(dashboardPort).toBe(18789);
          return {
            layer: "sandbox_dashboard_port_conflict",
            detail: "stub failure",
          };
        },
      },
    );
    expect(result).toEqual({
      layer: "sandbox_dashboard_port_conflict",
      dockerUnreachable: false,
    });
  });

  it("returns null when the sandbox container probe finds no failure", async () => {
    const result = await classifySandboxStatusPreflightFailure(
      { name: "alpha", openshellDriver: "docker" } as never,
      {
        dockerProbe: () => true,
        sandboxContainerProbe: async () => null,
      },
    );
    expect(result).toBeNull();
  });

  it("returns null when the sandbox is not on the docker driver", async () => {
    let dockerCalled = false;
    let sandboxCalled = false;
    const result = await classifySandboxStatusPreflightFailure(
      { name: "alpha", openshellDriver: "vm" } as never,
      {
        dockerProbe: () => {
          dockerCalled = true;
          return false;
        },
        sandboxContainerProbe: async () => {
          sandboxCalled = true;
          return null;
        },
      },
    );
    expect(result).toBeNull();
    // Both gates are docker-driver-only; a vm sandbox must not provoke
    // either probe.
    expect(dockerCalled).toBe(false);
    expect(sandboxCalled).toBe(false);
  });

  it("returns null when the sandbox entry is null", async () => {
    const result = await classifySandboxStatusPreflightFailure(null);
    expect(result).toBeNull();
  });
});

describe("sandbox GPU proof status rendering (#4231)", () => {
  it("does not call an unproven GPU healthy", () => {
    expect(sandboxGpuProofUnverified(null)).toBe(true);
    expect(sandboxGpuProofUnverified(undefined)).toBe(true);
    expect(
      sandboxGpuProofUnverified({ status: "unverified", cudaVerified: false, at: "t" }),
    ).toBe(true);
    expect(
      sandboxGpuProofUnverified({ status: "verified", cudaVerified: true, at: "t" }),
    ).toBe(false);
    expect(
      sandboxGpuProofUnverified({ status: "failed", cudaVerified: false, at: "t" }),
    ).toBe(false);
  });

  it("renders verified / unverified / failed suffixes distinctly", () => {
    expect(
      sandboxGpuProofStatusSuffix({ status: "verified", cudaVerified: true, at: "t" }),
    ).toContain("CUDA verified");
    // No recorded proof (older entries) must not read as healthy.
    expect(sandboxGpuProofStatusSuffix(null)).toContain("CUDA unverified");
    expect(
      sandboxGpuProofStatusSuffix({ status: "unverified", cudaVerified: false, at: "t" }),
    ).toContain("CUDA unverified");
    const failed = sandboxGpuProofStatusSuffix({
      status: "failed",
      cudaVerified: false,
      label: "cuInit(0)",
      at: "t",
    });
    expect(failed).toContain("last CUDA proof failed");
    expect(failed).toContain("cuInit(0)");
  });
});
