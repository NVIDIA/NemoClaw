// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildRebuildRecreateOnboardOpts,
  rebuildShouldOptOutGpu,
} from "../../../../dist/lib/actions/sandbox/rebuild-gpu-opt-out";

describe("rebuildShouldOptOutGpu", () => {
  it("returns false when the registry entry is null", () => {
    expect(rebuildShouldOptOutGpu(null)).toBe(false);
    expect(rebuildShouldOptOutGpu(undefined)).toBe(false);
  });

  it("returns true when sandboxGpuMode is the explicit opt-out '0'", () => {
    expect(
      rebuildShouldOptOutGpu({ sandboxGpuMode: "0", sandboxGpuEnabled: false }),
    ).toBe(true);
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
    expect(
      rebuildShouldOptOutGpu({ sandboxGpuMode: "1", sandboxGpuEnabled: true }),
    ).toBe(false);
    expect(
      rebuildShouldOptOutGpu({ sandboxGpuMode: "1", sandboxGpuEnabled: false }),
    ).toBe(false);
  });

  it("falls back to gpuEnabled=false for legacy entries with no sandboxGpuMode", () => {
    expect(rebuildShouldOptOutGpu({ gpuEnabled: false })).toBe(true);
  });

  it("ignores legacy gpuEnabled=false when sandboxGpuEnabled=true is recorded", () => {
    expect(
      rebuildShouldOptOutGpu({ sandboxGpuEnabled: true, gpuEnabled: false }),
    ).toBe(false);
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
    autoYes: true,
  };

  it("forwards noGpu:true when the recorded sandboxGpuMode is the explicit opt-out '0'", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { sandboxGpuMode: "0", sandboxGpuEnabled: false },
    });
    expect(opts.noGpu).toBe(true);
    expect(opts).toMatchObject({
      resume: true,
      nonInteractive: true,
      recreateSandbox: true,
      agent: "openclaw",
      fromDockerfile: null,
      autoYes: true,
    });
  });

  it("forwards noGpu:true for legacy entries with gpuEnabled:false and no sandboxGpuMode", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { gpuEnabled: false },
    });
    expect(opts.noGpu).toBe(true);
  });

  it("omits noGpu for auto-mode CPU fallback so resume stays auto", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { sandboxGpuMode: "auto", sandboxGpuEnabled: false },
    });
    expect(opts).not.toHaveProperty("noGpu");
  });

  it("omits noGpu when sandboxGpuMode is '1'", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { sandboxGpuMode: "1", sandboxGpuEnabled: true },
    });
    expect(opts).not.toHaveProperty("noGpu");
  });

  it("omits noGpu when no sandbox entry is captured", () => {
    const opts = buildRebuildRecreateOnboardOpts({ ...baseArgs, sb: null });
    expect(opts).not.toHaveProperty("noGpu");
  });

  it("preserves storedFromDockerfile and autoYes regardless of GPU opt-out", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      sb: { sandboxGpuMode: "0" },
      rebuildAgent: "hermes",
      storedFromDockerfile: "/sandbox/.openclaw/Dockerfile.custom",
      autoYes: false,
    });
    expect(opts.agent).toBe("hermes");
    expect(opts.fromDockerfile).toBe("/sandbox/.openclaw/Dockerfile.custom");
    expect(opts.autoYes).toBe(false);
    expect(opts.noGpu).toBe(true);
  });
});
