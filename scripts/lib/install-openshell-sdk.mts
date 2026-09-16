#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readReviewedNpmArchiveFile } from "./reviewed-npm-archive.mts";

const root = dirname(dirname(import.meta.dirname));
const packageName = "@nvidia/openshell-sdk";

function sdkImports(version: string): boolean {
  // A fresh process avoids caching an earlier failed import during repair.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import assert from "node:assert/strict";
import fs from "node:fs";
const installed = JSON.parse(fs.readFileSync("node_modules/@nvidia/openshell-sdk/package.json", "utf8"));
assert.equal(installed.version, process.argv[1]);
const sdk = await import("@nvidia/openshell-sdk");
const raw = await import("@nvidia/openshell-sdk/raw");
assert.equal(typeof sdk.OpenShellClient.connect, "function");
assert.ok(raw.SandboxPolicySchema);
`,
      version,
    ],
    { cwd: root, stdio: "ignore" },
  );
  return result.status === 0;
}

function install(): void {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const pinned = lock.packages?.[`node_modules/${packageName}`];
  if (
    !pinned ||
    !/^\d+\.\d+\.\d+$/.test(pinned.version) ||
    manifest.optionalDependencies?.[packageName] !== pinned.version
  ) {
    throw new Error("The OpenShell SDK package and lockfile pins must agree.");
  }
  const artifactName = `nvidia-openshell-sdk-${pinned.version}.tgz`;
  const archive = readReviewedNpmArchiveFile({
    archivePath: join(root, "scripts", "vendor", "openshell-sdk", artifactName),
    expectedIntegrity: pinned.integrity,
    label: "OpenShell SDK",
    maximumBytes: 1024 * 1024,
  });
  if (!sdkImports(pinned.version)) {
    const stagingRoot = mkdtempSync(join(tmpdir(), "nemoclaw-openshell-sdk-"));
    try {
      const archivePath = join(stagingRoot, artifactName);
      writeFileSync(archivePath, archive, { mode: 0o600 });
      const result = spawnSync(
        "npm",
        [
          "install",
          "--no-save",
          "--ignore-scripts",
          "--include=optional",
          "--include=dev",
          "--prefer-offline",
          "--no-audit",
          "--no-fund",
          archivePath,
        ],
        { cwd: root, stdio: "inherit" },
      );
      if (result.status !== 0) throw new Error("OpenShell SDK installation failed.");
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
    if (!sdkImports(pinned.version)) {
      throw new Error("OpenShell SDK imports failed after installation.");
    }
  }
  console.log(`Verified OpenShell SDK ${pinned.version}.`);
}

try {
  install();
} catch (error) {
  console.error(error instanceof Error ? error.message : "OpenShell SDK installation failed.");
  process.exitCode = 1;
}
