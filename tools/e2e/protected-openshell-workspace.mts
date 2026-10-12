// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  projectProtectedOpenShellSources,
  projectProtectedOpenShellSdk,
} from "./protected-openshell-projection.mts";

const SOURCE_PATHS = {
  blueprintSource: "nemoclaw-blueprint/blueprint.yaml",
  installerSource: "scripts/install-openshell.sh",
  brevInstallerSource: "scripts/brev-launchable-ci-cpu.sh",
  supervisorRuntimeSource: "src/lib/onboard/docker-driver-gateway-runtime.ts",
  featureGateSource: "src/lib/onboard/openshell-feature-gate.ts",
  packageSource: "package.json",
  lockSource: "package-lock.json",
} as const;
const VERSION_PATH = "src/lib/onboard/openshell-version.ts";
const MAX_SOURCE_BYTES = 1024 * 1024;

export interface ProtectedOpenShellWorkspace {
  trustedRoot: string;
  candidateRoot: string;
  workflowSha: string;
  candidateSha: string;
}

function git(root: string, args: string[]): string {
  return execFileSync(
    "git",
    ["--no-replace-objects", "-c", "core.fsmonitor=false", "-C", root, ...args],
    {
      encoding: "utf8",
      maxBuffer: MAX_SOURCE_BYTES + 1024,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function assertCommit(root: string, sha: string): void {
  if (!/^[a-f0-9]{40}$/.test(sha) || git(root, ["rev-parse", "--verify", "HEAD"]).trim() !== sha) {
    throw new Error("Protected OpenShell workspace does not match its dispatch commit");
  }
}

function committedSource(root: string, sha: string, path: string): string {
  const entry = git(root, ["ls-tree", "-z", sha, "--", path]);
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)\0$/.exec(entry);
  if (!match || match[3] !== path) throw new Error(`Expected a regular committed source: ${path}`);
  const source = git(root, ["cat-file", "blob", match[2]!]);
  if (
    Buffer.byteLength(source) > MAX_SOURCE_BYTES ||
    source.includes("\0") ||
    source.includes("\ufffd")
  ) {
    throw new Error(`Invalid protected OpenShell source bytes: ${path}`);
  }
  return source;
}

function safeFile(root: string, path: string): { path: string; mode: number; source: string } {
  const absoluteRoot = resolve(root);
  const absolutePath = join(absoluteRoot, path);
  // The caller supplies a fixed repository path, never a candidate-selected destination.
  for (let parent = dirname(absolutePath); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Unsafe source directory: ${path}`);
    if (parent === absoluteRoot) break;
    if (!relative(absoluteRoot, parent) || relative(absoluteRoot, parent).startsWith("..")) {
      throw new Error("Source escaped the trusted workspace");
    }
  }
  let fd: number;
  try {
    fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    throw new Error(`Unsafe protected OpenShell file: ${path}`, { cause });
  }
  try {
    // Validate and read the same opened file; never reopen a checked pathname.
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SOURCE_BYTES) {
      throw new Error(`Unsafe protected OpenShell file: ${path}`);
    }
    return {
      path: absolutePath,
      mode: stat.mode & 0o777,
      source: readFileSync(fd, "utf8"),
    };
  } finally {
    closeSync(fd);
  }
}

function replaceSource(path: string, source: string, mode: number): void {
  const temporary = `${path}.openshell-projection-${randomUUID()}`;
  try {
    writeFileSync(temporary, source, { flag: "wx", mode });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Apply only reviewed modules and release literals to an isolated trusted workflow checkout. */
export function manageProtectedOpenShellWorkspace(
  operation: "prepare" | "verify" | "restore",
  input: ProtectedOpenShellWorkspace,
) {
  if (!["prepare", "verify", "restore"].includes(operation))
    throw new Error("Invalid projection operation");
  assertCommit(input.trustedRoot, input.workflowSha);
  assertCommit(input.candidateRoot, input.candidateSha);
  const candidate = Object.fromEntries(
    Object.entries(SOURCE_PATHS).map(([key, path]) => [
      key,
      committedSource(input.candidateRoot, input.candidateSha, path),
    ]),
  ) as Record<keyof typeof SOURCE_PATHS, string>;
  const projected = projectProtectedOpenShellSources(candidate, {
    blueprintSource: committedSource(
      input.trustedRoot,
      input.workflowSha,
      SOURCE_PATHS.blueprintSource,
    ),
    versionSource: committedSource(input.trustedRoot, input.workflowSha, VERSION_PATH),
  });
  const sdk = projectProtectedOpenShellSdk(
    candidate,
    {
      packageSource: committedSource(input.trustedRoot, input.workflowSha, "package.json"),
      lockSource: committedSource(input.trustedRoot, input.workflowSha, "package-lock.json"),
      auditSource: committedSource(
        input.trustedRoot,
        input.workflowSha,
        "ci/reviewed-npm-audit.json",
      ),
    },
    projected.releaseVersion,
  );
  Object.assign(projected.files, sdk.files);
  const files = Object.entries(projected.files).map(([path, source]) => ({
    ...safeFile(input.trustedRoot, path),
    relativePath: path,
    projected: source,
    original: committedSource(input.trustedRoot, input.workflowSha, path),
  }));
  const allowed = new Set(files.map((file) => file.relativePath));
  const changed = git(input.trustedRoot, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    "-z",
    input.workflowSha,
    "--",
  ])
    .split("\0")
    .filter(Boolean);
  if (changed.some((path) => !allowed.has(path)))
    throw new Error("Unrelated changes in the trusted controller");
  for (const file of files) {
    const valid =
      operation === "prepare"
        ? file.source === file.original
        : operation === "verify"
          ? file.source === file.projected
          : file.source === file.original || file.source === file.projected;
    if (!valid) throw new Error(`Unexpected ${operation} source: ${file.relativePath}`);
  }
  if (operation !== "verify") {
    const written: typeof files = [];
    try {
      for (const file of files) {
        const next = operation === "prepare" ? file.projected : file.original;
        if (file.source === next) continue;
        replaceSource(file.path, next, file.mode);
        written.push(file);
      }
    } catch (error) {
      for (const file of written.reverse()) replaceSource(file.path, file.source, file.mode);
      throw error;
    }
  }
  return {
    schemaVersion: 1,
    operation,
    workflowSha: input.workflowSha,
    candidateSha: input.candidateSha,
    releaseVersion: projected.releaseVersion,
    sdkVersion: sdk.sdkVersion,
    sdkIntegrity: sdk.sdkIntegrity,
    files: files.map((file) => ({
      path: file.relativePath,
      sha256: createHash("sha256")
        .update(operation === "restore" ? file.original : file.projected)
        .digest("hex"),
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const operation = process.argv[2];
  if (process.argv.length !== 3 || !["prepare", "verify", "restore"].includes(operation ?? "")) {
    throw new Error("Usage: protected-openshell-workspace.mts prepare|verify|restore");
  }
  for (const name of [
    "GITHUB_WORKSPACE",
    "NEMOCLAW_E2E_TESTED_ROOT",
    "NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA",
    "CHECKOUT_SHA",
  ]) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }
  console.log(
    JSON.stringify(
      manageProtectedOpenShellWorkspace(operation as "prepare" | "verify" | "restore", {
        trustedRoot: process.env.GITHUB_WORKSPACE!,
        candidateRoot: process.env.NEMOCLAW_E2E_TESTED_ROOT!,
        workflowSha: process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA!,
        candidateSha: process.env.CHECKOUT_SHA!,
      }),
      null,
      2,
    ),
  );
}
