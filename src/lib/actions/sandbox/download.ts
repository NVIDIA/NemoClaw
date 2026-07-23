// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { captureOpenshell, runOpenshell } from "../../adapters/openshell/runtime";
import { CLI_NAME } from "../../cli/branding";
import { ensureLiveSandboxOrExit } from "./gateway-state";
import { resolveHostPathFromCwd } from "./host-path";
import {
  assertDownloadArtifactExists,
  resolveDownloadArtifactPath,
  type SandboxSourceKind,
} from "./sessions/download-verify";

// Probe whether the sandbox source path is a file, a directory, or missing.
// The path is passed as a positional argument ($1), never interpolated into
// the script, so a crafted path cannot inject shell. Returns `undefined` when
// the probe could not determine the kind (e.g. the exec itself failed), in
// which case the caller falls back to openshell's own exit handling.
function probeSandboxSourceKind(
  sandboxName: string,
  sandboxPath: string,
): SandboxSourceKind | "missing" | undefined {
  const probe = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "sh",
      "-c",
      'p=$1; if [ -d "$p" ]; then printf dir; elif [ -e "$p" ]; then printf file; else printf missing; fi',
      "sh",
      sandboxPath,
    ],
    { ignoreError: true },
  );
  const kind = probe?.output?.trim();
  return kind === "file" || kind === "dir" || kind === "missing" ? kind : undefined;
}

export interface SandboxDownloadOptions {
  sandboxName: string;
  sandboxPath: string;
  hostDest?: string;
  allowNonReadyPhase?: boolean;
}

export interface SandboxDownloadResult {
  sandboxPath: string;
  hostDest: string;
}

export async function downloadFromSandbox(
  opts: SandboxDownloadOptions,
): Promise<SandboxDownloadResult> {
  const sandboxPath = (opts.sandboxPath ?? "").trim();
  if (!sandboxPath) {
    throw new Error(
      `No sandbox path provided; usage: ${CLI_NAME} ${opts.sandboxName} download <sandbox-path> [host-dest]`,
    );
  }
  const hostDest = resolveHostPathFromCwd((opts.hostDest ?? "").trim() || ".");

  await ensureLiveSandboxOrExit(opts.sandboxName, {
    allowNonReadyPhase: opts.allowNonReadyPhase ?? true,
  });

  // Resolve where a successful download should land *before* running it, so we
  // can confirm the artifact actually appeared afterwards. `openshell sandbox
  // download` can exit 0 without writing anything (e.g. a rejected
  // out-of-workspace source; upstream OpenShell #7367), and this command
  // otherwise trusts that exit code.
  const sourceKind = probeSandboxSourceKind(opts.sandboxName, sandboxPath);
  if (sourceKind === "missing") {
    throw new Error(
      `Cannot download '${sandboxPath}' from sandbox '${opts.sandboxName}': no such path in the sandbox.`,
    );
  }
  const expectedArtifact =
    sourceKind === undefined
      ? null
      : resolveDownloadArtifactPath(sandboxPath, hostDest, sourceKind);

  runOpenshell(["sandbox", "download", opts.sandboxName, sandboxPath, hostDest], {
    stdio: "inherit",
  });

  if (expectedArtifact) {
    assertDownloadArtifactExists(expectedArtifact, {
      remoteLabel: sandboxPath,
      sandboxName: opts.sandboxName,
    });
  }

  return { sandboxPath, hostDest };
}
