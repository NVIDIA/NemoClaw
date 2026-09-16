// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePathWithinRoot } from "./repository-input-path.mts";

interface PackageManifest {
  bin?: unknown;
}

interface DeclaredBin {
  name: string;
  relativePath: string;
}

function readDeclaredBins(repositoryRoot: string): DeclaredBin[] {
  const manifestPath = path.join(repositoryRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PackageManifest;
  const declared = manifest.bin;
  if (typeof declared === "string") {
    return [{ name: "package", relativePath: declared }];
  }
  if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
    throw new Error("package.json must declare at least one package bin target");
  }

  const entries = Object.entries(declared as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error("package.json must declare at least one package bin target");
  }
  return entries.map(([name, value]) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`package.json bin ${JSON.stringify(name)} must be a nonempty relative path`);
    }
    return { name, relativePath: value };
  });
}

function validateBinTarget(repositoryRoot: string, declared: DeclaredBin): string {
  const label = `package.json bin ${JSON.stringify(declared.name)}`;
  const target = resolvePathWithinRoot(repositoryRoot, declared.relativePath, label);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    throw new Error(`${label} target is missing or unreadable: ${declared.relativePath}`, {
      cause: error,
    });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      `${label} target must be a regular non-symbolic-link file: ${declared.relativePath}`,
    );
  }
  return target;
}

export function normalizePackageBinModes(repositoryRoot: string): void {
  const targets = readDeclaredBins(repositoryRoot).map((declared) =>
    validateBinTarget(repositoryRoot, declared),
  );
  for (const target of new Set(targets)) {
    fs.chmodSync(target, 0o755);
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  normalizePackageBinModes(path.resolve(path.dirname(scriptPath), "..", ".."));
}
