// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/runtime";
import { createCliOpenShellSandboxCommandExecutor } from "../../adapters/openshell/sandbox-command-cli";
import type { OpenShellSandboxBufferedCommandExecutor } from "../../adapters/openshell/sandbox-command";
import { createCliOpenShellSandboxTransferExecutor } from "../../adapters/openshell/sandbox-transfer-cli";
import type {
  OpenShellSandboxTransferCompletion,
  OpenShellSandboxTransferRequest,
} from "../../adapters/openshell/sandbox-transfer";

import { deferSandboxLifecycleExit } from "../../core/process-exit";
import { CLI_NAME } from "../../cli/branding";
import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock-acquisition";
import { ensureLiveSandboxOrExit, getKnownSandboxTargetGatewayName } from "./gateway-state";
import { resolveHostPathFromCwd } from "./host-path";
import {
  assertDownloadArtifactExists,
  publishDownloadArtifact,
  resolveDownloadArtifactPath,
  type SandboxSourceKind,
} from "./sessions/download-verify";

// Reject links in the source path before classifying it. Directory downloads
// archive every member, so scan without following links, normalize relative
// roots for `find`, and stop at the first unsupported entry. Probe failures
// fail closed.
const SANDBOX_SOURCE_PROBE_SCRIPT = [
  "p=$1",
  "link_probe=$p",
  'while [ "$link_probe" != "/" ]; do',
  '  case "$link_probe" in',
  "    */.) link_probe=${link_probe%/.} ;;",
  "    */) link_probe=${link_probe%/} ;;",
  "    *) break ;;",
  "  esac",
  '  [ -n "$link_probe" ] || link_probe=/',
  "done",
  'case "$link_probe" in',
  "  /*) link_prefix=/; link_remainder=${link_probe#/} ;;",
  "  *) link_prefix=; link_remainder=$link_probe ;;",
  "esac",
  "set -f",
  "old_ifs=$IFS",
  "IFS=/",
  "set -- $link_remainder",
  "IFS=$old_ifs",
  'for link_part in "$@"; do',
  '  [ -n "$link_part" ] || continue',
  '  if [ "$link_prefix" = "/" ]; then',
  "    link_prefix=/$link_part",
  '  elif [ -n "$link_prefix" ]; then',
  "    link_prefix=$link_prefix/$link_part",
  "  else",
  "    link_prefix=$link_part",
  "  fi",
  '  if [ -L "$link_prefix" ]; then printf unsupported; exit 0; fi',
  "done",
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
async function probeSandboxSourceKind(
  executor: OpenShellSandboxBufferedCommandExecutor,
  target: OpenShellSandboxTransferRequest["target"],
  sandboxName: string,
  sandboxPath: string,
): Promise<
  SandboxSourceKind | "missing" | "unsupported" | "unsafe-member" | "timeout" | undefined
> {
  const probe = await executor.runBuffered({
    sandboxName,
    target,
    command: ["sh", "-c", SANDBOX_SOURCE_PROBE_SCRIPT, "sh", sandboxPath],
    timeoutMilliseconds: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (probe.outcome.kind === "failed") {
    return probe.outcome.error.kind === "timeout" ? "timeout" : undefined;
  }
  if (probe.outcome.exitCode !== 0) return undefined;
  const kind = probe.stdout.trim();
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

export class SandboxDownloadSourceMissingError extends Error {
  readonly exitCode = 2;

  constructor(sandboxPath: string, sandboxName: string) {
    super(
      `Cannot download '${sandboxPath}' from sandbox '${sandboxName}': no such path in the sandbox.`,
    );
    this.name = "SandboxDownloadSourceMissingError";
  }
}

export async function downloadFromSandbox(
  opts: SandboxDownloadOptions,
): Promise<SandboxDownloadResult> {
  let completion: OpenShellSandboxTransferCompletion | undefined;
  try {
    const result = await withMcpLifecycleLock(opts.sandboxName, async () => {
      assertHermesPortableCommandUnavailable(opts.sandboxName, "sandbox:download");
      const sandboxPath = (opts.sandboxPath ?? "").trim();
      if (!sandboxPath) {
        throw new Error(
          `No sandbox path provided; usage: ${CLI_NAME} ${opts.sandboxName} download <sandbox-path> [host-dest]`,
        );
      }
      const hostDest = resolveHostPathFromCwd((opts.hostDest ?? "").trim() || ".");

      await ensureLiveSandboxOrExit(opts.sandboxName, {
        allowNonReadyPhase: opts.allowNonReadyPhase ?? true,
        exit: deferSandboxLifecycleExit,
      });

      const gatewayName = getKnownSandboxTargetGatewayName(opts.sandboxName);
      const target: OpenShellSandboxTransferRequest["target"] = gatewayName
        ? { kind: "named", gatewayName }
        : { kind: "selected" };
      const executor = createCliOpenShellSandboxCommandExecutor();

      // Resolve where a successful download should land *before* running it, so we
      // can confirm the artifact actually appeared afterwards. `openshell sandbox
      // download` can exit 0 without writing anything (e.g. a rejected
      // out-of-workspace source; NVIDIA/OpenShell#2456), and this command
      // otherwise trusts that exit code.
      // Keep this verification after OpenShell fixes that issue: NemoClaw's
      // wrapper independently requires a fresh artifact from this invocation
      // before it publishes anything to the requested host destination.
      const sourceKind = await probeSandboxSourceKind(
        executor,
        target,
        opts.sandboxName,
        sandboxPath,
      );
      if (sourceKind === "missing") {
        throw new SandboxDownloadSourceMissingError(sandboxPath, opts.sandboxName);
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
        completion = await createCliOpenShellSandboxTransferExecutor().run({
          direction: "download",
          sandboxName: opts.sandboxName,
          target,
          source: sandboxPath,
          destination: stagedArtifact,
        });
        const exitCode =
          completion.outcome.kind === "completed" ? completion.outcome.exitCode : null;
        if (exitCode !== 0 || completion.wasInterrupted()) {
          throw new Error(
            `Failed to download '${sandboxPath}' from sandbox '${opts.sandboxName}' (exit ${exitCode}).`,
          );
        }

        const sourceKindAfterDownload = await probeSandboxSourceKind(
          executor,
          target,
          opts.sandboxName,
          sandboxPath,
        );
        if (sourceKindAfterDownload === "timeout") {
          throw new Error(
            `Cannot publish '${sandboxPath}' from sandbox '${opts.sandboxName}': source verification timed out after download.`,
          );
        }
        if (completion.wasInterrupted() || sourceKindAfterDownload !== sourceKind) {
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
    });
    if (completion?.wasInterrupted()) {
      throw new Error(
        `Failed to download '${result.sandboxPath}' from sandbox '${opts.sandboxName}' (exit null).`,
      );
    }
    return result;
  } finally {
    completion?.release();
  }
}
