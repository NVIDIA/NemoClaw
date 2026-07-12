// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";

import {
  buildRebuildRecreateOnboardOpts,
  getRebuildSandboxGpuOverrides,
  rebuildShouldOptOutGpu,
} from "./rebuild-gpu-opt-out";

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

describe("getRebuildSandboxGpuOverrides", () => {
  it("pins forced GPU mode and its recorded device", () => {
    expect(
      getRebuildSandboxGpuOverrides({
        sandboxGpuMode: "1",
        sandboxGpuEnabled: true,
        sandboxGpuDevice: "nvidia.com/gpu=2",
      }),
    ).toEqual({
      sandboxGpu: "enable",
      sandboxGpuDevice: "nvidia.com/gpu=2",
      sessionGpuPassthrough: true,
    });
  });

  it("pins opt-out while keeping auto distinct from cached enabled state", () => {
    expect(getRebuildSandboxGpuOverrides({ sandboxGpuMode: "0" })).toEqual({
      sandboxGpu: "disable",
      sandboxGpuDevice: null,
      sessionGpuPassthrough: false,
    });
    expect(
      getRebuildSandboxGpuOverrides({ sandboxGpuMode: "auto", sandboxGpuEnabled: true }),
    ).toEqual({
      sandboxGpu: null,
      sandboxGpuDevice: null,
      sessionGpuPassthrough: false,
    });
  });

  it("does not treat legacy effective-enabled fields as forced sandbox GPU", () => {
    expect(getRebuildSandboxGpuOverrides({ sandboxGpuEnabled: true, gpuEnabled: true })).toEqual({
      sandboxGpu: null,
      sandboxGpuDevice: null,
      sessionGpuPassthrough: false,
    });
  });
});

