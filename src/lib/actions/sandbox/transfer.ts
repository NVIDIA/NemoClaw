// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { computeExitCode } from "./exec";

export interface SandboxDownloadOptions {
  destination?: string;
}

export interface SandboxUploadOptions {
  destination?: string;
  noGitIgnore?: boolean;
}

// Build the argv that `openshell sandbox download <NAME> <SANDBOX_PATH> [DEST]`
// expects. Kept pure so tests can assert the OpenShell call shape without
// spawning a real binary.
export function buildOpenshellDownloadArgs(
  sandboxName: string,
  sandboxPath: string,
  options: SandboxDownloadOptions = {},
): string[] {
  const argv = ["sandbox", "download", sandboxName, sandboxPath];
  if (options.destination) argv.push(options.destination);
  return argv;
}

// Build the argv for `openshell sandbox upload [--no-git-ignore] <NAME>
// <LOCAL_PATH> [DEST]`. `--no-git-ignore` must precede the positional args
// because OpenShell's flag parser requires it.
export function buildOpenshellUploadArgs(
  sandboxName: string,
  localPath: string,
  options: SandboxUploadOptions = {},
): string[] {
  const argv = ["sandbox", "upload"];
  if (options.noGitIgnore) argv.push("--no-git-ignore");
  argv.push(sandboxName, localPath);
  if (options.destination) argv.push(options.destination);
  return argv;
}

function exitWithOpenshellResult(result: {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
}): never {
  const { code, errorMessage } = computeExitCode(result);
  if (errorMessage) {
    console.error(`  Failed to invoke openshell: ${errorMessage}`);
    console.error("  Ensure 'openshell' is installed and on PATH.");
  }
  process.exit(code);
}

// Download a path from inside the sandbox to the host. Thin wrapper around
// `openshell sandbox download` so users do not need to remember the raw
// OpenShell command surface; the underlying transfer is unchanged.
export async function downloadSandbox(
  sandboxName: string,
  sandboxPath: string,
  options: SandboxDownloadOptions = {},
): Promise<void> {
  const { getOpenshellBinary } = require("../../adapters/openshell/runtime");
  const result = spawnSync(
    getOpenshellBinary(),
    buildOpenshellDownloadArgs(sandboxName, sandboxPath, options),
    { stdio: "inherit" },
  );
  exitWithOpenshellResult(result);
}

// Upload a host path into the sandbox. Thin wrapper around `openshell sandbox
// upload` with the `--no-git-ignore` opt-out surfaced. Same exit code
// translation as the exec wrapper so wrapping scripts can rely on it.
export async function uploadSandbox(
  sandboxName: string,
  localPath: string,
  options: SandboxUploadOptions = {},
): Promise<void> {
  const { getOpenshellBinary } = require("../../adapters/openshell/runtime");
  const result = spawnSync(
    getOpenshellBinary(),
    buildOpenshellUploadArgs(sandboxName, localPath, options),
    { stdio: "inherit" },
  );
  exitWithOpenshellResult(result);
}
