// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export interface HostMemorySnapshot {
  readonly totalMiB: number;
  readonly availableMiB: number;
}

const MEMINFO_PATH = "/proc/meminfo";

function meminfoValueMiB(meminfo: string, key: string): number | null {
  const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, "mu").exec(meminfo);
  if (!match) return null;
  const kib = Number.parseInt(match[1]!, 10);
  return Number.isFinite(kib) ? Math.round(kib / 1024) : null;
}

/**
 * Read the host memory pool a unified-memory GPU allocates from.
 *
 * `MemAvailable` is the same figure `detectGpu()` already approximates
 * unified GPU memory with, so a sandbox failure and the earlier GPU
 * detection describe one pool. Returns null off Linux or when the file
 * cannot be parsed, so a failed probe stays out of the diagnostics rather
 * than claiming a host has no memory.
 */
export function readHostMemorySnapshot(
  readMeminfo: () => string = () => fs.readFileSync(MEMINFO_PATH, "utf8"),
): HostMemorySnapshot | null {
  let meminfo: string;
  try {
    meminfo = readMeminfo();
  } catch {
    return null;
  }
  const totalMiB = meminfoValueMiB(meminfo, "MemTotal");
  const availableMiB = meminfoValueMiB(meminfo, "MemAvailable");
  if (totalMiB === null || availableMiB === null || totalMiB <= 0) return null;
  return { totalMiB, availableMiB };
}

/** Machine-readable memory facts for a failure diagnostics block. */
export function hostMemoryDiagnosticLines(snapshot: HostMemorySnapshot | null): string[] {
  if (!snapshot) return [];
  return [
    `host_memory_total_mib=${String(snapshot.totalMiB)}`,
    `host_memory_available_mib=${String(snapshot.availableMiB)}`,
  ];
}

/**
 * Remediation for a GPU sandbox that died on a host whose GPU memory is the
 * system pool.
 *
 * A managed inference server installed earlier in the same onboarding run
 * holds its share of that pool for as long as it serves, so the GPU sandbox
 * started afterwards can be refused device memory by the driver and exit
 * immediately. The driver reports that refusal only to the kernel log, which
 * is why the sandbox-side failure otherwise reads as a lifecycle problem with
 * no mention of memory (#12255).
 */
export function gpuSandboxMemoryPressureHints(snapshot: HostMemorySnapshot | null): string[] {
  return [
    snapshot
      ? `Host memory available: ${String(snapshot.availableMiB)} MiB of ${String(snapshot.totalMiB)} MiB.`
      : "Host memory could not be read for this failure.",
    "On unified-memory platforms (DGX Spark, Jetson) the GPU allocates from that same pool, so a managed inference server serving on this host holds part of it.",
    "Check `sudo dmesg -T | grep NVRM` for `Out of memory [NV_ERR_NO_MEMORY]` entries at the time of this failure.",
    "If this sandbox uses GPU passthrough, recreate it with `--no-sandbox-gpu`, or free the pool before retrying. `NEMOCLAW_SANDBOX_GPU=0` works only when no `--sandbox-gpu` flag is passed, because the flag overrides it.",
  ];
}

export function formatSandboxGpuPassthroughNote(options: {
  hostGpuPlatform?: string | null;
  resumeHasResolvedGpuIntent?: boolean;
  recordedGpuPassthroughBeforePreflight?: boolean;
  requestedGpuPassthrough?: boolean;
  sandboxGpuMode?: string | null;
}): string {
  if (options.hostGpuPlatform === "jetson") {
    return "  NVIDIA Jetson/Tegra GPU detected; enabling sandbox GPU through Docker NVIDIA runtime. Use --no-gpu to opt out.";
  }
  if (options.resumeHasResolvedGpuIntent && options.recordedGpuPassthroughBeforePreflight) {
    return "  [resume] Continuing GPU passthrough from the saved onboarding session.";
  }
  if (options.requestedGpuPassthrough || options.sandboxGpuMode === "1") {
    return "  GPU passthrough requested; passing --gpu to OpenShell gateway and sandbox creation.";
  }
  return "  NVIDIA GPU detected; enabling OpenShell GPU passthrough. Use --no-gpu to opt out.";
}
