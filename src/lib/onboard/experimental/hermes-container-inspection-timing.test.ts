// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createHermesPortableContainerInspectionTiming } from "./hermes-portable-container";

describe("Hermes container inspection timing", () => {
  it("records only bounded numeric stage evidence", () => {
    let now = 0;
    const complete = vi.fn();
    const timing = createHermesPortableContainerInspectionTiming(complete, () => now);
    const result = timing.measure("podmanCapture", () => {
      now += 2_130;
      return "secret inspect output";
    });
    timing.finish();

    expect(result).toBe("secret inspect output");
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ podmanCaptureMs: 2_130, podmanCaptureCount: 1 }),
    );
    expect(JSON.stringify(complete.mock.calls[0]?.[0])).not.toContain("secret inspect output");
  });

  it("keeps clock and callback failures observational", () => {
    const complete = vi.fn(() => {
      throw new Error("timing sink failed");
    });
    const timing = createHermesPortableContainerInspectionTiming(complete, () => {
      throw new Error("clock failed");
    });

    expect(timing.measure("jsonParse", () => 42)).toBe(42);
    expect(() => timing.finish()).not.toThrow();
    expect(() => timing.finish()).not.toThrow();
    expect(complete).toHaveBeenCalledOnce();
  });
});
