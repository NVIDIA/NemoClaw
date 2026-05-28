// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { rebuildShouldOptOutGpu } from "../../../../dist/lib/actions/sandbox/rebuild";

describe("rebuildShouldOptOutGpu", () => {
  it("returns false when the registry entry is null", () => {
    expect(rebuildShouldOptOutGpu(null)).toBe(false);
    expect(rebuildShouldOptOutGpu(undefined)).toBe(false);
  });

  it("returns true when sandboxGpuEnabled is explicitly false", () => {
    expect(rebuildShouldOptOutGpu({ sandboxGpuEnabled: false })).toBe(true);
    expect(
      rebuildShouldOptOutGpu({ sandboxGpuEnabled: false, gpuEnabled: true }),
    ).toBe(true);
  });

  it("returns true when sandboxGpuEnabled is missing and gpuEnabled is false (legacy entries)", () => {
    expect(rebuildShouldOptOutGpu({ gpuEnabled: false })).toBe(true);
  });

  it("returns false when sandboxGpuEnabled is true regardless of gpuEnabled", () => {
    expect(
      rebuildShouldOptOutGpu({ sandboxGpuEnabled: true, gpuEnabled: false }),
    ).toBe(false);
    expect(rebuildShouldOptOutGpu({ sandboxGpuEnabled: true })).toBe(false);
  });

  it("returns false when both flags are unset (no recorded intent)", () => {
    expect(rebuildShouldOptOutGpu({})).toBe(false);
  });

  it("returns false when sandboxGpuEnabled is missing and gpuEnabled is true", () => {
    expect(rebuildShouldOptOutGpu({ gpuEnabled: true })).toBe(false);
  });
});
