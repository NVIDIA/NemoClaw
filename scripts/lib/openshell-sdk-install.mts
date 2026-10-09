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

type ReviewedSdkIdentity = Readonly<{
  artifactName: string;
  integrity: string;
  label: string;
  packageSpec: string;
  tarballUrl: string;
  version: string;
}>;

function reviewedSdkIdentity(value: unknown): ReviewedSdkIdentity {
  if (typeof value !== "object" || value === null) {
    throw new Error("OpenShell SDK reviewed identity is missing");
  }
  const source = value as Record<string, unknown>;
  for (const key of ["artifactName", "integrity", "label", "packageSpec", "tarballUrl"]) {
    if (typeof source[key] !== "string" || source[key].length === 0) {
      throw new Error(`OpenShell SDK reviewed identity has invalid ${key}`);
    }
  }
  const packageSpec = source.packageSpec as string;
  const version = packageSpec.startsWith(`${name}@`) ? packageSpec.slice(name.length + 1) : "";
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error("OpenShell SDK reviewed identity must use an exact package spec");
  }
  const artifactName = source.artifactName as string;
  if (artifactName !== `nvidia-openshell-sdk-${version}.tgz`) {
    throw new Error("OpenShell SDK reviewed identity has an unexpected archive name");
  }
  const integrity = source.integrity as string;
  if (!integrity.startsWith("sha512-")) {
    throw new Error("OpenShell SDK reviewed identity must use sha512 integrity");
  }
  return {
    artifactName,
    integrity,
    label: source.label as string,
    packageSpec,
    tarballUrl: source.tarballUrl as string,
    version,
  };
}

function pinnedIdentity(): ReviewedSdkIdentity {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version: unknown = manifest.optionalDependencies?.[name] ?? manifest.dependencies?.[name];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error("OpenShell SDK must be an exact dependency pin in package.json");
  }
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const config = JSON.parse(readFileSync(join(root, "ci", "reviewed-npm-audit.json"), "utf8"));
  const candidates = [config.sourceRegistryPackage, config.sourceRegistryPackageReplacement]
    .filter((value) => value !== undefined)
    .map(reviewedSdkIdentity);
  const reviewed = candidates.find((candidate) => candidate.packageSpec === `${name}@${version}`);
  if (!reviewed) {
    throw new Error("OpenShell SDK package.json pin has no reviewed identity");
  }
  const entry = lock.packages?.[`node_modules/${name}`];
  if (
    (lock.packages?.[""]?.optionalDependencies?.[name] ??
      lock.packages?.[""]?.dependencies?.[name]) !== version ||
    entry?.version !== version ||
    entry?.integrity !== reviewed.integrity ||
    entry?.resolved !== reviewed.tarballUrl
  ) {
    throw new Error(
      "OpenShell SDK package.json, package-lock.json, and reviewed identity must agree",
    );
  }
  return reviewed;
}

function prepare(identity: ReviewedSdkIdentity): void {
  const archive = readReviewedNpmArchiveFile({
    archivePath: join(root, "scripts", "vendor", "openshell-sdk", identity.artifactName),
    expectedIntegrity: identity.integrity,
    label: identity.label,
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
  stageReviewedArchiveWithNpm({ archive, artifactName: identity.artifactName, cacheDirectory });
  console.log(`OpenShell SDK ${identity.version}: verified archive prepared for npm installation`);
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
  const identity = pinnedIdentity();
  if (mode === "prepare") prepare(identity);
  else await check(identity.version);
} catch (error) {
  console.error(error instanceof Error ? error.message : "OpenShell SDK installation failed");
  process.exitCode = 1;
}
