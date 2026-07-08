// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

export type SandboxForwardListEntry = {
  sandboxName: string;
  port: string;
  status: string;
};

export type SandboxForwardHealth = boolean | "occupied" | null;

function liveEntriesForPort(
  entries: SandboxForwardListEntry[],
  port: string,
): SandboxForwardListEntry[] {
  return entries.filter((entry) => entry.port === port && entry.status === "running");
}

export function classifySandboxForwardHealth(
  entries: SandboxForwardListEntry[],
  sandboxName: string,
  port: string,
): Exclude<SandboxForwardHealth, null> {
  const liveEntries = liveEntriesForPort(entries, port);
  if (liveEntries.some((entry) => entry.sandboxName !== sandboxName)) return "occupied";
  return liveEntries.some((entry) => entry.sandboxName === sandboxName);
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
): Exclude<SandboxForwardHealth, null> {
  const ownership = classifySandboxForwardHealth(entries, sandboxName, port);
  if (ownership !== true) return ownership;
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
