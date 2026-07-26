// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// #6520: a recorded sandbox the selected gateway does not observe in any
// phase, while its persisted binding resolves to that same gateway, has
// nowhere else to be running — its gateway registration and Docker image were
// likely removed (`nemoclaw uninstall` preserves sandboxes.json but deletes
// both). The signal is independent of version classification: a same-version
// reinstall leaves such an orphan classified "current" and a missing cached
// version leaves it "unknown", so staleness alone cannot carry it.

/**
 * Marker prefix for the orphan summary line. install.sh greps this to keep
 * its final install summary honest — keep the grep in scripts/install.sh in
 * sync. The bash harness in test/install-orphaned-sandbox-recovery.test.ts
 * builds its stub output from this constant and drives the real install.sh
 * grep, so drift on either side fails that suite.
 */
export const ORPHANED_SANDBOX_MARKER =
  "recorded sandbox(es) were not found on their recorded gateway";

export interface OrphanClassificationOptions<Entry> {
  /** Names the selected gateway observes in any phase. */
  observedNames: ReadonlySet<string>;
  /** Names a confirming second listing observed as Ready mid-run. */
  reconnectedNames: ReadonlySet<string>;
  selectedGatewayName: string;
  /** Resolve a sandbox's persisted gateway binding; may throw when invalid. */
  resolveGatewayBinding: (sandbox: Entry) => string;
}

/**
 * Registry sandboxes that are unobserved on the selected gateway while their
 * persisted binding resolves to that same gateway. Sandboxes bound to a
 * different gateway are excluded (they may be healthy there), as are ones a
 * confirming second listing observed. Callers additionally exclude sandboxes
 * a prepared-backup recovery restores.
 */
export function classifyOrphanedRegistrySandboxes<Entry extends { name: string }>(
  sandboxes: readonly Entry[],
  options: OrphanClassificationOptions<Entry>,
): Entry[] {
  return sandboxes.filter((sandbox) => {
    if (options.observedNames.has(sandbox.name)) return false;
    if (options.reconnectedNames.has(sandbox.name)) return false;
    try {
      return options.resolveGatewayBinding(sandbox) === options.selectedGatewayName;
    } catch {
      // Invalid persisted binding — surfaced by the recovery-candidate guard;
      // never classify a corrupted row as an orphan here.
      return false;
    }
  });
}

export function orphanedRegistrySummary(names: readonly string[]): string {
  return `${names.length} ${ORPHANED_SANDBOX_MARKER}: ${names.join(", ")}.`;
}

export function orphanedRegistryRemediation(cliName: string): string {
  return `Their gateway registration or Docker image may have been removed (for example by \`${cliName} uninstall\`), so they cannot be recovered automatically — run \`${cliName} <name> destroy\` to clear a stranded record, then \`${cliName} onboard\` to rebuild it.`;
}
