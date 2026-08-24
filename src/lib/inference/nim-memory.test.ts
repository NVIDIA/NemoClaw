// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import * as nim from "./nim";

describe("NIM memory selection", () => {
  it("caps NIM usable memory at 50 percent on unified-memory hosts", () => {
    expect(
      nim.nimUsableMemoryMB({
        availableMemoryMB: 119808,
        totalMemoryMB: 131072,
        unifiedMemory: true,
      }),
    ).toBe(65536);
  });

  it("uses detected free memory on discrete GPUs", () => {
    expect(
      nim.nimUsableMemoryMB({
        availableMemoryMB: 60000,
        totalMemoryMB: 131072,
        unifiedMemory: false,
      }),
    ).toBe(60000);
  });

  it("preserves zero free memory on discrete GPUs", () => {
    expect(
      nim.nimUsableMemoryMB({
        availableMemoryMB: 0,
        totalMemoryMB: 131072,
        unifiedMemory: false,
      }),
    ).toBe(0);
  });

  it("uses total memory when free memory is unavailable", () => {
    expect(
      nim.nimUsableMemoryMB({
        totalMemoryMB: 131072,
        unifiedMemory: false,
      }),
    ).toBe(131072);
  });

  it("excludes Nemotron 3 Super and retains Nemotron 3 Nano at the DGX Spark memory limit", () => {
    const { models, usableMemoryMB } = nim.getNimModelOptions({
      availableMemoryMB: 119808,
      totalMemoryMB: 131072,
      unifiedMemory: true,
    });

    expect(usableMemoryMB).toBe(65536);
    expect(models.map((model) => model.name)).not.toContain("nvidia/nemotron-3-super-120b-a12b");
    expect(models.map((model) => model.name)).toContain("nvidia/nemotron-3-nano-30b-a3b");
  });

  it("stops the health wait when a running NIM reports insufficient usable memory", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      expect(
        nim.waitForNimHealth(9000, 60, {
          container: "nemoclaw-nim-test",
          inspectContainerState: vi.fn(() => "running"),
          readContainerLogs: vi.fn(
            () => "WARNING: Estimated memory (124.4 GB) exceeds usable GPU memory (60.8 GB).",
          ),
          runCaptureImpl: vi.fn(() => ""),
        }),
      ).toBe(false);
      expect(consoleError).toHaveBeenCalledWith(
        "  NIM reports that its estimated memory exceeds usable GPU memory. Stopping the health wait.",
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
