#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WORKER_ARCHIVE_DELETE_PATCHES } from "./patch-openclaw-secondary-main-session-delete.mts";
import { OPENCLAW_EXPLICIT_PROXY_GUARD } from "./patch-openclaw-explicit-proxy.mts";
import { WORKER_ARCHIVE_MCP_PATCHES } from "./patch-openclaw-worker-mcp-reliability.mts";
import { WORKER_ARCHIVE_DEVICE_PATCHES } from "./patch-openclaw-worker-device-approval.mts";

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
    `async function assertExplicitProxyAllowed(Ot,Zt,_n,Dn,kn){${OPENCLAW_EXPLICIT_PROXY_GUARD}/* nemoclaw: worker explicit proxy */`,
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

// Exact split and embedded modules in the reviewed 2026.10.5 worker archive.
// The archive helper verifies the complete restored upstream manifest, including
// every untouched file, before publishing a new content-addressed archive.
const ARCHIVE_TOOL_CATALOG_PATCHES = {
  "sqlite-store.worker.mjs": [
    [
      "function isDirectVisibleCatalogTool(Ot,Kt){let Zt=classifyTool(Ot);return Zt.source===`openclaw`&&(Kt.has(Ot.name)||isCoreCodingSurfaceToolName(Ot.name)&&Zt.sourceName===`core`)}",
      'function isDirectVisibleCatalogTool(Ot,Kt){let Zt=classifyTool(Ot);return Zt.source===`openclaw`&&(Kt.has(Ot.name)||!((process.env.NEMOCLAW_UPSTREAM_PROVIDER??"").trim()==="llama-cpp-local")&&isCoreCodingSurfaceToolName(Ot.name)&&Zt.sourceName===`core`)}/* nemoclaw: worker llama.cpp compact tools */',
    ],
    [
      "args:Optional$2(Record(String$2(),Unknown(),{description:`Tool input.`}))",
      'args:Optional$2((process.env.NEMOCLAW_UPSTREAM_PROVIDER??"").trim()==="llama-cpp-local"?String$2({description:"JSON-encoded tool input object."}):Record(String$2(),Unknown(),{description:`Tool input.`}))/* nemoclaw: worker llama.cpp input schema */',
    ],
    [
      "Dn=Zt.args??Zt.input,kn=isRecord$3(Dn)&&Object.keys(Dn).length===0;",
      'Dn=Zt.args??Zt.input;if(typeof Dn==="string"&&(process.env.NEMOCLAW_UPSTREAM_PROVIDER??"").trim()==="llama-cpp-local"){try{const nemoclawParsed=JSON.parse(Dn);if(!isRecord$3(nemoclawParsed))throw new Error("not an object");Dn=nemoclawParsed}catch{throw new ToolInputError("args must be a JSON-encoded object.")}}/* nemoclaw: worker llama.cpp input parsing */let kn=isRecord$3(Dn)&&Object.keys(Dn).length===0;',
    ],
  ],
  "worker-chunk-DnMB5DVi.mjs": [
    [
      "function isDirectVisibleCatalogTool(e,t){let n=classifyTool(e);return n.source===`openclaw`&&(t.has(e.name)||Pt(e.name)&&n.sourceName===`core`)}",
      'function isDirectVisibleCatalogTool(e,t){let n=classifyTool(e);return n.source===`openclaw`&&(t.has(e.name)||!((process.env.NEMOCLAW_UPSTREAM_PROVIDER??"").trim()==="llama-cpp-local")&&Pt(e.name)&&n.sourceName===`core`)}/* nemoclaw: worker llama.cpp compact tools */',
    ],
    [
      "args:x(me(b(),he(),{description:`Tool input.`}))",
      'args:x((process.env.NEMOCLAW_UPSTREAM_PROVIDER??"").trim()==="llama-cpp-local"?b({description:"JSON-encoded tool input object."}):me(b(),he(),{description:`Tool input.`}))/* nemoclaw: worker llama.cpp input schema */',
    ],
    [
      "i=n.args??n.input,a=p(i)&&Object.keys(i).length===0;",
      'i=n.args??n.input;if(typeof i==="string"&&(process.env.NEMOCLAW_UPSTREAM_PROVIDER??"").trim()==="llama-cpp-local"){try{const nemoclawParsed=JSON.parse(i);if(!p(nemoclawParsed))throw new Error("not an object");i=nemoclawParsed}catch{throw new E("args must be a JSON-encoded object.")}}/* nemoclaw: worker llama.cpp input parsing */let a=p(i)&&Object.keys(i).length===0;',
    ],
  ],
} as const;

