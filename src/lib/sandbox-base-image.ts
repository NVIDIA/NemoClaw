// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { ROOT } from "./runner";
import {
  dockerBuild,
  dockerCapture,
  dockerImageInspect,
  dockerImageInspectFormat,
  dockerPull,
} from "./adapters/docker";

export const OPENCLAW_SANDBOX_BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/sandbox-base";
export const HERMES_SANDBOX_BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base";
export const SANDBOX_BASE_TAG = "latest";
export const OPENSHELL_SANDBOX_MIN_GLIBC = "2.39";

type ResolveBaseImageOptions = {
  imageName: string;
  dockerfilePath: string;
  localTag: string;
  envVar?: string;
  label?: string;
  requireOpenshellSandboxAbi?: boolean;
  minGlibcVersion?: string;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
};

export type SandboxBaseImageResolution = {
  ref: string;
  digest: string | null;
  source: "override" | "source-sha" | "latest" | "local";
  glibcVersion: string | null;
};

export function parseGlibcVersion(output: string | null | undefined): string | null {
  const text = String(output || "");
  const match = text.match(/GLIBC\s+([0-9]+(?:\.[0-9]+)+)/i) || text.match(/\s([0-9]+\.[0-9]+)\s*$/);
  return match ? match[1] : null;
}

