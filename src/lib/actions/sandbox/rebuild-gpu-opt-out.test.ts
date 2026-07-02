// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildRebuildRecreateOnboardOpts, rebuildShouldOptOutGpu } from "./rebuild-gpu-opt-out";

describe("rebuildShouldOptOutGpu", () => {
  it("returns false when the registry entry is null", () => {
    expect(rebuildShouldOptOutGpu(null)).toBe(false);
    expect(rebuildShouldOptOutGpu(undefined)).toBe(false);
  });

  it("returns true when sandboxGpuMode is the explicit opt-out '0'", () => {
    expect(rebuildShouldOptOutGpu({ sandboxGpuMode: "0", sandboxGpuEnabled: false })).toBe(true);
    expect(rebuildShouldOptOutGpu({ sandboxGpuMode: "0" })).toBe(true);
  });

  it("returns false when sandboxGpuMode is 'auto' (CPU fallback is not explicit opt-out)", () => {
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "auto",
        sandboxGpuEnabled: false,
      }),
    ).toBe(false);
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "auto",
        sandboxGpuEnabled: true,
      }),
    ).toBe(false);
  });

  it("returns false when sandboxGpuMode is '1' regardless of sandboxGpuEnabled", () => {
    expect(rebuildShouldOptOutGpu({ sandboxGpuMode: "1", sandboxGpuEnabled: true })).toBe(false);
    expect(rebuildShouldOptOutGpu({ sandboxGpuMode: "1", sandboxGpuEnabled: false })).toBe(false);
  });

  it("falls back to gpuEnabled=false for legacy entries with no sandboxGpuMode", () => {
    expect(rebuildShouldOptOutGpu({ gpuEnabled: false })).toBe(true);
  });

  it("ignores legacy gpuEnabled=false when sandboxGpuEnabled=true is recorded", () => {
    expect(rebuildShouldOptOutGpu({ sandboxGpuEnabled: true, gpuEnabled: false })).toBe(false);
  });

  it("returns false when no GPU metadata is recorded", () => {
    expect(rebuildShouldOptOutGpu({})).toBe(false);
  });

  it("returns false when only gpuEnabled=true is recorded", () => {
    expect(rebuildShouldOptOutGpu({ gpuEnabled: true })).toBe(false);
  });

  it("does NOT route malformed sandboxGpuMode values through the legacy gpuEnabled fallback", () => {
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "bogus" as unknown as string,
        gpuEnabled: false,
      }),
    ).toBe(false);
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "bogus" as unknown as string,
        sandboxGpuEnabled: true,
      }),
    ).toBe(false);
  });

  it("falls back to legacy gpuEnabled when sandboxGpuMode is an empty string", () => {
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "" as unknown as string,
        gpuEnabled: false,
      }),
    ).toBe(true);
  });

  it("normalises mixed-case mode 'AUTO' and aliases like 'off' through normalizeSandboxGpuMode", () => {
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "AUTO" as unknown as string,
        sandboxGpuEnabled: false,
      }),
    ).toBe(false);
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "off" as unknown as string,
      }),
    ).toBe(true);
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "false" as unknown as string,
      }),
    ).toBe(true);
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "TRUE" as unknown as string,
        sandboxGpuEnabled: false,
      }),
    ).toBe(false);
  });
});

