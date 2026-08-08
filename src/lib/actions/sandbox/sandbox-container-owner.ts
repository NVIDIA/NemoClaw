// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve which OpenShell container owns a given sandbox name.
 *
 * OpenShell names sandbox containers either as `openshell-<sandbox>` (no
 * suffix) or `openshell-<sandbox>-<id>`, where `<id>` is appended by openshell
 * at runtime. Two prefix collisions are possible:
 *
 *   1. A sandbox name can be a prefix of another sandbox name
 *      (`my` vs `my-assistant`).
 *   2. Even with a hyphen-free `<id>`, a sandbox name can be a prefix
 *      of another sandbox name whose own suffix is hyphen-free
 *      (`my-assistant` vs `my-assistant-prod`).
 *
 * The longest-owner rule resolves each candidate to the longest registered
 * sandbox name that could claim it, then only accepts candidates that resolve
 * back to the queried sandbox. The exact-name form is preferred before
 * suffixed forms so `openshell-<sandbox>` always wins over an unrelated
 * `openshell-<sandbox>-<runtime-id>` co-tenant.
 */
export function resolveSandboxContainerOwner(
  containerNamesRaw: string,
  sandboxName: string,
  registeredSandboxNames: Iterable<string>,
): string | null {
  const ourPrefix = `openshell-${sandboxName}-`;
  const ourExact = `openshell-${sandboxName}`;
  const known = new Set<string>(registeredSandboxNames);
  known.add(sandboxName);
  const candidates = containerNamesRaw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line === ourExact || line.startsWith(ourPrefix));
  if (candidates.includes(ourExact)) return ourExact;
  const knownArr = [...known];
  for (const candidate of candidates) {
    const stripped = candidate.replace(/^openshell-/, "");
    const owner = knownArr
      .filter((name) => stripped === name || stripped.startsWith(`${name}-`))
      .sort((a, b) => b.length - a.length)[0];
    if (owner === sandboxName) return candidate;
  }
  return null;
}