describe("buildRebuildRecreateOnboardOpts", () => {
  const baseArgs = {
    rebuildAgent: "openclaw",
    storedFromDockerfile: null,
    autoYes: true,
    usageNoticeAccepted: true as const,
  };
  const dashboard = { dashboardPort: 18789 };

  it("forwards noGpu:true when the recorded sandboxGpuMode is the explicit opt-out '0'", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...dashboard, sandboxGpuMode: "0", sandboxGpuEnabled: false },
    });
    expect(opts.noGpu).toBe(true);
    expect(opts).toMatchObject({
      resume: true,
      nonInteractive: true,
      recreateSandbox: true,
      authoritativeResumeConfig: true,
      agent: "openclaw",
      fromDockerfile: null,
      sandboxGpu: "disable",
      sandboxGpuDevice: null,
      autoYes: true,
      toolDisclosure: "progressive",
      observabilityEnabled: false,
      observabilityRequestedExplicitly: false,
    });
  });

  it("carries recorded DCode auto-approval into authoritative recreation (#6478)", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      sb: {
        dashboardPort: 0,
        gatewayName: "nemoclaw",
        dcodeAutoApprovalMode: "thread-opt-in",
      },
      rebuildAgent: "langchain-deepagents-code",
      storedFromDockerfile: null,
      autoYes: true,
      usageNoticeAccepted: true,
    });

    expect(opts.dcodeAutoApprovalMode).toBe("thread-opt-in");
    expect(opts.dcodeAutoApprovalRequestedExplicitly).toBe(false);
  });

  it("carries an explicit direct tool-disclosure selection into inner onboard", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...dashboard, toolDisclosure: "direct" },
    });

    expect(opts.toolDisclosure).toBe("direct");
  });

  it("carries durable observability intent into inner onboard", () => {
    const enabled = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      rebuildAgent: "langchain-deepagents-code",
      sb: { ...dashboard, observabilityEnabled: true },
    });
    const legacy = buildRebuildRecreateOnboardOpts({ ...baseArgs, sb: dashboard });

    expect(enabled.observabilityEnabled).toBe(true);
    expect(legacy.observabilityEnabled).toBe(false);
  });

  it("carries the authoritative restricted tier with observability into inner onboard", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      rebuildAgent: "langchain-deepagents-code",
      sb: {
        observabilityEnabled: true,
        policyTier: "restricted",
      },
    });

    expect(opts.policyTier).toBe("restricted");
    expect(opts.observabilityEnabled).toBe(true);
  });

  it("rejects an invalid recorded policy tier before destructive recreate work", () => {
    expect(() =>
      buildRebuildRecreateOnboardOpts({
        ...baseArgs,
        sb: { ...dashboard, policyTier: "unknown-tier" },
      }),
    ).toThrow("Invalid recorded policy tier 'unknown-tier'.");
  });

  it.each([
    "openclaw",
    "hermes",
  ])("rejects malformed %s observability state before recreate onboarding", (rebuildAgent) => {
    expect(() =>
      buildRebuildRecreateOnboardOpts({
        ...baseArgs,
        rebuildAgent,
        sb: { ...dashboard, observabilityEnabled: true },
      }),
    ).toThrow("Recorded observability state is valid only for agent 'langchain-deepagents-code'.");
  });

  it("forwards noGpu:true for legacy entries with gpuEnabled:false and no sandboxGpuMode", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...dashboard, gpuEnabled: false },
    });
    expect(opts.noGpu).toBe(true);
  });

  it("omits noGpu for auto-mode CPU fallback so resume stays auto", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { ...dashboard, sandboxGpuMode: "auto", sandboxGpuEnabled: false },
    });
    expect(opts).not.toHaveProperty("noGpu");
    expect(opts.sandboxGpu).toBeNull();
    expect(opts.sandboxGpuDevice).toBeNull();
  });

  it("omits noGpu when sandboxGpuMode is '1'", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: {
        ...dashboard,
        sandboxGpuMode: "1",
        sandboxGpuEnabled: true,
        sandboxGpuDevice: "nvidia.com/gpu=2",
      },
    });
    expect(opts).not.toHaveProperty("noGpu");
    expect(opts.sandboxGpu).toBe("enable");
    expect(opts.sandboxGpuDevice).toBe("nvidia.com/gpu=2");
  });

  it("fails closed when a dashboard-managed sandbox has no durable port", () => {
    expect(() => buildRebuildRecreateOnboardOpts({ ...baseArgs, sb: null })).toThrow(
      "without its persisted dashboard port",
    );
  });

  it("preserves storedFromDockerfile and autoYes regardless of GPU opt-out", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      sb: { ...dashboard, sandboxGpuMode: "0" },
      rebuildAgent: "hermes",
      storedFromDockerfile: "/sandbox/.openclaw/Dockerfile.custom",
      autoYes: false,
      usageNoticeAccepted: true,
    });
    expect(opts.agent).toBe("hermes");
    expect(opts.fromDockerfile).toBe("/sandbox/.openclaw/Dockerfile.custom");
    expect(opts.autoYes).toBe(false);
    expect(opts.noGpu).toBe(true);
  });

  it("passes the sandbox-specific base-image hint directly into recreate onboarding (#4680)", () => {
    const hint = { key: "sandbox-a" } as SandboxBaseImageResolutionMetadata;
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: dashboard,
      baseImageResolutionHint: hint,
    });
    expect(opts.baseImageResolutionHint).toBe(hint);
  });

  it("forwards the ephemeral prepared DCode rebuild handoff as one capability (#6195)", () => {
    const preparedDcodeRebuild = {
      buildContext: {
        buildCtx: "/tmp/dcode-rebuild",
        stagedDockerfile: "/tmp/dcode-rebuild/Dockerfile",
        buildId: "dcode-build",
        cleanupBuildCtx: () => true,
        origin: "generated" as const,
      },
      dcodeAutoApprovalMode: "disabled" as const,
      gatewayName: "nemoclaw",
    };
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { sandboxGpuMode: "0" },
      rebuildAgent: "langchain-deepagents-code",
      preparedDcodeRebuild,
    });

    expect(opts.preparedDcodeRebuild).toBe(preparedDcodeRebuild);
  });
});
