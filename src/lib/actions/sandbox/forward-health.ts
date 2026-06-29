// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import type { SandboxForwardHealth, SandboxForwardListEntry } from "./process-recovery";

export function classifySandboxForwardHealth(
  entries: SandboxForwardListEntry[],
  sandboxName: string,
  port: string,
): Exclude<SandboxForwardHealth, null> {
  const match = entries.find((entry) => entry.port === port);
  if (!match) return false;
  if (match.sandboxName !== sandboxName) return "occupied";
  return match.status === "running";
}

/**
 * Like {@link classifySandboxForwardHealth} but accepts a reachability
 * callback that probes whether the local forwarded port actually answers.
 * When the entry-based classification would return `false`, the
 * reachability check overrides it: a port that answers is healthy
 * regardless of what `forward list` reports. The "occupied" verdict is
 * preserved — we never silently take over a forward owned by another
 * sandbox, even if that forward happens to be reachable.
 */
export function classifyForwardHealthWithReachability(
  entries: SandboxForwardListEntry[],
  sandboxName: string,
  port: string,
  isReachable: () => boolean,
): Exclude<SandboxForwardHealth, null> {
  const verdict = classifySandboxForwardHealth(entries, sandboxName, port);
  if (verdict !== false) return verdict;
  return isReachable() ? true : false;
}

/**
 * Synchronous reachability check for a local port. Used to override a
 * negative `openshell forward list` verdict when the forward is actually
 * still serving traffic.
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
