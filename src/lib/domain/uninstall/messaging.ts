// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// User-facing uninstall messaging whose wording is load-bearing (#6520,
// #3456 sub-bug 4): a no-op delete must describe the actual state instead of
// the self-contradictory `Deleted … skipped`, and preserving sandboxes.json
// must say up front that the kept registry is not recoverable on its own.

export const OPENSHELL_SANDBOXES_DELETE_SKIP_MESSAGE =
  "OpenShell sandboxes already removed or unreachable";

export function providerDeleteSkipMessage(provider: string): string {
  return `Provider '${provider}' already removed or unreachable`;
}

export function gatewayDestroySkipMessage(gatewayLabel: string): string {
  return `Gateway '${gatewayLabel}' already removed or unreachable`;
}

/**
 * Warnings shown when uninstall preserves sandboxes.json: uninstall removes
 * the gateway registration, provider registrations, and Docker image the
 * recorded sandboxes depend on, so a later reinstall cannot bring them back
 * on its own. Say so at the moment the preserve choice is made instead of
 * letting the reinstall report false success while silently orphaning the
 * user's sandbox (#6520). Empty when sandboxes.json is not being preserved.
 */
export function preservedRegistryUnrecoverableWarnings(
  preservable: readonly string[],
  cliName: string,
): string[] {
  if (!preservable.includes("sandboxes.json")) return [];
  return [
    "Preserved sandboxes.json references the gateway, provider registrations, and Docker image this uninstall removes — its recorded sandboxes cannot be recovered automatically on reinstall.",
    `After reinstalling, run '${cliName} <name> destroy' to clear a stranded sandbox and '${cliName} onboard' to rebuild it, or rerun uninstall with --destroy-user-data to purge the registry.`,
  ];
}
