// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  gpuSandboxMemoryPressureHints,
  hostMemoryDiagnosticLines,
  readHostMemorySnapshot,
  unifiedMemoryGpuSandboxWarningLines,
} from "./sandbox-gpu-notes";

const MEMINFO = [
  "MemTotal:       127598656 kB",
  "MemFree:          4194304 kB",
  "MemAvailable:    30408704 kB",
  "SwapTotal:       16777216 kB",
].join("\n");

describe("host memory diagnostics (#12255)", () => {
  it("reads the pool a unified-memory GPU allocates from", () => {
    expect(readHostMemorySnapshot(() => MEMINFO)).toEqual({
      totalMiB: 124608,
      availableMiB: 29696,
    });
  });

  it("reports nothing when the host does not expose the pool", () => {
    expect(
      readHostMemorySnapshot(() => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
    expect(readHostMemorySnapshot(() => "MemTotal:       127598656 kB")).toBeNull();
    expect(readHostMemorySnapshot(() => "MemTotal: 0 kB\nMemAvailable: 0 kB")).toBeNull();
  });

  it("formats the pool as machine-readable diagnostics", () => {
    expect(hostMemoryDiagnosticLines({ totalMiB: 124608, availableMiB: 2048 })).toEqual([
      "host_memory_total_mib=124608",
      "host_memory_available_mib=2048",
    ]);
    expect(hostMemoryDiagnosticLines(null)).toEqual([]);
  });

  it("names the pool, the kernel-log evidence, and the way out", () => {
    const hints = gpuSandboxMemoryPressureHints({ totalMiB: 124608, availableMiB: 2048 }).join(
      "\n",
    );
    expect(hints).toContain("Host memory available: 2048 MiB of 124608 MiB.");
    expect(hints).toContain("unified-memory platforms");
    expect(hints).toContain("NV_ERR_NO_MEMORY");
    expect(hints).toContain("--no-sandbox-gpu");
    // `--sandbox-gpu` beats NEMOCLAW_SANDBOX_GPU in resolveSandboxGpuMode(), so
    // the environment variable alone is not a reliable way out.
    expect(hints).toContain("works only when no `--sandbox-gpu` flag is passed");
  });

  it("still explains itself when the pool could not be read", () => {
    const hints = gpuSandboxMemoryPressureHints(null);
    expect(hints[0]).toBe("Host memory could not be read for this failure.");
    expect(hints).toHaveLength(4);
  });
});

describe("unified-memory GPU sandbox warning (#12255)", () => {
  const SPARK = { sandboxGpuEnabled: true, hostGpuPlatform: "spark" };
  const CONSTRAINED = () => ({ totalMiB: 124608, availableMiB: 30038 });
  const IDLE = () => ({ totalMiB: 124608, availableMiB: 118000 });

  it("warns when most of the pool is already spoken for", () => {
    const lines = unifiedMemoryGpuSandboxWarningLines(SPARK, CONSTRAINED);

    expect(lines.join("\n")).toContain("30038 MiB of 124608 MiB host memory is available");
    expect(lines.join("\n")).toContain("--no-sandbox-gpu");
    // Advisory only: the caller keeps creating the sandbox.
    expect(lines.join("\n")).toContain("Continuing");
  });

  it("stays quiet when the pool is mostly free", () => {
    expect(unifiedMemoryGpuSandboxWarningLines(SPARK, IDLE)).toEqual([]);
  });

  it("stays quiet without sandbox GPU passthrough", () => {
    expect(
      unifiedMemoryGpuSandboxWarningLines(
        { sandboxGpuEnabled: false, hostGpuPlatform: "spark" },
        CONSTRAINED,
      ),
    ).toEqual([]);
  });

  it("stays quiet where GPU memory is separate from host memory", () => {
    expect(
      unifiedMemoryGpuSandboxWarningLines(
        { sandboxGpuEnabled: true, hostGpuPlatform: "linux" },
        CONSTRAINED,
      ),
    ).toEqual([]);
    expect(
      unifiedMemoryGpuSandboxWarningLines(
        { sandboxGpuEnabled: true, hostGpuPlatform: null },
        CONSTRAINED,
      ),
    ).toEqual([]);
  });

  it("stays quiet when the pool cannot be read", () => {
    expect(unifiedMemoryGpuSandboxWarningLines(SPARK, () => null)).toEqual([]);
  });

  it.each(["spark", "jetson", "n1x"])("covers the %s unified-memory platform", (platform) => {
    expect(
      unifiedMemoryGpuSandboxWarningLines(
        { sandboxGpuEnabled: true, hostGpuPlatform: platform },
        CONSTRAINED,
      ),
    ).not.toEqual([]);
  });
});
