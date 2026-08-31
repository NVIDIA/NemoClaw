// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { probeLocalForwardListener } from "../../adapters/openshell/local-forward-listener";

export type SandboxForwardListEntry = {
  sandboxName: string;
  bind?: string;
  port: string;
  status: string;
};

export type SandboxForwardHealth = boolean | "occupied" | null;

/** Whether OpenShell reports a forward as live in either supported CLI vocabulary. */
export function isLiveSandboxForwardStatus(status: string): boolean {
  return status === "running" || status === "active";
}

function liveEntriesForPort(
  entries: SandboxForwardListEntry[],
  port: string,
): SandboxForwardListEntry[] {
  return entries.filter((entry) => entry.port === port && isLiveSandboxForwardStatus(entry.status));
}

export function classifySandboxForwardHealth(
  entries: SandboxForwardListEntry[],
  sandboxName: string,
  port: string,
  expectedBind?: string,
): Exclude<SandboxForwardHealth, null> {
  const liveEntries = liveEntriesForPort(entries, port);
  if (liveEntries.some((entry) => entry.sandboxName !== sandboxName)) return "occupied";
  return liveEntries.some(
    (entry) =>
      entry.sandboxName === sandboxName &&
      (expectedBind === undefined ||
        entry.bind === expectedBind ||
        (expectedBind === "0.0.0.0" && ["::", "[::]", "*"].includes(entry.bind ?? ""))),
  );
}

/**
 * Like {@link classifySandboxForwardHealth} but accepts a reachability
 * callback that probes whether the local forwarded port actually answers.
 * OpenShell's exact live owner metadata remains authoritative: reachability
 * cannot prove which process owns a local listener, so it must never upgrade a
 * missing or non-running entry. A target-owned running row is necessary but not
 * sufficient; it must also answer the local transport probe so stale list data
 * cannot make recovery report a dead forward as healthy.
 */
export function classifyForwardHealthWithReachability(
  entries: SandboxForwardListEntry[],
  sandboxName: string,
  port: string,
  isReachable: () => boolean,
  expectedBind?: string,
): Exclude<SandboxForwardHealth, null> {
  const ownership = classifySandboxForwardHealth(entries, sandboxName, port, expectedBind);
  if (ownership !== true) return ownership;
  return isReachable();
}

/**
 * Synchronous reachability check for a local port. Reachability is transport
 * evidence only; callers must pair it with authoritative OpenShell owner
 * metadata and must not treat an arbitrary local listener as an owned forward.
 */
export function isLocalForwardReachable(port: number): boolean {
  return probeLocalForwardListener(port);
}
