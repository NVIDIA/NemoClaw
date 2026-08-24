// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Onboard preflight severity messages, extracted from `onboard.ts` so they can
 * adopt the shared `warnLine`/`failLine` renderer (#6004) without growing the
 * top-level entrypoint past the `onboard-entrypoint-budget` / codebase-growth
 * CI ceiling (same extraction pattern as `bridge-dns-preflight.ts`).
 *
 * Every WARN line here is emitted through `console.warn` and every ERROR line
 * through `console.error`, so the renderer's stderr-keyed color decision
 * matches the stream the line lands on.
 */

import { failLine, warnLine } from "../cli/terminal-style";
import { formatNvidiaGpuPreflightLines, type GpuDetection } from "../inference/nim";
import { cliDisplayName, cliName } from "./branding";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

/** Docker cannot be reached, so onboarding cannot continue. */
export function printDockerNotReachableError(): void {
  console.error(failLine("Docker is not reachable. Please fix Docker and try again."));
}

/** Podman under the Linux Docker-driver path is unsupported. */
export function printUnsupportedRuntimeError(): void {
  console.error(failLine(`${cliDisplayName()} onboarding now uses OpenShell's Docker driver.`));
  console.error(`    Podman is not supported for this ${cliDisplayName()} integration path.`);
  console.error("    Switch to Docker Engine, Docker Desktop, or Colima, then rerun onboarding.");
}

/** NVIDIA CDI state cannot support GPU passthrough for this onboarding run. */
export function printCdiSpecUnavailableError(): void {
  console.error(
    failLine(
      "Docker is configured for CDI device injection (CDISpecDirs is set), but the NVIDIA GPU CDI spec is missing or stale. OpenShell GPU startup can fail until the CDI spec is refreshed.",
    ),
  );
}

export interface UnderProvisionedRuntimeWarning {
  /** Human-readable detected resources, e.g. "2 vCPU / 2.0 GiB". */
  detectedStr: string;
  /** Container runtime kind (drives the resize suggestion). */
  runtime: string;
  recommendedCpus: number;
  recommendedMemGib: number;
}

/** Container runtime detected below the recommended CPU/memory floor. */
export function printUnderProvisionedRuntimeWarning(
  opts: UnderProvisionedRuntimeWarning,
  warn: (message: string) => void = console.warn,
): void {
  const { detectedStr, runtime, recommendedCpus, recommendedMemGib } = opts;
  warn(
    warnLine(
      `Container runtime under-provisioned: ${detectedStr} detected ` +
        `(recommended: ${recommendedCpus} vCPU / ${recommendedMemGib} GiB).`,
    ),
  );
  warn("    The sandbox build will be slow and may stall on default Colima settings.");
  if (runtime === "colima") {
    warn(
      `    Suggested: colima stop && colima start --cpu ${recommendedCpus} --memory ${recommendedMemGib}`,
    );
  } else if (runtime === "docker-desktop") {
    warn("    Suggested: Docker Desktop → Settings → Resources, raise CPU/memory.");
  }
  warn("    Set NEMOCLAW_IGNORE_RUNTIME_RESOURCES=1 to silence this check.");
}

/** Total system memory is below the sandbox-build comfort threshold. */
export function printLowMemoryWarning(mem: {
  totalRamMB: number;
  totalSwapMB: number;
  totalMB: number;
}): void {
  console.warn(
    warnLine(
      `Low memory detected (${mem.totalRamMB} MB RAM + ${mem.totalSwapMB} MB swap = ${mem.totalMB} MB total)`,
    ),
  );
}

/** Swap-file creation failed on a low-memory host. */
export function printSwapCreationFailed(reason: string | undefined): void {
  console.warn(warnLine(`Could not create swap: ${reason}`));
  console.warn("    Sandbox creation may fail with OOM on low-memory systems.");
}

/** A configured messaging provider was not present in the gateway. */
export function printMessagingProviderMissing(providerName: string): void {
  console.warn(warnLine(`Messaging provider '${providerName}' was not found in the gateway.`));
  console.warn("    The credential may not be available inside the sandbox.");
  console.warn(
    `    To fix: rerun ${cliName()} onboard with the required messaging credentials so NemoClaw can register the OpenShell provider profile.`,
  );
}

/**
 * Print the preflight GPU and sandbox-GPU lines for one detection result.
 * Same entrypoint-extraction rationale as the messages above.
 */
export function printGpuPreflightLines(options: {
  gpu: GpuDetection | null;
  sandboxGpuConfig: SandboxGpuConfig;
  // Which trust-gate check rejected the newest GPU detection (#9000); printed
  // under the "no GPU detected" line so the user sees the failed check.
  gpuTrustGateRejection?: string;
  log?: (message: string) => void;
}): void {
  const { gpu, sandboxGpuConfig, gpuTrustGateRejection } = options;
  const log = options.log ?? ((message: string) => console.log(message));
  if (gpu && gpu.type === "nvidia") {
    const lines = formatNvidiaGpuPreflightLines(gpu);
    log(`  ✓ ${lines[0]}`);
    for (const extra of lines.slice(1)) {
      log(`  ${extra}`);
    }
    if (!gpu.nimCapable) {
      log("  ⓘ Local NIM unavailable — GPU VRAM too small");
    }
  } else if (gpu && gpu.type === "apple") {
    log(
      `  ✓ Apple GPU detected: ${gpu.name}${gpu.cores ? ` (${gpu.cores} cores)` : ""}, ${gpu.totalMemoryMB} MB unified memory`,
    );
    log("  ⓘ Local NIM unavailable — requires NVIDIA GPU");
  } else {
    log("  ⓘ Local NIM unavailable — no GPU detected");
    if (gpuTrustGateRejection) {
      log(`    GPU detection rejected the nvidia-smi report: ${gpuTrustGateRejection}`);
    }
  }

  if (sandboxGpuConfig.sandboxGpuEnabled) {
    log(
      `  ✓ Sandbox GPU: enabled (${sandboxGpuConfig.mode}${sandboxGpuConfig.sandboxGpuDevice ? `, device ${sandboxGpuConfig.sandboxGpuDevice}` : ""})`,
    );
  } else if (sandboxGpuConfig.mode === "0") {
    log("  ✓ Sandbox GPU: disabled by configuration");
  } else {
    log("  ⓘ Sandbox GPU: disabled (no NVIDIA GPU detected)");
  }
}
