// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const OPENSHELL_DEFAULT_WORKSPACE = "default";

/** Return OpenShell v0.0.99's SSH config alias for a default-workspace sandbox. */
export function openshellSandboxSshHost(sandboxName: string): string {
  return `openshell-${sandboxName}.${OPENSHELL_DEFAULT_WORKSPACE}`;
}

/** Return the unqualified SSH config alias emitted by OpenShell v0.0.85. */
export function legacyOpenshellSandboxSshHost(sandboxName: string): string {
  return `openshell-${sandboxName}`;
}

/**
 * Select only an exact sandbox alias declared by the captured OpenShell SSH
 * config. Prefer v0.0.99's workspace-qualified alias, while retaining the
 * v0.0.85 alias long enough to back up a running sandbox before upgrade.
 */
export function resolveOpenshellSandboxSshHost(
  sandboxName: string,
  sshConfig: string,
): string | null {
  const declaredHosts = new Set<string>();
  for (const rawLine of sshConfig.split(/\r?\n/u)) {
    const fields = rawLine.trim().split(/\s+/u);
    if (fields[0]?.toLowerCase() !== "host") continue;
    for (const host of fields.slice(1)) {
      if (!host.startsWith("!") && !host.includes("*") && !host.includes("?")) {
        declaredHosts.add(host);
      }
    }
  }

  const current = openshellSandboxSshHost(sandboxName);
  if (declaredHosts.has(current)) return current;
  const legacy = legacyOpenshellSandboxSshHost(sandboxName);
  return declaredHosts.has(legacy) ? legacy : null;
}
