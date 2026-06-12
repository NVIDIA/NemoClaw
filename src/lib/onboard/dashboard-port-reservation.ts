// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as registry from "../state/registry";

/**
 * Collect the dashboard ports held by every sandbox in the local registry
 * except the one currently being onboarded. Forwards on sibling gateways are
 * invisible to the active gateway's `forward list`, so the allocator needs
 * the registry view to keep dashboard ports distinct across gateways.
 */
export function collectRegistryReservedDashboardPorts(
  excludeSandboxName: string,
): ReadonlyMap<number, string> {
  const reserved = new Map<number, string>();
  try {
    const list = registry.listSandboxes();
    for (const entry of list.sandboxes) {
      if (entry.name === excludeSandboxName) continue;
      if (typeof entry.dashboardPort === "number" && Number.isFinite(entry.dashboardPort)) {
        reserved.set(entry.dashboardPort, entry.name);
      }
    }
  } catch {
    // The registry may be unreadable mid-onboard; downstream lsof + bind
    // probes are still the final authority on port availability.
  }
  return reserved;
}
