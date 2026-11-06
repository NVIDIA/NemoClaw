#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VERSION = "2026.9.2";

// OpenShell 0.1.3 returns addresses from these pools after evaluating DNS policy.
// Its supervisor checks each mapping again before connecting to the real target.
// Accept these answers only at the resolved-address boundary. URL literals,
// hostname policy, redirects, and all other address checks retain upstream rules.
export const SYNTHETIC_DNS_HELPER = [
  'import { isIP as nemoclawIsIP } from "node:net";',
  "function nemoclawIsSyntheticDnsAnswer(address) {",
  '\tif (process.env.OPENSHELL_SANDBOX !== "1") return false;',
  "\tif (nemoclawIsIP(address) === 4) {",
  '\t\tconst [first, second] = address.split(".").map(Number);',
  '\t\treturn first === 198 && (second === 18 || second === 19) && address !== "198.18.0.1";',
  "\t}",
  '\treturn nemoclawIsIP(address) === 6 && !address.includes("%") && /^fd23:6f70:656e:/i.test(address);',
  "}",
  "",
].join("\n");

const DNS_CHECK = "if (isBlockedHostnameOrIp(entry.address, policy))";
const NATIVE_DNS_CHECK =
  "if (!nemoclawIsSyntheticDnsAnswer(entry.address) && isBlockedHostnameOrIp(entry.address, policy))";

const WEB_FETCH =
  "return fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(resolved) : withStrictGuardedFetchMode(resolved));";
const NATIVE_WEB_FETCH = [
  // This existing host-gateway exception now applies without an HTTP proxy.
  // The caller's blocklist and hostname allowlist still apply before DNS.
  'const hostGatewayPolicy = process.env.OPENSHELL_SANDBOX === "1" && new URL(resolved.url).hostname === "host.openshell.internal" ? { ...resolved.policy, allowedHostnames: [...resolved.policy?.allowedHostnames ?? [], "host.openshell.internal"] } : resolved.policy;',
  "\tconst nativeResolved = { ...resolved, policy: hostGatewayPolicy };",
  "\treturn fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(nativeResolved) : withStrictGuardedFetchMode(nativeResolved));",
].join("\n");

export function patchNativeNetworkText(source: string, kind: "dns" | "web-fetch"): string {
  const original = kind === "dns" ? DNS_CHECK : WEB_FETCH;
  if (source.split(original).length !== 2) {
    throw new Error(`OpenClaw ${kind} boundary changed; expected one reviewed target`);
  }
  const replacement = kind === "dns" ? NATIVE_DNS_CHECK : NATIVE_WEB_FETCH;
  return (kind === "dns" ? SYNTHETIC_DNS_HELPER : "") + source.replace(original, replacement);
}

const TARGETS = [
  {
    file: "ssrf-0QyXWOVG.js",
    kind: "dns",
    before: "cb3ab9c9e3f1cbfe22a2f74b1668e0d18f03ebf1544f47954bee7ef4060cd032",
    after: "e1e1809e5ab2a298099aa842f1fa9b35e6d4f1af5ecde7700a79b8556103f757",
  },
  {
    file: "web-guarded-fetch-DfTFSIPT.js",
    kind: "web-fetch",
    before: "9c12e6147c90804b817aee328662a4837769a1928167b336a74815485d2dc633",
    after: "01e6b848c1aef3bedf0e11f3e6b3ea3f46d1a9e993b9f9e505140626aa790914",
  },
] as const;

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function patchOpenClawNativeNetwork(distDirectory: string): void {
  const metadata = JSON.parse(fs.readFileSync(path.join(distDirectory, "../package.json"), "utf8"));
  if (metadata.name !== "openclaw" || metadata.version !== VERSION) {
    throw new Error(`Native network patch requires reviewed openclaw@${VERSION}`);
  }
  const descriptors: number[] = [];
  try {
    // Keep validation and writes on the same files if a path is replaced.
    // Validate both modules before modifying either one.
    const changes = TARGETS.map((target) => {
      const file = path.join(distDirectory, target.file);
      const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      descriptors.push(fd);
      if (!fs.fstatSync(fd).isFile())
        throw new Error(`Expected a regular OpenClaw module: ${file}`);
      const source = fs.readFileSync(fd, "utf8");
      const digest = sha256(source);
      if (digest === target.after) return { fd, text: source };
      if (digest !== target.before) throw new Error(`Unreviewed OpenClaw network module: ${file}`);
      const text = patchNativeNetworkText(source, target.kind);
      if (sha256(text) !== target.after)
        throw new Error(`Unexpected native network patch output: ${file}`);
      return { fd, text };
    });
    for (const { fd, text } of changes) {
      const bytes = Buffer.from(text);
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (written === 0) throw new Error("OpenClaw module write made no progress");
        offset += written;
      }
      fs.ftruncateSync(fd, bytes.length);
    }
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.length !== 3)
    throw new Error("Usage: patch-openclaw-native-network.mts <openclaw-dist-dir>");
  patchOpenClawNativeNetwork(path.resolve(process.argv[2]!));
}
