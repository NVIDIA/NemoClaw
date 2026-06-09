// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  dockerBuild,
  dockerCapture,
  dockerImageInspect,
  dockerImageInspectFormat,
  dockerPull,
} from "./adapters/docker";
import { ROOT, redact } from "./runner";

export const OPENCLAW_SANDBOX_BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/sandbox-base";
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
  source: "override" | "version-tag" | "source-sha" | "latest" | "local";
  glibcVersion: string | null;
};

const BASE_IMAGE_INPUT_PATHS = ["Dockerfile.base", "nemoclaw-blueprint/blueprint.yaml"];

/**
 * Combine stderr + stdout from a captured `dockerBuild` failure and pass them
 * through the runner's redaction so secrets in build output never reach the
 * terminal. BuildKit splits diagnostics across both streams depending on the
 * backend and progress mode, so taking only stderr can hide the actual reason
 * a build failed.
 */
export function formatBuildFailureDiagnostics(buildResult: {
  stderr?: unknown;
  stdout?: unknown;
}): string {
  const streams = [buildResult.stderr, buildResult.stdout]
    .map((stream) => {
      if (stream == null) return "";
      if (Buffer.isBuffer(stream)) return stream.toString("utf8");
      return String(stream);
    })
    .map((text) => text.trim())
    .filter((text) => text.length > 0);
  return streams.length > 0 ? redact(streams.join("\n")) : "";
}

