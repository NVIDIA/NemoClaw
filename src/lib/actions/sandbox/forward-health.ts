// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

export type SandboxForwardListEntry = {
  sandboxName: string;
  bind?: string;
  port: string;
  pid?: number | null;
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

function matchesForwardBind(bind: string | undefined, expectedBind: string | undefined): boolean {
  return (
    expectedBind === undefined ||
    bind === expectedBind ||
    (expectedBind === "0.0.0.0" && ["::", "[::]", "*"].includes(bind ?? ""))
  );
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
    (entry) => entry.sandboxName === sandboxName && matchesForwardBind(entry.bind, expectedBind),
  );
}

/**
 * Like {@link classifySandboxForwardHealth} but accepts a reachability
 * callback that probes whether the local forwarded port actually answers.
 * OpenShell's owner receipt remains authoritative: reachability cannot prove
 * which process owns a local listener, so it must never upgrade a missing or
 * ambiguous entry. A target-owned row with OpenShell's positive PID receipt is
 * necessary but not sufficient. Live and stale-status rows must both answer
 * the local transport probe.
 */
export function classifyForwardHealthWithReachability(
  entries: SandboxForwardListEntry[],
  sandboxName: string,
  port: string,
  isReachable: () => boolean,
  expectedBind?: string,
): Exclude<SandboxForwardHealth, null> {
  const ownership = classifySandboxForwardHealth(entries, sandboxName, port, expectedBind);
  if (ownership === "occupied") return ownership;
  if (ownership === true) return isReachable();

  const portEntries = entries.filter((entry) => entry.port === port);
  const targetOwnsReceipt = portEntries.some(
    (entry) =>
      entry.sandboxName === sandboxName &&
      Number.isInteger(entry.pid) &&
      Number(entry.pid) > 0 &&
      matchesForwardBind(entry.bind, expectedBind),
  );
  const receiptOwnerIsAmbiguous = portEntries.some((entry) => entry.sandboxName !== sandboxName);
  if (!targetOwnsReceipt || receiptOwnerIsAmbiguous) return false;
  return isReachable();
}

/**
 * Synchronous reachability check for a local port. Reachability is transport
 * evidence only; callers must pair it with authoritative OpenShell owner
 * metadata and must not treat an arbitrary local listener as an owned forward.
 */
export function isLocalForwardReachable(port: number): boolean {
  const script =
    "const net=require('node:net');" +
    `const s=net.createConnection({host:'127.0.0.1',port:${port}});` +
    "s.setTimeout(1000);" +
    "s.on('connect',()=>{s.destroy();process.exit(0)});" +
    "s.on('error',()=>process.exit(1));" +
    "s.on('timeout',()=>{s.destroy();process.exit(1)});";
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf-8",
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 2000,
  });
  if (result.error) return false;
  return result.status === 0;
}