describe("buildRebuildRecreateOnboardOpts", () => {
  const baseArgs = {
    rebuildAgent: "openclaw",
    storedFromDockerfile: null,
    webSearchConfig: null,
    autoYes: true,
  };
  const persistedTarget = {
    dashboardPort: 18789,
    gatewayName: "nemoclaw-19080",
    gatewayPort: 19080,
  };

  it("forwards noGpu:true when the recorded sandboxGpuMode is the explicit opt-out '0'", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...persistedTarget, sandboxGpuMode: "0", sandboxGpuEnabled: false },
    });
    expect(opts.noGpu).toBe(true);
    expect(opts).toMatchObject({
      resume: true,
      nonInteractive: true,
      recreateSandbox: true,
      authoritativeResumeConfig: true,
      authoritativePolicyTier: null,
      authoritativeResourceProfile: null,
      authoritativeHermesDashboardConfig: null,
      authoritativeWebSearchConfig: null,
      authoritativeWebSearchValidated: false,
      authoritativeMessagingPrevalidated: false,
      acceptThirdPartySoftware: true,
      agent: "openclaw",
      fromDockerfile: null,
      sandboxGpu: "disable",
      sandboxGpuDevice: null,
      controlUiPort: 18789,
      targetGatewayName: "nemoclaw-19080",
      targetGatewayPort: 19080,
      onboardLockAlreadyHeld: true,
      autoYes: true,
    });
  });

  it("forwards noGpu:true for legacy entries with gpuEnabled:false and no sandboxGpuMode", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...persistedTarget, gpuEnabled: false },
    });
    expect(opts.noGpu).toBe(true);
    expect(opts.sandboxGpu).toBe("disable");
  });

  it("omits noGpu for auto-mode CPU fallback so resume stays auto", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...persistedTarget, sandboxGpuMode: "auto", sandboxGpuEnabled: false },
    });
    expect(opts).not.toHaveProperty("noGpu");
    expect(opts.sandboxGpu).toBeNull();
    expect(opts.sandboxGpuDevice).toBeNull();
  });

  it("forwards the persisted GPU device when sandboxGpuMode is '1'", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: {
        ...persistedTarget,
        sandboxGpuMode: "1",
        sandboxGpuEnabled: true,
        sandboxGpuDevice: " 2 ",
      },
    });
    expect(opts).not.toHaveProperty("noGpu");
    expect(opts.sandboxGpu).toBe("enable");
    expect(opts.sandboxGpuDevice).toBe("2");
  });

  it("fails closed when a dashboard-managed sandbox has no persisted entry", () => {
    expect(() => buildRebuildRecreateOnboardOpts({ ...baseArgs, sb: null })).toThrow(
      "Cannot recreate a dashboard-managed sandbox without its persisted dashboard port",
    );
  });

  it("preserves storedFromDockerfile and autoYes regardless of GPU opt-out", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      sb: { ...persistedTarget, sandboxGpuMode: "0" },
      rebuildAgent: "hermes",
      storedFromDockerfile: "/sandbox/.openclaw/Dockerfile.custom",
      webSearchConfig: null,
      autoYes: false,
    });
    expect(opts.agent).toBe("hermes");
    expect(opts.fromDockerfile).toBe("/sandbox/.openclaw/Dockerfile.custom");
    expect(opts.autoYes).toBe(false);
    expect(opts.noGpu).toBe(true);
  });

  it("uses no dashboard port for the persisted Deep Agents terminal target (#6195)", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      sb: {
        gatewayName: "nemoclaw-19080",
        gatewayPort: 19080,
        sandboxGpuMode: "0",
      },
      rebuildAgent: "langchain-deepagents-code",
      storedFromDockerfile: null,
      webSearchConfig: null,
      autoYes: true,
    });

    expect(opts).toMatchObject({
      authoritativeResumeConfig: true,
      controlUiPort: null,
      targetGatewayName: "nemoclaw-19080",
      targetGatewayPort: 19080,
      sandboxGpu: "disable",
      onboardLockAlreadyHeld: true,
      noGpu: true,
    });
  });

  it("replays and validates the persisted Hermes dashboard configuration", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      rebuildAgent: "hermes",
      sb: {
        ...persistedTarget,
        hermesDashboardEnabled: true,
        hermesDashboardPort: 9120,
        hermesDashboardInternalPort: 19120,
        hermesDashboardTui: true,
      },
    });

    expect(opts.authoritativeHermesDashboardConfig).toEqual({
      enabled: true,
      port: 9120,
      internalPort: 19120,
      tuiEnabled: true,
    });
  });

  it("normalizes a persisted policy tier and rejects unknown tiers", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...persistedTarget, policyTier: " BALANCED " },
    });
    expect(opts.authoritativePolicyTier).toBe("balanced");

    expect(() =>
      buildRebuildRecreateOnboardOpts({
        ...baseArgs,
        sb: { ...persistedTarget, policyTier: "made-up-tier" },
      }),
    ).toThrow("Invalid persisted policy tier 'made-up-tier'");
  });

  it("replays the exact persisted CPU and memory resource intent", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: {
        ...persistedTarget,
        resourceCpu: " 4 ",
        resourceMemory: " 8Gi ",
      },
    });

    expect(opts.authoritativeResourceProfile).toEqual({ cpu: "4", memory: "8Gi" });
  });

  it("fails closed when persisted CPU and memory resource intent is incomplete", () => {
    expect(() =>
      buildRebuildRecreateOnboardOpts({
        ...baseArgs,
        sb: { ...persistedTarget, resourceCpu: "4" },
      }),
    ).toThrow("CPU and memory must both be non-empty");

    expect(() =>
      buildRebuildRecreateOnboardOpts({
        ...baseArgs,
        sb: { ...persistedTarget, resourceCpu: "", resourceMemory: "  " },
      }),
    ).toThrow("CPU and memory must both be non-empty");
  });

  it("rejects Hermes dashboard ports that collide with its persisted API forward", () => {
    expect(() =>
      buildRebuildRecreateOnboardOpts({
        ...baseArgs,
        rebuildAgent: "hermes",
        sb: {
          ...persistedTarget,
          hermesDashboardEnabled: true,
          hermesDashboardPort: persistedTarget.dashboardPort,
          hermesDashboardInternalPort: 19120,
        },
      }),
    ).toThrow("Invalid persisted Hermes dashboard port configuration");
  });
});
