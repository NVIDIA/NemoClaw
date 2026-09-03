// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  captureOpenshell,
  isCommandTimeout,
  OPENSHELL_PROBE_TIMEOUT_MS,
  runOpenshell,
} from "../../adapters/openshell/runtime";
import { CLI_NAME } from "../../cli/branding";
import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock-acquisition";
import { ensureLiveSandboxOrExit } from "./gateway-state";
import { resolveHostPathFromCwd } from "./host-path";
import {
  assertDownloadArtifactExists,
  publishDownloadArtifact,
  resolveDownloadArtifactPath,
  type SandboxSourceKind,
} from "./sessions/download-verify";

// Directory downloads archive every member. Scan without following links,
// normalize relative roots for `find`, and stop at the first unsupported entry.
// Probe failures fail closed.
const SANDBOX_SOURCE_PROBE_SCRIPT = [
  "p=$1",
  'if [ -L "$p" ]; then printf unsupported; exit 0; fi',
  'if [ -d "$p" ]; then',
  '  case "$p" in',
  "    /*) root=$p ;;",
  "    *) root=./$p ;;",
  "  esac",
  '  unsafe=$(find "$root" ! -type d ! -type f -print -quit) || exit 1',
  '  [ -n "$unsafe" ] && printf unsafe-member || printf dir',
  "  exit 0",
  "fi",
  'if [ -f "$p" ]; then printf file; exit 0; fi',
  'if [ -e "$p" ]; then printf unsupported; exit 0; fi',
  "printf missing",
].join("\n");

// Classify the source root and reject unsupported directory members.
// The path is passed as a positional argument ($1), never interpolated into
// the script, so a crafted path cannot inject shell. Returns `undefined` when
// the probe cannot determine a kind.
function probeSandboxSourceKind(
  sandboxName: string,
  sandboxPath: string,
): SandboxSourceKind | "missing" | "unsupported" | "unsafe-member" | "timeout" | undefined {
  const probe = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "sh",
      "-c",
      SANDBOX_SOURCE_PROBE_SCRIPT,
      "sh",
      sandboxPath,
    ],
    { ignoreError: true, timeout: OPENSHELL_PROBE_TIMEOUT_MS },
  );
  if (probe && isCommandTimeout(probe)) return "timeout";
  const kind = probe?.output?.trim();
  return kind === "file" ||
    kind === "dir" ||
    kind === "missing" ||
    kind === "unsupported" ||
    kind === "unsafe-member"
    ? kind
    : undefined;
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
  return withMcpLifecycleLock(opts.sandboxName, () => {
    assertHermesPortableCommandUnavailable(opts.sandboxName, "sandbox:download");
    return downloadFromSandboxUnlocked(opts);
  });
}

async function downloadFromSandboxUnlocked(
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
  // out-of-workspace source; NVIDIA/OpenShell#2456), and this command
  // otherwise trusts that exit code.
  // Keep this verification after OpenShell fixes that issue: NemoClaw's
  // wrapper independently requires a fresh artifact from this invocation
  // before it publishes anything to the requested host destination.
  const sourceKind = probeSandboxSourceKind(opts.sandboxName, sandboxPath);
  if (sourceKind === "missing") {
    throw new Error(
      `Cannot download '${sandboxPath}' from sandbox '${opts.sandboxName}': no such path in the sandbox.`,
    );
  }
  if (sourceKind === "unsupported") {
    throw new Error(
      `Cannot download '${sandboxPath}' from sandbox '${opts.sandboxName}': source is not a regular file or directory.`,
    );
  }
  if (sourceKind === "unsafe-member") {
    throw new Error(
      `Cannot download '${sandboxPath}' from sandbox '${opts.sandboxName}': the directory contains an entry that is not a regular file or directory. Symbolic links are not supported.`,
    );
  }
  if (sourceKind === "timeout") {
    throw new Error(
      `Cannot download '${sandboxPath}' from sandbox '${opts.sandboxName}': source verification timed out.`,
    );
  }
  if (sourceKind === undefined) {
    throw new Error(
      `Cannot download '${sandboxPath}' from sandbox '${opts.sandboxName}': could not verify whether the source is a file or directory.`,
    );
  }

  const expectedArtifact = resolveDownloadArtifactPath(sandboxPath, hostDest, sourceKind);
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-download-"));
  const stagedArtifact = path.join(stagingDir, "artifact");

  try {
    const download = runOpenshell(
      ["sandbox", "download", opts.sandboxName, sandboxPath, stagedArtifact],
      {
        ignoreError: true,
        stdio: "inherit",
      },
    );
    if (download.status !== 0) {
      throw new Error(
        `Failed to download '${sandboxPath}' from sandbox '${opts.sandboxName}' (exit ${download.status}).`,
      );
    }

    const sourceKindAfterDownload = probeSandboxSourceKind(opts.sandboxName, sandboxPath);
    if (sourceKindAfterDownload === "timeout") {
      throw new Error(
        `Cannot publish '${sandboxPath}' from sandbox '${opts.sandboxName}': source verification timed out after download.`,
      );
    }
    if (sourceKindAfterDownload !== sourceKind) {
      throw new Error(
        `Cannot publish '${sandboxPath}' from sandbox '${opts.sandboxName}': source type changed or could not be revalidated after download.`,
      );
    }

    assertDownloadArtifactExists(stagedArtifact, {
      remoteLabel: sandboxPath,
      sandboxName: opts.sandboxName,
    });
    publishDownloadArtifact(stagedArtifact, expectedArtifact, sourceKind);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  return { sandboxPath, hostDest };
}
