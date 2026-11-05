#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_SHA256 = "f5d2a7a135361cd39680344842b825c9f9db2e1524417c3c1297a53ce7913ff8";
const MARKER = "// nemoclaw: resolve each Linux source root with the native filesystem API";
const BEFORE =
  "function withPluginSourceFile(source, boundary, read) {\n\tconst opened = openRootFileSync$1({";
const AFTER = `function withPluginSourceFile(source, boundary, read) {
\t${MARKER}
\tlet rootRealPath;
\tif (process.platform === "linux") {
\t\ttry { rootRealPath = fs.realpathSync.native(path.resolve(boundary)); } catch {}
\t}
\tconst opened = openRootFileSync$1({
\t\trootRealPath,`;

export function patchPluginSourceRoot(source: string): string {
  if (source.includes(MARKER)) {
    if (
      source.split(MARKER).length !== 2 ||
      source.split(AFTER).length !== 2 ||
      source.replace(AFTER, "").includes(BEFORE)
    ) {
      throw new Error("Incomplete OpenClaw plugin source root patch");
    }
    return source;
  }
  if (source.split(BEFORE).length !== 2)
    throw new Error("Unrecognized OpenClaw plugin source root boundary");
  return source.replace(BEFORE, () => AFTER);
}

export function patchOpenClawPluginSourceRoot(dist: string, audit = false): void {
  const realDist = fs.realpathSync(dist);
  const root = path.dirname(realDist);
  if (
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version !== "2026.10.5"
  ) {
    throw new Error("Unsupported OpenClaw plugin source root version");
  }
  const entry = createRequire(path.join(root, "package.json")).resolve(
    "@openclaw/fs-safe/advanced",
  );
  const dependency = JSON.parse(
    fs.readFileSync(path.join(path.dirname(path.dirname(entry)), "package.json"), "utf8"),
  );
  if (dependency.name !== "@openclaw/fs-safe" || dependency.version !== "0.25.0") {
    throw new Error("Unsupported OpenClaw filesystem admission dependency");
  }
  // The second member of this family is a facade, not another implementation.
  const facade = fs.readFileSync(
    path.join(realDist, "plugin-generation-source-lookup-LM75CqdW.mjs"),
  );
  if (
    createHash("sha256").update(facade).digest("hex") !==
    "12dd0e53296c02dc5201ee6c5efdec0f9f85e4dd7460fb568df3af612547ffc0"
  ) {
    throw new Error("OpenClaw plugin source lookup facade changed");
  }
  const file = path.join(realDist, "plugin-generation-source-lookup-Dg6DuWgm.mjs");
  const source = fs.readFileSync(file, "utf8");
  const patched = patchPluginSourceRoot(source);
  // Invert only this complete patch before verifying the reviewed native bytes.
  // Keep every root/leaf/descriptor check in the existing guarded-open API.
  const original = source.includes(MARKER) ? source.replace(AFTER, BEFORE) : source;
  if (createHash("sha256").update(original).digest("hex") !== SOURCE_SHA256) {
    throw new Error("OpenClaw plugin source lookup bytes changed");
  }
  if (audit && source !== patched) throw new Error("Missing OpenClaw plugin source root patch");
  if (!audit && source !== patched) fs.writeFileSync(file, patched);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const audit = args[0] === "--audit";
  const dist = args[audit ? 1 : 0];
  if (!dist || args.length !== (audit ? 2 : 1))
    throw new Error("Usage: patch-openclaw-plugin-source-root.mts [--audit] <dist>");
  patchOpenClawPluginSourceRoot(dist, audit);
}
