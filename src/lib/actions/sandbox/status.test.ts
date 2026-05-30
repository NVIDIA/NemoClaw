// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ProviderHealthProbeOptions } from "../../../../dist/lib/inference/health";
import {
  classifySandboxContainerFailureForStatus,
  getSandboxStatusInferenceHealth,
  isDockerDaemonUnreachableForStatus,
} from "../../../../dist/lib/actions/sandbox/status";

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