export function parseGlibcVersion(output: string | null | undefined): string | null {
  const text = String(output || "");
  const match =
    text.match(/GLIBC\s+([0-9]+(?:\.[0-9]+)+)/i) || text.match(/\s([0-9]+\.[0-9]+)\s*$/);
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

export function imageMeetsMinimumGlibc(
  imageRef: string,
  minVersion = OPENSHELL_SANDBOX_MIN_GLIBC,
): {
  ok: boolean;
  version: string | null;
} {
  const version = getImageGlibcVersion(imageRef);
  return { ok: !!version && versionGte(version, minVersion), version };
}

export function getSourceShortShaTags(
  rootDir = ROOT,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const values: string[] = [];
  const push = (value: string | null | undefined) => {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
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

function normalizeVersionTag(value: string | null | undefined): string | null {
  const raw = String(value || "").trim();
  if (!raw || raw === "latest") return null;
  const withoutPrefix = raw.replace(/^refs\/tags\//, "").replace(/^release\//, "");
  const version = withoutPrefix.startsWith("v") ? withoutPrefix.slice(1) : withoutPrefix;
  if (!/^[0-9]+(?:\.[0-9]+){1,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(version)) {
    return null;
  }
  return `v${version}`;
}

function gitExactVersionTag(rootDir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const git = spawnSync(
    "git",
    ["-C", rootDir, "describe", "--tags", "--exact-match", "--match", "v*"],
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      env,
    },
  );
  return git.status === 0 ? normalizeVersionTag(git.stdout) : null;
}

function versionFileTag(rootDir: string): string | null {
  try {
    return normalizeVersionTag(fs.readFileSync(path.join(rootDir, ".version"), "utf-8"));
  } catch {
    return null;
  }
}

export function getVersionedBaseImageTags(
  rootDir = ROOT,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = [
    env.NEMOCLAW_SANDBOX_BASE_VERSION_TAG,
    env.NEMOCLAW_INSTALL_REF,
    env.NEMOCLAW_INSTALL_TAG,
    env.GITHUB_REF_TYPE === "tag" ? env.GITHUB_REF_NAME : null,
    gitExactVersionTag(rootDir, env),
    versionFileTag(rootDir),
  ];
  return Array.from(
    new Set(values.map((value) => normalizeVersionTag(value)).filter(Boolean)),
  ) as string[];
}

function gitStatus(
  rootDir: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const git = spawnSync("git", ["-C", rootDir, ...args], {
    encoding: "utf-8",
    stdio: "ignore",
    timeout: 5_000,
    env,
  });
  return git.status;
}

function gitRefExists(rootDir: string, ref: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return gitStatus(rootDir, ["rev-parse", "--verify", `${ref}^{commit}`], env) === 0;
}

function gitFetchRemoteBranch(
  rootDir: string,
  remote: string,
  branch: string,
  localRef: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const normalizedBranch = String(branch || "").trim();
  if (!normalizedBranch) return;

  spawnSync(
    "git",
    [
      "-C",
      rootDir,
      "fetch",
      "--no-tags",
      "--depth=1",
      remote,
      `+refs/heads/${normalizedBranch}:${localRef}`,
    ],
    {
      encoding: "utf-8",
      stdio: "ignore",
      timeout: 30_000,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
}

function gitHasPathDiff(
  rootDir: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean | null {
  const status = gitStatus(rootDir, [...args, "--", ...BASE_IMAGE_INPUT_PATHS], env);
  if (status === 0) return false;
  if (status === 1) return true;
  return null;
}

export function baseImageInputsChangedSinceMain(
  rootDir = ROOT,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const worktreeDiff = gitHasPathDiff(rootDir, ["diff", "--quiet"], env);
  if (worktreeDiff === true) return true;

  const stagedDiff = gitHasPathDiff(rootDir, ["diff", "--cached", "--quiet"], env);
  if (stagedDiff === true) return true;

  const baseBranch = String(env.GITHUB_BASE_REF || "main").trim() || "main";
  const baseRemoteRef = `origin/${baseBranch}`;
  if (!gitRefExists(rootDir, baseRemoteRef, env)) {
    gitFetchRemoteBranch(rootDir, "origin", baseBranch, `refs/remotes/origin/${baseBranch}`, env);
  }

  const candidates = [baseRemoteRef, "origin/main", "upstream/main", "main"].filter(
    (ref): ref is string => !!ref,
  );

  for (const ref of Array.from(new Set(candidates))) {
    if (!gitRefExists(rootDir, ref, env)) continue;
    const diff = gitHasPathDiff(rootDir, ["diff", "--quiet", ref, "HEAD"], env);
    if (diff != null) return diff;
  }

  return false;
}

function localBuildAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.NEMOCLAW_SANDBOX_BASE_LOCAL_BUILD || "auto")
    .trim()
    .toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return env.NODE_ENV !== "test" && env.VITEST !== "true";
}

function getRepoDigest(
  imageName: string,
  imageRef: string,
): { digest: string; ref: string } | null {
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

  const label = options.label || "sandbox base image";
  console.warn(`  Building ${label} locally because no compatible published base image was found.`);
  console.warn("  This is a one-time step and can take several minutes.");
  // Suppress the full BuildKit log (apt-get output, layer hashes, debconf
  // warnings) on success — same approach as #3311 for the [2/8] gateway
  // setup leak. `--quiet` collapses normal output to just the image hash;
  // `suppressOutput` keeps captured stdio out of the user's terminal.
  // On failure, surface the captured stderr so the user still gets a
  // useful diagnostic.
  const buildResult = dockerBuild(options.dockerfilePath, imageRef, options.rootDir || ROOT, {
    quiet: true,
    ignoreError: true,
    suppressOutput: true,
  });
  if (buildResult.error || buildResult.status !== 0) {
    const diagnostics = formatBuildFailureDiagnostics(buildResult);
    if (diagnostics) console.error(diagnostics);
    const detail = buildResult.error
      ? `: ${buildResult.error.message}`
      : ` (exit ${buildResult.status ?? "unknown"})`;
    console.error(`  Failed to build ${label}${detail}`);
    return null;
  }

  const check = options.requireOpenshellSandboxAbi
    ? imageMeetsMinimumGlibc(imageRef, options.minGlibcVersion || OPENSHELL_SANDBOX_MIN_GLIBC)
    : { ok: true, version: null };
  if (!check.ok) {
    console.error(
      `  Local ${label} ${imageRef} has glibc ` +
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
    for (const tag of getVersionedBaseImageTags(options.rootDir || ROOT, env)) {
      const imageRef = `${options.imageName}:${tag}`;
      const resolved = resolvePulledCandidate(options.imageName, imageRef, "version-tag", options);
      if (resolved) return resolved;
    }

    for (const tag of getSourceShortShaTags(options.rootDir || ROOT, env)) {
      const imageRef = `${options.imageName}:${tag}`;
      const resolved = resolvePulledCandidate(options.imageName, imageRef, "source-sha", options);
      if (resolved) return resolved;
    }

    if (baseImageInputsChangedSinceMain(options.rootDir || ROOT, env)) {
      const local = resolveLocalCandidate(options);
      if (local) return local;
      // The base Dockerfile changed, so fail closed instead of silently using stale :latest.
      return {
        ref: options.localTag,
        digest: null,
        source: "local",
        glibcVersion: null,
      };
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
