#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readReviewedNpmArchiveFile } from "./reviewed-npm-archive.mts";
import { stageReviewedArchiveWithNpm } from "./reviewed-npm-cache.mts";

const root = resolve(import.meta.dirname, "../..");
const name = "@nvidia/openshell-sdk";

function requiredVersion(): string {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version: unknown = manifest.dependencies?.[name];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error("OpenShell SDK must be an exact required dependency in package.json");
  }
  return version;
}

function prepare(version: string): void {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const entry = lock.packages?.[`node_modules/${name}`];
  if (
    lock.packages?.[""]?.dependencies?.[name] !== version ||
    entry?.version !== version ||
    entry?.optional === true ||
    typeof entry?.integrity !== "string"
  ) {
    throw new Error("OpenShell SDK package.json and package-lock.json must agree");
  }
  const artifactName = `nvidia-openshell-sdk-${version}.tgz`;
  const archive = readReviewedNpmArchiveFile({
    archivePath: join(root, "scripts", "vendor", "openshell-sdk", artifactName),
    expectedIntegrity: entry.integrity,
    label: "OpenShell SDK",
  });
  const cache = spawnSync("npm", ["config", "get", "cache"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 4096,
  });
  const cacheDirectory = cache.stdout?.trim();
  if (cache.error || cache.status !== 0 || !cacheDirectory || !isAbsolute(cacheDirectory)) {
    throw new Error("Could not resolve the npm cache for OpenShell SDK installation");
  }
  stageReviewedArchiveWithNpm({ archive, artifactName, cacheDirectory });
  console.log(`OpenShell SDK ${version}: verified archive prepared for npm installation`);
}

async function check(version: string): Promise<void> {
  try {
    const installedRoot = realpathSync(join(root, "node_modules", name));
    const installed = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8"));
    if (installed.name !== name || installed.version !== version)
      throw new Error("version mismatch");
    for (const specifier of [name, `${name}/raw`]) {
      const entry = realpathSync(fileURLToPath(import.meta.resolve(specifier)));
      if (!entry.startsWith(`${installedRoot}/`)) throw new Error("unexpected SDK location");
    }
    const { OpenShellClient } = await import("@nvidia/openshell-sdk");
    const { SandboxPolicySchema } = await import("@nvidia/openshell-sdk/raw");
    if (typeof OpenShellClient?.connect !== "function" || !SandboxPolicySchema) {
      throw new Error("SDK exports unavailable");
    }
  } catch {
    throw new Error(
      "OpenShell SDK is missing, incompatible, or cannot load. Run: npm run dev:setup",
    );
  }
  console.log(`OpenShell SDK ${version}: import OK`);
}

try {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || (mode !== "prepare" && mode !== "check")) {
    throw new Error("Usage: node scripts/lib/openshell-sdk-install.mts <prepare|check>");
  }
  const version = requiredVersion();
  if (mode === "prepare") prepare(version);
  else await check(version);
} catch (error) {
  console.error(error instanceof Error ? error.message : "OpenShell SDK installation failed");
  process.exitCode = 1;
}
