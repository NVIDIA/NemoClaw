#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readReviewedNpmArchiveFile } from "./reviewed-npm-archive.mts";
import { seedReviewedNpmCache } from "./seed-reviewed-npm-cache.mts";

type PluginArchive = Readonly<{
  archivePath: string;
  packageSpec: string;
  integrity: string;
  tarballUrl: string;
}>;

function archiveObject(archive: Buffer, name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    execFileSync("tar", ["-xzOf", "-", `package/${name}`], {
      input: archive,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    }),
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Reviewed plugin ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Install verified local bytes through native npm provenance, without network or install hooks. */
export async function installReviewedOpenClawPlugin(request: PluginArchive): Promise<void> {
  const archive = readReviewedNpmArchiveFile({
    archivePath: request.archivePath,
    expectedIntegrity: request.integrity,
    label: request.packageSpec,
    maximumBytes: 64 * 1024 * 1024,
  });
  const pkg = archiveObject(archive, "package.json");
  const manifest = archiveObject(archive, "openclaw.plugin.json");
  if (
    typeof pkg.name !== "string" ||
    typeof pkg.version !== "string" ||
    `${pkg.name}@${pkg.version}` !== request.packageSpec ||
    typeof manifest.id !== "string" ||
    !/^[a-z0-9][a-z0-9_-]*$/u.test(manifest.id)
  ) {
    throw new Error("Reviewed plugin archive identity does not match the requested package");
  }
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-reviewed-plugin-"));
  try {
    const cache = join(root, "cache");
    const input = join(root, "cache-input.json");
    mkdirSync(cache);
    // The archive's SRI authenticates its bundled dependencies. This temporary
    // input supplies that same identity to the existing offline cache writer.
    writeFileSync(
      input,
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { [pkg.name]: pkg.version } },
          [`node_modules/${pkg.name}`]: {
            name: pkg.name,
            version: pkg.version,
            resolved: request.tarballUrl,
            integrity: request.integrity,
            dependencies: pkg.dependencies,
            bundleDependencies: pkg.bundleDependencies ?? pkg.bundledDependencies,
            optionalDependencies: pkg.optionalDependencies,
            peerDependencies: pkg.peerDependencies,
            peerDependenciesMeta: pkg.peerDependenciesMeta,
          },
        },
      }),
      { mode: 0o600 },
    );
    await seedReviewedNpmCache({
      archives: new Map([[request.packageSpec, request.archivePath]]),
      cacheDirectory: cache,
      lockfilePath: input,
      registryOrigin: "https://registry.npmjs.org",
    });
    const env = {
      ...process.env,
      NPM_CONFIG_CACHE: cache,
      npm_config_cache: cache,
      NPM_CONFIG_OFFLINE: "true",
      npm_config_offline: "true",
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
      npm_config_ignore_scripts: "true",
      NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
      npm_config_registry: "https://registry.npmjs.org",
    };
    execFileSync(
      "openclaw",
      ["plugins", "install", "--force", "--pin", "--accept-capabilities", request.packageSpec],
      { env, stdio: "inherit", timeout: 120_000 },
    );
    const result = JSON.parse(
      execFileSync("openclaw", ["plugins", "inspect", manifest.id, "--json"], {
        env,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      }),
    );
    if (
      result?.plugin?.trust?.reason !== "trusted-official" ||
      result?.plugin?.trustedOfficialInstall !== true ||
      result?.plugin?.id !== manifest.id ||
      result?.plugin?.packageName !== pkg.name ||
      result?.plugin?.packageVersion !== pkg.version ||
      result?.install?.source !== "npm" ||
      result?.install?.resolvedSpec !== request.packageSpec ||
      result?.install?.resolvedName !== pkg.name ||
      result?.install?.resolvedVersion !== pkg.version ||
      result?.install?.integrity !== request.integrity ||
      result?.install?.artifactKind !== undefined ||
      result?.install?.sourcePath !== undefined
    ) {
      throw new Error("Native plugin installation did not preserve reviewed official provenance");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [archivePath, packageSpec, integrity, tarballUrl, ...extra] = process.argv.slice(2);
  if (!archivePath || !packageSpec || !integrity || !tarballUrl || extra.length) {
    throw new Error(
      "Usage: install-reviewed-openclaw-plugin.mts ARCHIVE PACKAGE_SPEC SRI TARBALL_URL",
    );
  }
  await installReviewedOpenClawPlugin({ archivePath, packageSpec, integrity, tarballUrl });
}
