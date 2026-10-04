// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type PackageInfo = { version?: string };
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40,64}$/;
const DESCRIBED_REVISION_PATTERN = /-\d+-g([0-9a-f]{7,64})$/;
const PUBLIC_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const BUILD_IDENTITY_FILE = "build-identity.json";

export interface BuildIdentity {
  nemoclawVersion: string;
  sourceRevision: string;
}

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

function isPackageInfo(value: PackageInfo | null): value is { version: string } {
  return typeof value?.version === "string";
}

function gitEnvForRoot(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export interface VersionOptions {
  /** Override the repo root directory. */
  rootDir?: string;
}

function rootDirectory(opts: VersionOptions): string {
  return opts.rootDir ?? join(__dirname, "..", "..", "..");
}

function readBuildIdentity(root: string): BuildIdentity | null {
  const path = join(root, "dist", BUILD_IDENTITY_FILE);
  if (!existsSync(path)) return null;
  return validateBuildIdentity(parseJson<BuildIdentity>(readFileSync(path, "utf-8")));
}

function resolveSourceVersion(root: string): string {
  try {
    const raw = execFileSync("git", ["describe", "--tags", "--match", "v*"], {
      cwd: root,
      encoding: "utf-8",
      env: gitEnvForRoot(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (raw) return raw.replace(/^v/, "");
  } catch {
    // no git, or no matching tags — fall through
  }

  const versionFile = join(root, ".version");
  if (existsSync(versionFile)) {
    const ver = readFileSync(versionFile, "utf-8").trim();
    if (ver) return ver;
  }

  const raw = readFileSync(join(root, "package.json"), "utf-8");
  const pkg = parseJson<PackageInfo>(raw);
  if (!isPackageInfo(pkg)) {
    throw new Error(`package.json at ${root} is missing a string version field`);
  }
  return pkg.version;
}

function resolveSourceRevision(root: string): string {
  try {
    const revision = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root,
      encoding: "utf-8",
      env: gitEnvForRoot(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (SOURCE_REVISION_PATTERN.test(revision)) return revision;
  } catch {
    // no git metadata — fall through to the release stamp
  }

  const revisionFile = join(root, ".source-revision");
  if (existsSync(revisionFile)) {
    const revision = readFileSync(revisionFile, "utf-8").trim();
    if (SOURCE_REVISION_PATTERN.test(revision)) return revision;
  }
  throw new Error("Could not resolve the immutable NemoClaw source revision.");
}

export function validateBuildIdentity(identity: Readonly<BuildIdentity>): BuildIdentity {
  if (
    typeof identity.nemoclawVersion !== "string" ||
    identity.nemoclawVersion.length > 128 ||
    !PUBLIC_VERSION_PATTERN.test(identity.nemoclawVersion)
  ) {
    throw new Error("NemoClaw build identity has an invalid version.");
  }
  if (
    typeof identity.sourceRevision !== "string" ||
    !SOURCE_REVISION_PATTERN.test(identity.sourceRevision)
  ) {
    throw new Error("NemoClaw build identity has an invalid source revision.");
  }
  const describedRevision = DESCRIBED_REVISION_PATTERN.exec(identity.nemoclawVersion)?.[1];
  if (describedRevision && !identity.sourceRevision.startsWith(describedRevision)) {
    throw new Error("NemoClaw build identity version and source revision do not match.");
  }
  return {
    nemoclawVersion: identity.nemoclawVersion,
    sourceRevision: identity.sourceRevision,
  };
}

export function resolveSourceBuildIdentity(opts: VersionOptions = {}): BuildIdentity {
  const root = rootDirectory(opts);
  const sourceRevision = resolveSourceRevision(root);
  const existingIdentity = readBuildIdentity(root);
  if (existingIdentity?.sourceRevision === sourceRevision) {
    return existingIdentity;
  }
  return validateBuildIdentity({
    nemoclawVersion: resolveSourceVersion(root),
    sourceRevision,
  });
}

export function getBuildIdentity(opts: VersionOptions = {}): BuildIdentity {
  const root = rootDirectory(opts);
  return readBuildIdentity(root) ?? resolveSourceBuildIdentity({ rootDir: root });
}

/**
 * Resolve the NemoClaw version from (in order):
 *   1. the compiled build identity         — exact running CLI build
 *   2. `git describe --tags --match "v*"` — works in dev / source checkouts
 *   3. `.version` file at repo root        — stamped at publish time
 *   4. `package.json` version              — hard-coded fallback
 */
export function getVersion(opts: VersionOptions = {}): string {
  const root = rootDirectory(opts);
  return readBuildIdentity(root)?.nemoclawVersion ?? resolveSourceVersion(root);
}
