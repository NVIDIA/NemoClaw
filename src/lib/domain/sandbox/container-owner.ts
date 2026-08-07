// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve which OpenShell container owns a given sandbox name.
 *
 * OpenShell v0.0.85 names sandbox containers either as `openshell-<sandbox>`
 * (no suffix) or `openshell-<sandbox>-<id>`, where `<id>` is appended by
 * OpenShell at runtime. OpenShell v0.0.99 additionally uses the exact default
 * workspace-qualified form `openshell-default--<sandbox>-<id>`. NemoClaw does
 * not infer ownership from any other workspace qualifier.
 *
 * Two prefix collisions are possible:
 *
 *   1. A sandbox name can be a prefix of another sandbox name
 *      (`my` vs `my-assistant`).
 *   2. Even with a hyphen-free `<id>`, a sandbox name can be a prefix
 *      of another sandbox name whose own suffix is hyphen-free
 *      (`my-assistant` vs `my-assistant-prod`).
 *
 * The longest-owner rule resolves each candidate identity to the longest
 * registered sandbox name that could claim it, then only accepts candidates
 * that resolve back to the queried sandbox. The legacy exact-name form is
 * preferred before suffixed forms so `openshell-<sandbox>` always wins over an
 * unrelated `openshell-<sandbox>-<runtime-id>` co-tenant. Multiple non-exact
 * candidates remain ambiguous and fail closed.
 */
type ParsedContainerIdentity = {
  identity: string;
  workspaceQualified: boolean;
};

function parseContainerIdentity(containerName: string): ParsedContainerIdentity | null {
  const prefix = "openshell-";
  if (!containerName.startsWith(prefix)) return null;
  const stripped = containerName.slice(prefix.length);
  const workspaceSeparator = stripped.indexOf("--");
  if (workspaceSeparator === -1) {
    return stripped ? { identity: stripped, workspaceQualified: false } : null;
  }

  // v0.0.99 authority is qualified only by the reviewed default workspace.
  // Reject other or repeated separators instead of treating them as a legacy
  // sandbox prefix.
  const defaultWorkspacePrefix = "default--";
  if (
    !stripped.startsWith(defaultWorkspacePrefix) ||
    stripped.indexOf("--", defaultWorkspacePrefix.length) !== -1
  ) {
    return null;
  }
  const identity = stripped.slice(defaultWorkspacePrefix.length);
  if (!identity || identity.startsWith("-") || identity.endsWith("-")) return null;
  return { identity, workspaceQualified: true };
}

export function resolveSandboxContainerOwner(
  containerNamesRaw: string,
  sandboxName: string,
  registeredSandboxNames: Iterable<string>,
): string | null {
  const ourExact = `openshell-${sandboxName}`;
  const known = new Set<string>(registeredSandboxNames);
  known.add(sandboxName);
  const candidates = containerNamesRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (candidates.includes(ourExact)) return ourExact;
  const knownArr = [...known];
  const ownedCandidates: string[] = [];
  for (const candidate of candidates) {
    const parsed = parseContainerIdentity(candidate);
    if (!parsed) continue;
    const owner = knownArr
      .filter((name) => parsed.identity === name || parsed.identity.startsWith(`${name}-`))
      .sort((a, b) => b.length - a.length)[0];
    if (owner !== sandboxName) continue;
    if (parsed.workspaceQualified) {
      const runtimeId = parsed.identity.slice(`${owner}-`.length);
      if (!parsed.identity.startsWith(`${owner}-`) || runtimeId.length === 0) continue;
    }
    ownedCandidates.push(candidate);
  }
  return ownedCandidates.length === 1 ? (ownedCandidates[0] ?? null) : null;
}
