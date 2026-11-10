#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Shared by the readable bundles and the minified worker. The image build and
// managed-startup transaction own this file; process proxy variables do not.
export const OPENCLAW_EXPLICIT_PROXY_GUARD = String.raw`
if (process.env.OPENSHELL_SANDBOX === "1" && arguments[0]?.mode === "explicit-proxy") {
  const proxyFs = process.getBuiltinModule("node:fs");
  let proxyFd;
  try {
    proxyFd = proxyFs.openSync("/usr/local/share/nemoclaw/openclaw-proxy-url", proxyFs.constants.O_RDONLY | proxyFs.constants.O_NOFOLLOW | proxyFs.constants.O_NONBLOCK);
    const before = proxyFs.fstatSync(proxyFd);
    if (!before.isFile() || before.uid !== 0 || before.gid !== 0 || (before.mode & 0o7777) !== 0o444 || before.nlink !== 1 || before.size > 512) throw Error();
    const bytes = Buffer.alloc(513);
    const count = proxyFs.readSync(proxyFd, bytes, 0, bytes.length, 0);
    const after = proxyFs.fstatSync(proxyFd);
    if (count !== before.size || !["size", "mode", "uid", "gid", "nlink", "mtimeMs", "ctimeMs"].every(key => after[key] === before[key])) throw Error();
    const trusted = bytes.subarray(0, count).toString("utf8");
    if (!/^http:\/\/[A-Za-z0-9._-]+:[0-9]{1,5}\n$/.test(trusted)) throw Error();
    const expected = new URL(trusted.trim());
    const selected = new URL(arguments[0].proxyUrl);
    if (selected.href !== expected.href) throw Error();
    return;
  } catch {
    throw Error("Explicit proxy must match the root-owned OpenShell proxy endpoint");
  } finally {
    if (proxyFd !== undefined) proxyFs.closeSync(proxyFd);
  }
}
/* nemoclaw: validated OpenShell explicit proxy */
`;

export function patchOpenClawExplicitProxyText(source: string): string {
  const entry = /async function assertExplicitProxyAllowed\([^)]*\)\s*\{/g;
  const matches = [...source.matchAll(entry)];
  if (matches.length !== 1) {
    throw new Error("Expected one reviewed OpenClaw explicit proxy validator");
  }
  if (source.includes(OPENCLAW_EXPLICIT_PROXY_GUARD)) {
    const match = matches[0]!;
    if (
      !source.slice(match.index + match[0].length).startsWith(OPENCLAW_EXPLICIT_PROXY_GUARD) ||
      source.split(OPENCLAW_EXPLICIT_PROXY_GUARD).length !== 2
    ) {
      throw new Error("OpenClaw explicit proxy guard is outside its reviewed entrypoint");
    }
    return source;
  }
  return source.replace(entry, (match) => match + OPENCLAW_EXPLICIT_PROXY_GUARD);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) throw new Error("Expected an OpenClaw bundle path");
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("OpenClaw bundle is not a regular file");
    const source = fs.readFileSync(fd, "utf8");
    const patched = patchOpenClawExplicitProxyText(source);
    if (patched !== source) {
      const bytes = Buffer.from(patched);
      let offset = 0;
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!written) throw new Error("OpenClaw proxy patch write made no progress");
        offset += written;
      }
      fs.ftruncateSync(fd, bytes.length);
    }
  } finally {
    fs.closeSync(fd);
  }
}
