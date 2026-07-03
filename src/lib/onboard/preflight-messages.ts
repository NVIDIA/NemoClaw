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
import { cliDisplayName } from "./branding";

/** Docker cannot be reached, so onboarding cannot continue. */
export function printDockerNotReachableError(): void {
  console.error(failLine("Docker is not reachable. Please fix Docker and try again."));
}

/** Podman under the Linux Docker-driver path is unsupported. */
export function printUnsupportedRuntimeError(): void {
  console.error(failLine(`${cliDisplayName()} onboarding now uses OpenShell's Docker driver.`));
  console.error(`    Podman is not supported for this ${cliDisplayName()} integration path.`);
  console.error("    Switch to Docker Engine and rerun onboarding.");
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
    `    To fix: openshell provider create --name ${providerName} --type generic --credential <KEY>`,
  );
}
