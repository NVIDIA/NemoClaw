// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ROOT } from "../runner";

export const BASE_IMAGE_INPUT_PATHS = ["Dockerfile.base", "nemoclaw-blueprint/blueprint.yaml"];

export function normalizeBaseImageInputPaths(rootDir: string, paths: string[] = []): string[] {
  const absoluteRootDir = path.resolve(rootDir);
  const normalizedPaths = paths
    .map((inputPath) => {
      const trimmed = String(inputPath || "").trim();
      if (!trimmed) return null;
      const absolutePath = path.isAbsolute(trimmed)
        ? path.resolve(trimmed)
        : path.resolve(absoluteRootDir, trimmed);
      const relativePath = path.relative(absoluteRootDir, absolutePath);
      if (
        !relativePath ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
      ) {
        return null;
      }
      return relativePath.split(path.sep).join("/");
    })
    .filter((inputPath): inputPath is string => !!inputPath);
  return Array.from(new Set([...BASE_IMAGE_INPUT_PATHS, ...normalizedPaths]));
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

function gitExactVersionTag(rootDir: string, env: NodeJS.ProcessEnv): string | null {
  const git = spawnSync(
    "git",
    ["-C", rootDir, "describe", "--tags", "--exact-match", "--match", "v*"],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000, env },
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

function gitStatus(rootDir: string, args: string[], env: NodeJS.ProcessEnv): number | null {
  return spawnSync("git", ["-C", rootDir, ...args], {
    encoding: "utf-8",
    stdio: "ignore",
    timeout: 5_000,
    env,
  }).status;
}

function gitRootState(rootDir: string, env: NodeJS.ProcessEnv): "absent" | "ready" | "broken" {
  try {
    fs.lstatSync(path.join(rootDir, ".git"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "broken";
  }

  const result = spawnSync("git", ["-C", rootDir, "rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
    env,
  });
  if (result.status !== 0) return "broken";
  try {
    return fs.realpathSync(String(result.stdout).trim()) === fs.realpathSync(rootDir)
      ? "ready"
      : "broken";
  } catch {
    return "broken";
  }
}

function gitRefExists(rootDir: string, ref: string, env: NodeJS.ProcessEnv): boolean {
  return gitStatus(rootDir, ["rev-parse", "--verify", `${ref}^{commit}`], env) === 0;
}

function gitFetchRemoteBranch(
  rootDir: string,
  remote: string,
  branch: string,
  localRef: string,
  env: NodeJS.ProcessEnv,
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

function normalizeBaseBranch(value: string | null | undefined): string {
  const branch = String(value || "").trim() || "main";
  const check = spawnSync("git", ["check-ref-format", "--branch", branch], {
    encoding: "utf-8",
    stdio: "ignore",
    timeout: 5_000,
  });
  return check.status === 0 ? branch : "main";
}

function gitHasPathDiff(
  rootDir: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  inputPaths: string[],
): boolean | null {
  const status = gitStatus(rootDir, [...args, "--", ...inputPaths], env);
  if (status === 0) return false;
  if (status === 1) return true;
  return null;
}

function trackedBaseImageInputsDirty(
  rootDir: string,
  env: NodeJS.ProcessEnv,
  inputPaths: string[],
): boolean {
  const worktreeDiff = gitHasPathDiff(rootDir, ["diff", "--quiet"], env, inputPaths);
  if (worktreeDiff !== false) return true;
  const stagedDiff = gitHasPathDiff(rootDir, ["diff", "--cached", "--quiet"], env, inputPaths);
  return stagedDiff !== false;
}

export function baseImageInputsDirty(
  rootDir = ROOT,
  env: NodeJS.ProcessEnv = process.env,
  paths: string[] = [],
): boolean {
  const rootState = gitRootState(rootDir, env);
  if (rootState === "absent") return false;
  if (rootState === "broken") return true;
  return trackedBaseImageInputsDirty(rootDir, env, normalizeBaseImageInputPaths(rootDir, paths));
}

export function baseImageInputsChangedSinceMain(
  rootDir = ROOT,
  env: NodeJS.ProcessEnv = process.env,
  paths: string[] = [],
): boolean {
  // Release installs may not include Git metadata. Check for metadata at this
  // exact root so a release nested under an unrelated checkout is not treated
  // as source. Once metadata is present, corrupt or unreadable state fails closed.
  const rootState = gitRootState(rootDir, env);
  if (rootState === "absent") return false;
  if (rootState === "broken") return true;

  const inputPaths = normalizeBaseImageInputPaths(rootDir, paths);
  if (trackedBaseImageInputsDirty(rootDir, env, inputPaths)) return true;

  const baseBranch = normalizeBaseBranch(env.GITHUB_BASE_REF);
  const baseRemoteRef = `origin/${baseBranch}`;
  if (!gitRefExists(rootDir, baseRemoteRef, env)) {
    gitFetchRemoteBranch(rootDir, "origin", baseBranch, `refs/remotes/origin/${baseBranch}`, env);
  }

  const candidates = [baseRemoteRef, "origin/main", "upstream/main", "main"];
  for (const ref of Array.from(new Set(candidates))) {
    if (!gitRefExists(rootDir, ref, env)) continue;
    const diff = gitHasPathDiff(rootDir, ["diff", "--quiet", ref, "HEAD"], env, inputPaths);
    return diff ?? true;
  }
  // A repository with no usable comparison ref cannot prove that its base
  // inputs match main. Force the validated local path instead of reusing
  // potentially stale published tags.
  return true;
}

export function buildLocalBaseTag(prefix: string, rootDir = ROOT, env = process.env): string {
  const tag = getSourceShortShaTags(rootDir, env)[0] || "local";
  return `${prefix}:${tag}`;
}

export function defaultOpenclawBaseDockerfile(rootDir = ROOT): string {
  return path.join(rootDir, "Dockerfile.base");
}
