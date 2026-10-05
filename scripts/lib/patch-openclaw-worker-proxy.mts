#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The 2026.9.5 worker embeds minified copies of the modules patched in Dockerfile.
// Match reviewed expressions exactly: guessing renamed locals can corrupt the
// dispatcher policy or silently leave a worker bypassing the sandbox proxy.
const PATCHES = [
  [
    "withStrictGuardedFetchMode:()=>withStrictGuardedFetchMode",
    "withStrictGuardedFetchMode:()=>withTrustedEnvProxyGuardedFetchMode/* nemoclaw: worker media proxy */",
  ],
  [
    "async function assertExplicitProxyAllowed(Ot,Zt,_n,Dn,kn){",
    'async function assertExplicitProxyAllowed(Ot,Zt,_n,Dn,kn){if(process.env.OPENSHELL_SANDBOX === "1")return;/* nemoclaw: worker explicit proxy */',
  ],
  [
    "return fetchWithSsrFGuard(_n?withTrustedEnvProxyGuardedFetchMode(kn):withStrictGuardedFetchMode(kn))",
    'const hostGatewayPolicy=process.env.OPENSHELL_SANDBOX === "1"&&_n&&new URL(kn.url).hostname === "host.openshell.internal"?{...kn.policy,allowedHostnames:[...kn.policy?.allowedHostnames??[],"host.openshell.internal"]}:kn.policy;return fetchWithSsrFGuard(_n?withTrustedEnvProxyGuardedFetchMode({...kn,policy:hostGatewayPolicy}):withStrictGuardedFetchMode(kn))/* nemoclaw: worker host gateway */',
  ],
  [
    "let Mi=Ln===GUARDED_FETCH_MODE.STRICT&&isManagedProxyActive(),",
    'let Mi=Ln===GUARDED_FETCH_MODE.STRICT&&(isManagedProxyActive()||(process.env.OPENSHELL_SANDBOX === "1"&&!wi)),/* nemoclaw: worker strict proxy */',
  ],
  [
    "auditContext:`cron-model-provider-preflight`",
    'mode:"trusted_env_proxy",auditContext:`cron-model-provider-preflight`/* nemoclaw: worker cron proxy */',
  ],
  [
    "DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS=15e3",
    "DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS=6e4/* nemoclaw: worker handshake timeout */",
  ],
] as const;

export function patchOpenClawWorkerProxyText(source: string): string {
  let result = source;
  for (const [upstream, patched] of PATCHES) {
    const patchedCount = result.split(patched).length - 1;
    // Remove the full patched expression before counting its upstream prefix.
    const upstreamCount = result.replace(patched, "").split(upstream).length - 1;
    if (patchedCount === 1 && upstreamCount === 0) continue;
    if (patchedCount !== 0 || upstreamCount !== 1) {
      throw new Error(`Unreviewed OpenClaw worker proxy expression: ${upstream}`);
    }
    result = result.replace(upstream, patched);
  }
  return result;
}

export function patchOpenClawWorkerProxy(dist: string): boolean {
  const worker = path.join(dist, "worker", "worker.mjs");
  let descriptor: number;
  try {
    descriptor = fs.openSync(worker, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Required OpenClaw 2026.9.5 worker is missing", { cause: error });
    }
    throw error;
  }
  try {
    if (!fs.fstatSync(descriptor).isFile())
      throw new Error("OpenClaw worker is not a regular file");
    const metadata = JSON.parse(fs.readFileSync(path.join(dist, "..", "package.json"), "utf8")) as {
      version?: string;
    };
    if (metadata.version !== "2026.9.5") {
      throw new Error(`Unreviewed OpenClaw worker version: ${metadata.version}`);
    }
    const source = fs.readFileSync(descriptor, "utf8");
    const patched = patchOpenClawWorkerProxyText(source);
    if (patched === source) return false;
    // Keep the checked, read, and written file identity bound to one descriptor.
    // A replaced pathname must never redirect this write to another file.
    const bytes = Buffer.from(patched);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (written === 0) throw new Error("OpenClaw worker patch write made no progress");
      offset += written;
    }
    fs.ftruncateSync(descriptor, bytes.length);
    return true;
  } finally {
    fs.closeSync(descriptor);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dist = process.argv[2];
  if (!dist || process.argv.length !== 3)
    throw new Error("Usage: patch-openclaw-worker-proxy.mts <dist>");
  patchOpenClawWorkerProxy(dist);
}