const ARCHIVE_PATCHES: Record<string, readonly (readonly [string, string])[]> = {
  "sqlite-store.worker.mjs": [
    PATCHES[0],
    [
      "async function assertExplicitProxyAllowed(Ot,Kt,Zt,_n,Dn){",
      `async function assertExplicitProxyAllowed(Ot,Kt,Zt,_n,Dn){${OPENCLAW_EXPLICIT_PROXY_GUARD}/* nemoclaw: worker explicit proxy */`,
    ],
    [
      "return fetchWithSsrFGuard(Zt?withTrustedEnvProxyGuardedFetchMode(Dn):withStrictGuardedFetchMode(Dn))",
      'const hostGatewayPolicy=process.env.OPENSHELL_SANDBOX === "1"&&Zt&&new URL(Dn.url).hostname === "host.openshell.internal"?{...Dn.policy,allowedHostnames:[...Dn.policy?.allowedHostnames??[],"host.openshell.internal"]}:Dn.policy;return fetchWithSsrFGuard(Zt?withTrustedEnvProxyGuardedFetchMode({...Dn,policy:hostGatewayPolicy}):withStrictGuardedFetchMode(Dn))/* nemoclaw: worker host gateway */',
    ],
    [
      "let ea=Jn===GUARDED_FETCH_MODE.STRICT&&isManagedProxyActive(),",
      'let ea=Jn===GUARDED_FETCH_MODE.STRICT&&(isManagedProxyActive()||(process.env.OPENSHELL_SANDBOX === "1"&&!Di)),/* nemoclaw: worker strict proxy */',
    ],
    PATCHES[4],
    PATCHES[5],
    WORKER_ARCHIVE_DELETE_PATCHES["sqlite-store.worker.mjs"],
    ...ARCHIVE_TOOL_CATALOG_PATCHES["sqlite-store.worker.mjs"],
  ],
  "worker-chunk-DnMB5DVi.mjs": ARCHIVE_TOOL_CATALOG_PATCHES["worker-chunk-DnMB5DVi.mjs"],
  "worker-chunk-CMCl78Z0.mjs": [
    [
      "withStrictGuardedFetchMode as s",
      "withTrustedEnvProxyGuardedFetchMode as s/* nemoclaw: worker media proxy */",
    ],
    [
      "async function assertExplicitProxyAllowed(e,t,n,r,i){",
      `async function assertExplicitProxyAllowed(e,t,n,r,i){${OPENCLAW_EXPLICIT_PROXY_GUARD}/* nemoclaw: worker explicit proxy */`,
    ],
    [
      "let b=f===Y.STRICT&&isManagedProxyActive(),",
      'let b=f===Y.STRICT&&(isManagedProxyActive()||(process.env.OPENSHELL_SANDBOX === "1"&&!M)),/* nemoclaw: worker strict proxy */',
    ],
  ],
  "worker-chunk-A05CVh6v.mjs": [
    [
      "return l(n?c(i):u(i))",
      'const hostGatewayPolicy=process.env.OPENSHELL_SANDBOX === "1"&&n&&new URL(i.url).hostname === "host.openshell.internal"?{...i.policy,allowedHostnames:[...i.policy?.allowedHostnames??[],"host.openshell.internal"]}:i.policy;return l(n?c({...i,policy:hostGatewayPolicy}):u(i))/* nemoclaw: worker host gateway */',
    ],
  ],
  "worker-chunk-DjEXxQHh.mjs": [WORKER_ARCHIVE_DELETE_PATCHES["worker-chunk-DjEXxQHh.mjs"]],
  "worker-chunk-BS-ufNRt.mjs": [PATCHES[4]],
  "worker-chunk-ue1VvP9S.mjs": [
    [
      "r=2147483647,i=15e3,a=3e4",
      "r=2147483647,i=6e4/* nemoclaw: worker handshake timeout */,a=3e4",
    ],
  ],
};

export function patchOpenClawWorkerArchiveModule(
  source: string,
  moduleName: string,
): {
  text: string;
  originalSize: number;
  originalSha256: string;
} {
  const patches = [
    ...(ARCHIVE_PATCHES[moduleName] ?? []),
    ...(WORKER_ARCHIVE_DEVICE_PATCHES[moduleName] ?? []),
    ...(WORKER_ARCHIVE_MCP_PATCHES[moduleName] ?? []),
  ];
  if (patches.length === 0)
    throw new Error(`Unreviewed OpenClaw worker archive module: ${moduleName}`);
  let original = source;
  for (const [upstream, patched] of patches) {
    const patchedCount = original.split(patched).length - 1;
    const upstreamCount = original.replace(patched, "").split(upstream).length - 1;
    if (patchedCount === 1 && upstreamCount === 0) original = original.replace(patched, upstream);
    else if (patchedCount !== 0 || upstreamCount !== 1)
      throw new Error(`Unreviewed worker expression in ${moduleName}: ${upstream}`);
  }
  let text = original;
  for (const [upstream, patched] of patches) text = text.replace(upstream, patched);
  return {
    text,
    originalSize: Buffer.byteLength(original),
    originalSha256: createHash("sha256").update(original).digest("hex"),
  };
}

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
  const metadata = JSON.parse(fs.readFileSync(path.join(dist, "..", "package.json"), "utf8")) as {
    version?: string;
  };
  if (metadata.version === "2026.10.5") {
    const output = execFileSync(
      "python3",
      [
        path.join(import.meta.dirname, "patch-openclaw-worker-archive.py"),
        dist,
        process.execPath,
        fileURLToPath(import.meta.url),
      ],
      { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(output).changed;
  }
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
  if (process.argv[2] === "--archive-module" && process.argv.length === 5) {
    const moduleName = process.argv[3]!;
    const file = process.argv[4]!;
    const source = fs.readFileSync(file, "utf8");
    const result = patchOpenClawWorkerArchiveModule(source, moduleName);
    if (source !== result.text) fs.writeFileSync(file, result.text);
    process.stdout.write(
      JSON.stringify({ originalSize: result.originalSize, originalSha256: result.originalSha256 }),
    );
  } else {
    const dist = process.argv[2];
    if (!dist || process.argv.length !== 3)
      throw new Error("Usage: patch-openclaw-worker-proxy.mts <dist>");
    patchOpenClawWorkerProxy(dist);
  }
}
