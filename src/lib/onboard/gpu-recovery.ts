// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Recovery hint emitted when an onboard run finds the reusable gateway was
 * started without GPU passthrough but the current run requested it.
 *
 * Before #3456 this was a hard-coded `nemoclaw <name> destroy --yes` line
 * with a literal `<name>` placeholder — not actionable when the registry was
 * empty (the State A / State B dead loop the reporter hit on six Linux
 * hosts). This helper renders the right shape based on what's actually
 * registered AND owns the registry lookup, so the onboard.ts callsite stays
 * a single call (also keeps onboard.ts inside its size budget).
 */

import * as registry from "../state/registry";

/**
 * Returns the multi-line recovery hint for the GPU-passthrough mismatch
 * branch in onboard. Caller is expected to emit each line on its own line
 * via `console.error` / `runtime.log`.
 *
 * Empty / null input means no sandboxes are registered locally; we suggest
 * `nemoclaw uninstall` because there is nothing for `nemoclaw <name>
 * destroy` to act on. A single registered sandbox gets one destroy line
 * with `--cleanup-gateway` so the gateway also goes away (otherwise destroy
 * preserves the shared gateway by default — see v0.0.39 release notes).
 * Multiple sandboxes get one destroy line each; only the last carries
 * `--cleanup-gateway` so the gateway lives until every sandbox is gone.
 */
export function gpuPassthroughRecoveryLines(names: readonly string[] | null): string[] {
  const cleanNames = (names ?? []).map((n) => n.trim()).filter((n) => n.length > 0);

  if (cleanNames.length === 0) {
    return [
      "  Existing gateway was started without GPU passthrough.",
      "  No sandboxes are registered, so there is nothing for `nemoclaw destroy` to act on.",
      "  Clear the stale gateway state and re-onboard with GPU enabled:",
      "    nemoclaw uninstall && nemoclaw onboard --gpu",
    ];
  }

  if (cleanNames.length === 1) {
    return [
      "  Existing gateway was started without GPU passthrough.",
      "  To enable GPU, destroy the existing sandbox and gateway, then re-onboard:",
      `    nemoclaw ${cleanNames[0]} destroy --yes --cleanup-gateway && nemoclaw onboard --gpu`,
    ];
  }

  const lastIdx = cleanNames.length - 1;
  const destroyLines = cleanNames.map((name, idx) =>
    idx === lastIdx
      ? `    nemoclaw ${name} destroy --yes --cleanup-gateway && nemoclaw onboard --gpu`
      : `    nemoclaw ${name} destroy --yes`,
  );

  return [
    "  Existing gateway was started without GPU passthrough.",
    "  To enable GPU, destroy each registered sandbox and the gateway, then re-onboard:",
    ...destroyLines,
  ];
}

/**
 * Read registered sandbox names with a graceful empty-list fallback when the
 * registry can't be opened. Extracted so the onboard callsite stays a single
 * line and so unit tests can inject their own list.
 */
export function getRegisteredSandboxNamesForGpuRecovery(): string[] {
  try {
    return registry
      .listSandboxes()
      .sandboxes.map((s) => s.name)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Emit the GPU-passthrough mismatch recovery hint to `emit` (typically
 * `console.error`). `loadNames` is injectable for tests; the production
 * default reads the on-disk sandbox registry.
 */
export function reportGpuPassthroughRecovery(
  emit: (line: string) => void,
  loadNames: () => string[] = getRegisteredSandboxNamesForGpuRecovery,
): void {
  for (const line of gpuPassthroughRecoveryLines(loadNames())) emit(line);
}
