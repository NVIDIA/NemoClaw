// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ProviderHealthProbeOptions } from "../../../../dist/lib/inference/health";
import {
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
