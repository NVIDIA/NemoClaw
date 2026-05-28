// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { rebuildShouldOptOutGpu } from "../../../../dist/lib/actions/sandbox/rebuild";

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

  it("falls through to the legacy gpuEnabled check when sandboxGpuMode is not 0/1/auto", () => {
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "bogus" as unknown as string,
        gpuEnabled: false,
      }),
    ).toBe(true);
    expect(
      rebuildShouldOptOutGpu({
        sandboxGpuMode: "bogus" as unknown as string,
        sandboxGpuEnabled: true,
      }),
    ).toBe(false);
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