export function versionGte(left = "0.0.0", right = "0.0.0"): boolean {
  const lhs = String(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rhs = String(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    const a = lhs[index] || 0;
    const b = rhs[index] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

export function getImageGlibcVersion(imageRef: string): string | null {
  const output = dockerCapture(
    ["run", "--rm", "--entrypoint", "/usr/bin/ldd", imageRef, "--version"],
    { ignoreError: true, timeout: 20_000 },
  );
  return parseGlibcVersion(output);
}

export function imageMeetsMinimumGlibc(imageRef: string, minVersion = OPENSHELL_SANDBOX_MIN_GLIBC): {
  ok: boolean;
  version: string | null;
} {
  const version = getImageGlibcVersion(imageRef);
  return { ok: !!version && versionGte(version, minVersion), version };
}

export function getSourceShortShaTags(rootDir = ROOT, env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  const push = (value: string | null | undefined) => {
    const normalized = String(value || "").trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(normalized)) return;
    values.push(normalized.slice(0, 8), normalized.slice(0, 7));
  };

  push(env.GITHUB_SHA);
  const git = spawnSync("git", ["-C", rootDir, "rev-parse", "HEAD"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  if (git.status === 0) push(git.stdout);

  return Array.from(new Set(values));
}

function localBuildAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD || "auto")
    .trim()
    .toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return env.NODE_ENV !== "test" && env.VITEST !== "true";
}

function getRepoDigest(imageName: string, imageRef: string): { digest: string; ref: string } | null {
  const atIndex = imageRef.indexOf("@sha256:");
  if (atIndex !== -1) {
    const digest = imageRef.slice(atIndex + 1);
    return { digest, ref: imageRef };
  }

  const inspectOutput = dockerImageInspectFormat("{{json .RepoDigests}}", imageRef, {
    ignoreError: true,
  });
  if (!inspectOutput) return null;

  let repoDigests: unknown;
  try {
    repoDigests = JSON.parse(inspectOutput || "[]");
  } catch {
    return null;
  }
  const repoDigest = Array.isArray(repoDigests)
    ? repoDigests.find((entry) => String(entry).startsWith(`${imageName}@sha256:`))
    : null;
  if (!repoDigest) return null;
  const digest = String(repoDigest).slice(String(repoDigest).indexOf("@") + 1);
  return { digest, ref: `${imageName}@${digest}` };
}

function resolvePulledCandidate(
  imageName: string,
  imageRef: string,
  source: SandboxBaseImageResolution["source"],
  options: ResolveBaseImageOptions,
): SandboxBaseImageResolution | null {
  const inspectResult = dockerImageInspect(imageRef, {
    ignoreError: true,
    suppressOutput: true,
  });
  if (inspectResult.status !== 0) {
    const pullResult = dockerPull(imageRef, { ignoreError: true, suppressOutput: true });
    if (pullResult.status !== 0) return null;
  }

  let glibcVersion: string | null = null;
  if (options.requireOpenshellSandboxAbi) {
    const check = imageMeetsMinimumGlibc(
      imageRef,
      options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC,
    );
    glibcVersion = check.version;
    if (!check.ok) {
      console.warn(
        `  Warning: ${options.label || "sandbox base image"} ${imageRef} has glibc ` +
          `${glibcVersion || "unknown"}; OpenShell sandbox supervisor requires ` +
          `glibc >= ${options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC}.`,
      );
      return null;
    }
  }

  const repoDigest = getRepoDigest(imageName, imageRef);
  return {
    ref: repoDigest?.ref || imageRef,
    digest: repoDigest?.digest || null,
    source,
    glibcVersion,
  };
}

function resolveLocalCandidate(
  options: ResolveBaseImageOptions,
): SandboxBaseImageResolution | null {
  const imageRef = options.localTag;
  const inspectResult = dockerImageInspect(imageRef, { ignoreError: true, suppressOutput: true });
  if (inspectResult.status === 0) {
    const check = options.requireOpenshellSandboxAbi
      ? imageMeetsMinimumGlibc(imageRef, options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC)
      : { ok: true, version: null };
    if (check.ok) {
      return { ref: imageRef, digest: null, source: "local", glibcVersion: check.version };
    }
  }

  if (!localBuildAllowed(options.env)) return null;

  console.warn(
    `  Building ${options.label || "sandbox base image"} locally because no compatible ` +
      `published base image was found.`,
  );
  dockerBuild(options.dockerfilePath, imageRef, options.rootDir || ROOT, {
    stdio: ["ignore", "inherit", "inherit"],
  });

  const check = options.requireOpenshellSandboxAbi
    ? imageMeetsMinimumGlibc(imageRef, options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC)
    : { ok: true, version: null };
  if (!check.ok) {
    console.error(
      `  Local ${options.label || "sandbox base image"} ${imageRef} has glibc ` +
        `${check.version || "unknown"}; expected >= ` +
        `${options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC}.`,
    );
    return null;
  }

  return { ref: imageRef, digest: null, source: "local", glibcVersion: check.version };
}

export function resolveSandboxBaseImage(
  options: ResolveBaseImageOptions,
): SandboxBaseImageResolution | null {
  const env = options.env || process.env;
  const override = options.envVar ? String(env[options.envVar] || "").trim() : "";

  if (override) {
    const resolved = resolvePulledCandidate(options.imageName, override, "override", options);
    if (resolved) return resolved;
    if (!options.requireOpenshellSandboxAbi) return null;
  } else {
    for (const tag of getSourceShortShaTags(options.rootDir || ROOT, env)) {
      const imageRef = `${options.imageName}:${tag}`;
      const resolved = resolvePulledCandidate(options.imageName, imageRef, "source-sha", options);
      if (resolved) return resolved;
    }

    const latestRef = `${options.imageName}:${SANDBOX_BASE_TAG}`;
    const resolved = resolvePulledCandidate(options.imageName, latestRef, "latest", options);
    if (resolved) return resolved;
  }

  if (options.requireOpenshellSandboxAbi) {
    return resolveLocalCandidate(options);
  }
  return null;
}

export function buildLocalBaseTag(prefix: string, rootDir = ROOT, env = process.env): string {
  const tag = getSourceShortShaTags(rootDir, env)[0] || "local";
  return `${prefix}:${tag}`;
}

export function defaultOpenclawBaseDockerfile(rootDir = ROOT): string {
  return path.join(rootDir, "Dockerfile.base");
}

export function defaultHermesBaseDockerfile(rootDir = ROOT): string {
  return path.join(rootDir, "agents", "hermes", "Dockerfile.base");
}
