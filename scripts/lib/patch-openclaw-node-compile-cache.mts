#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import * as module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Image setup leaves /tmp/node-compile-cache owned by root. The sandbox user
// cannot create OpenClaw's version namespace there, so native activation fails.
// Keep disposable bytecode outside the native home archive, below a root-owned
// parent with a private sandbox-owned cache. Preserve host defaults and overrides.
const ROOT_MARKER = "/* nemoclaw: private sandbox compile cache */";
const ROOT_BEFORE = 'path.join(os.tmpdir(), "node-compile-cache")';
const ROOT_AFTER = `(env.OPENSHELL_SANDBOX === "1" && typeof process.getuid === "function" && process.getuid() !== 0
? "/tmp/nemoclaw/node-compile-cache"
: ${ROOT_BEFORE}) ${ROOT_MARKER}`;
const INHERIT_MARKER = "// nemoclaw: inherit the enabled native compile cache in workers";
const WORKER_MARKER = "// nemoclaw: publish parent bytecode before worker startup";

function replaceOnce(source: string, before: string, after: string, marker: string): string {
  if (source.includes(marker)) {
    if (
      source.split(marker).length !== 2 ||
      source.split(after).length !== 2 ||
      source.replace(after, "").includes(before)
    ) {
      throw new Error(`Incomplete OpenClaw compile cache patch: ${marker}`);
    }
    return source;
  }
  if (source.split(before).length !== 2) {
    throw new Error(`Unrecognized OpenClaw compile cache boundary: ${marker}`);
  }
  return source.replace(before, () => after);
}

export function patchCompileCacheRoot(source: string): string {
  return replaceOnce(source, ROOT_BEFORE, ROOT_AFTER, ROOT_MARKER);
}

export function patchCompileCacheInheritance(source: string, launcher: boolean): string {
  const before = launcher
    ? "          owner.baseDirectory ??= baseDirectory;"
    : "\t\tcompileCacheOwner().baseDirectory ??= baseDirectory;";
  const indent = launcher ? "          " : "\t\t";
  return replaceOnce(
    source,
    before,
    `${before}\n${indent}${INHERIT_MARKER}\n${indent}process.env.NODE_COMPILE_CACHE ??= baseDirectory;`,
    INHERIT_MARKER,
  );
}

export function patchWorkerCompileCache(source: string): string {
  const before =
    "function createCpuTrackedWorker(...args) {\n\tconst worker = new Worker(...args);";
  const after = `function createCpuTrackedWorker(...args) {
\t${WORKER_MARKER}
\tif (process.env.NODE_DISABLE_COMPILE_CACHE === undefined) {
\t\ttry { nemoclawCompileCacheModule.flushCompileCache?.(); } catch {}
\t}
\tconst worker = new Worker(...args);`;
  const patched = replaceOnce(source, before, after, WORKER_MARKER);
  const header = 'import * as nemoclawCompileCacheModule from "node:module";\n';
  if (source.includes(WORKER_MARKER)) {
    if (!source.startsWith(header) || source.split(header).length !== 2) {
      throw new Error("Incomplete OpenClaw worker compile cache import");
    }
    return patched;
  }
  if (source.includes("nemoclawCompileCacheModule")) {
    throw new Error("Unrecognized OpenClaw worker compile cache import");
  }
  return header + patched;
}

export function patchOpenClawNodeCompileCache(dist: string, audit = false): void {
  const root = path.dirname(dist);
  if (
    JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version !== "2026.10.5"
  ) {
    throw new Error("Unsupported OpenClaw compile cache version");
  }
  const one = (pattern: RegExp): string => {
    const names = fs.readdirSync(dist).filter((name) => pattern.test(name));
    if (names.length !== 1) throw new Error(`Expected one OpenClaw module: ${pattern}`);
    return path.join(dist, names[0]!);
  };
  const patches = [
    [path.join(root, "node-compile-cache.mjs"), patchCompileCacheRoot],
    [path.join(root, "openclaw.mjs"), (s: string) => patchCompileCacheInheritance(s, true)],
    [
      one(/^node-compile-cache-env-.*\.mjs$/u),
      (s: string) => patchCompileCacheInheritance(patchCompileCacheRoot(s), false),
    ],
    [one(/^worker-cpu-.*\.mjs$/u), patchWorkerCompileCache],
  ] as const;
  // Classify every native boundary before writing any module.
  const changes = patches.map(([file, patch]) => {
    const source = fs.readFileSync(file, "utf8");
    return { file, source, patched: patch(source) };
  });
  for (const { file, source, patched } of changes) {
    if (audit && source !== patched)
      throw new Error(`Missing OpenClaw compile cache patch: ${file}`);
    if (!audit && source !== patched) fs.writeFileSync(file, patched);
  }
}

async function probeSandboxCompileCache(dist: string): Promise<void> {
  if (process.getuid?.() !== 998) throw new Error("Compile cache probe requires sandbox user");
  // Native SQLite snapshots also create private siblings below this parent.
  fs.accessSync(path.join(os.homedir(), ".cache"), fs.constants.W_OK | fs.constants.X_OK);
  const cacheRoot = "/tmp/nemoclaw/node-compile-cache";
  const parent = fs.lstatSync(path.dirname(cacheRoot));
  const cache = fs.lstatSync(cacheRoot);
  if (
    !parent.isDirectory() ||
    parent.uid !== 0 ||
    (parent.mode & 0o022) !== 0 ||
    !cache.isDirectory() ||
    cache.uid !== 998 ||
    (cache.mode & 0o777) !== 0o700
  )
    throw new Error("Unsafe sandbox compile cache ownership or permissions");
  patchOpenClawNodeCompileCache(dist, true);
  const root = path.dirname(dist);
  const { resolveOpenClawCompileCacheDirectory } = await import(
    pathToFileURL(path.join(root, "node-compile-cache.mjs")).href
  );
  const directory = resolveOpenClawCompileCacheDirectory({ installRoot: root });
  const prefix = path.join(cacheRoot, "openclaw", "2026.10.5") + path.sep;
  if (typeof directory !== "string" || !directory.startsWith(prefix)) {
    throw new Error("Unexpected sandbox compile cache root");
  }
  if (module.enableCompileCache(directory).status !== module.constants.compileCacheStatus.ENABLED) {
    throw new Error("Sandbox compile cache activation failed");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const audit = args[0] === "--audit";
  const probe = args[0] === "--probe";
  const dist = args[audit || probe ? 1 : 0];
  if (!dist || args.length !== (audit || probe ? 2 : 1)) {
    throw new Error(
      "Usage: patch-openclaw-node-compile-cache.mts [--audit|--probe] <openclaw-dist-dir>",
    );
  }
  if (probe) await probeSandboxCompileCache(dist);
  else patchOpenClawNodeCompileCache(dist, audit);
}
