#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectBundledPackageVersions,
  jsonObject,
  readJsonObject,
  rejectUnsafePackageTree,
  requireRealDirectory,
  rewriteRegularFile,
} from "./bundled-npm-package.mts";

const ORIGINAL_BUILD_SHA256 = "d11b1d799a2522bd38a364bc39d36175d9e68225e0e5a36d9fc3a64e1710fbc0";
const PATCHED_BUILD_SHA256 = "61106330916014ddd13402d201f26649439f7499c1e916429ff761097feb1656";
const NATIVE_GLOB = `// NemoClaw: these two fixed patterns need no third-party glob parser.
const { glob: nativeGlob, stat } = require('node:fs/promises')
async function glob (pattern) {
  const files = []
  for await (const file of nativeGlob(pattern)) {
    try {
      if ((await stat(file)).isFile()) files.push(file)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return files
}`;

/** Verify an already patched tree without changing it. */
export function verifyBundledNpmNodeGyp(npmRoot: string): void {
  const modules = requireRealDirectory(join(npmRoot, "node_modules"), "npm dependencies");
  const gyp = requireRealDirectory(join(modules, "node-gyp"), "npm node-gyp");
  requireRealDirectory(join(gyp, "lib"), "node-gyp source directory");
  const manifest = readJsonObject(join(gyp, "package.json"), "node-gyp manifest");
  if (
    manifest.name !== "node-gyp" ||
    manifest.version !== "13.0.0" ||
    jsonObject(manifest.dependencies, "node-gyp dependencies").tinyglobby !== undefined
  ) {
    throw new Error("node-gyp native glob metadata has drifted");
  }
  const fd = openSync(
    join(gyp, "lib/build.js"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (
      !fstatSync(fd).isFile() ||
      createHash("sha256").update(readFileSync(fd)).digest("hex") !== PATCHED_BUILD_SHA256
    ) {
      throw new Error("node-gyp native glob source has drifted");
    }
  } finally {
    closeSync(fd);
  }
  for (const packageName of ["tinyglobby", "picomatch"]) {
    if (
      collectBundledPackageVersions({
        nodeModulesRoot: modules,
        packageName,
        ignoredDirectoryPrefixes: [],
      }).length !== 0
    ) {
      throw new Error(`npm retains unexpected ${packageName}`);
    }
  }
}

/** Temporary node-gyp bridge until npm ships without affected picomatch (GHSA-fc5q-39xc-vjpf). */
export function patchBundledNpmNodeGyp(npmRoot: string): void {
  const root = requireRealDirectory(npmRoot, "npm root");
  const npm = readJsonObject(join(root, "package.json"), "npm manifest");
  if (npm.name !== "npm" || !["12.0.2", "12.2.1"].includes(String(npm.version))) {
    throw new Error("npm node-gyp remediation identity has drifted");
  }
  const modules = requireRealDirectory(join(root, "node_modules"), "npm dependencies");
  const gyp = requireRealDirectory(join(modules, "node-gyp"), "npm node-gyp");
  requireRealDirectory(join(gyp, "lib"), "node-gyp source directory");
  const manifestPath = join(gyp, "package.json");
  const manifest = readJsonObject(manifestPath, "node-gyp manifest");
  const dependencies = jsonObject(manifest.dependencies, "node-gyp dependencies");
  if (
    manifest.name !== "node-gyp" ||
    manifest.version !== "13.0.0" ||
    (dependencies.tinyglobby !== undefined && dependencies.tinyglobby !== "^0.2.12")
  )
    throw new Error("npm node-gyp package contract has drifted");

  // Publish code and dependency metadata before removing the unused package tree.
  // A failed removal remains a failure for the caller.
  const tiny = join(modules, "tinyglobby");
  if (existsSync(tiny)) {
    requireRealDirectory(tiny, "npm tinyglobby");
    rejectUnsafePackageTree(tiny, "npm tinyglobby");
    const installed = readJsonObject(join(tiny, "package.json"), "tinyglobby manifest");
    if (installed.name !== "tinyglobby" || installed.version !== "0.2.17") {
      throw new Error("npm tinyglobby identity has drifted");
    }
  }
  rewriteRegularFile(join(gyp, "lib/build.js"), "node-gyp build source", (source) => {
    const hash = createHash("sha256").update(source).digest("hex");
    if (hash === PATCHED_BUILD_SHA256) return source;
    if (hash !== ORIGINAL_BUILD_SHA256) throw new Error("node-gyp build source has drifted");
    const patched = source
      .replace("const { glob } = require('tinyglobby')", NATIVE_GLOB)
      .replaceAll(", { expandDirectories: false }", "");
    if (createHash("sha256").update(patched).digest("hex") !== PATCHED_BUILD_SHA256) {
      throw new Error("node-gyp native glob patch failed verification");
    }
    return patched;
  });
  rewriteRegularFile(manifestPath, "node-gyp manifest", (source) => {
    const current = JSON.parse(source);
    if (JSON.stringify(current) !== JSON.stringify(manifest)) {
      throw new Error("node-gyp manifest changed before writing");
    }
    if (dependencies.tinyglobby === undefined) return source;
    delete current.dependencies.tinyglobby;
    return `${JSON.stringify(current, null, 2)}\n`;
  });
  if (existsSync(tiny)) rmSync(tiny, { recursive: true });
  verifyBundledNpmNodeGyp(root);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const index = process.argv.indexOf("--npm-root");
    const root = index >= 0 ? process.argv[index + 1] : undefined;
    if (!root || root.startsWith("--")) throw new Error("--npm-root is required");
    patchBundledNpmNodeGyp(root);
    process.stdout.write("Verified npm node-gyp uses native globbing without picomatch\n");
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
