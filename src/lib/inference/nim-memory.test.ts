// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "module";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dockerMocks = vi.hoisted(() => ({
  remove: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker")>()),
  dockerRm: dockerMocks.remove,
  dockerStop: dockerMocks.stop,
}));

import * as nim from "./nim";

const require = createRequire(import.meta.url);
const NIM_DIST_PATH = require.resolve("./nim");
const RUNNER_PATH = require.resolve("../runner");

// Reloads ./nim with its runner mocked, so detectGpu() can be exercised
// against a scripted nvidia-smi output without a real GPU. Mirrors the
// identical helper in nim.test.ts.
function loadNimWithMockedRunner(runCapture: Mock) {
  const runner = require(RUNNER_PATH);
  const originalRunCapture = runner.runCapture;

  delete require.cache[NIM_DIST_PATH];
  runner.runCapture = runCapture;
  const nimModule = require(NIM_DIST_PATH);

  return {
    nimModule,
    restore() {
      delete require.cache[NIM_DIST_PATH];
      runner.runCapture = originalRunCapture;
    },
  };
}

describe("NIM memory selection", () => {
  beforeEach(() => {
    dockerMocks.remove.mockReset().mockReturnValue({ status: 0 });
    dockerMocks.stop.mockReset().mockReturnValue({ status: 0 });
  });

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

  it("detectGpu preserves a genuine zero free memory reading, distinct from unparseable", () => {
    // A GPU fully occupied by another workload legitimately reports 0 free
    // MB. detectGpu() must not collapse that into the same "unknown" state
    // as an unparseable `[N/A]` reading, or nimUsableMemoryMB() falls back
    // to totalMemoryMB and treats a saturated GPU as fully free.
    const runCapture = vi.fn((cmd: string | string[]) =>
      Array.isArray(cmd) &&
      cmd[0] === "nvidia-smi" &&
      cmd.some((a: string) => a.includes("name,memory.total"))
        ? "NVIDIA H100 80GB HBM3, 81920, 0\n"
        : "",
    );
    const { nimModule, restore } = loadNimWithMockedRunner(runCapture);

    try {
      const result = nimModule.detectGpu();
      expect(result).toMatchObject({
        type: "nvidia",
        name: "NVIDIA H100 80GB HBM3",
        totalMemoryMB: 81920,
      });
      expect(result?.availableMemoryMB).toBe(0);
    } finally {
      restore();
    }
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

  it("reports whether the NIM container removal completed", () => {
    expect(nim.stopNimContainerByName("nemoclaw-nim-test", { silent: true })).toBe(true);

    dockerMocks.remove.mockReturnValueOnce({ status: 1 });
    expect(nim.stopNimContainerByName("nemoclaw-nim-test", { silent: true })).toBe(false);
  });

  it("stops the fallback path when NIM container removal is not confirmed", () => {
    dockerMocks.remove.mockReturnValueOnce({ status: 1 });

    expect(() => nim.stopNimContainerByNameOrThrow("nemoclaw-nim-test")).toThrow(
      "Refusing to continue because it may still own its credentials and port",
    );
  });
});
