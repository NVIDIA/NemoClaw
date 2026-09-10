// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createCliOpenShellSandboxTransferExecutor } from "../../adapters/openshell/sandbox-transfer-cli";
import type { OpenShellSandboxTransferCompletion } from "../../adapters/openshell/sandbox-transfer";

import { deferSandboxLifecycleExit } from "../../core/process-exit";
import { CLI_NAME } from "../../cli/branding";
import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock-acquisition";
import { ensureLiveSandboxOrExit, getKnownSandboxTargetGatewayName } from "./gateway-state";
import { resolveHostPathFromCwd } from "./host-path";

export interface SandboxUploadOptions {
  sandboxName: string;
  hostPath: string;
  sandboxDest?: string;
  allowNonReadyPhase?: boolean;
}

export interface SandboxUploadResult {
  hostPath: string;
  sandboxDest: string;
}

export class SandboxUploadTransferError extends Error {
  readonly exitCode: number;
  constructor(code: number | null) {
    super(`OpenShell command failed (exit ${code})`);
    this.exitCode = code || 1;
  }
}

export async function uploadToSandbox(opts: SandboxUploadOptions): Promise<SandboxUploadResult> {
  let completion: OpenShellSandboxTransferCompletion | undefined;
  try {
    const result = await withMcpLifecycleLock(opts.sandboxName, async () => {
      assertHermesPortableCommandUnavailable(opts.sandboxName, "sandbox:upload");
      const trimmedHostPath = (opts.hostPath ?? "").trim();
      if (!trimmedHostPath) {
        throw new Error(
          `No host path provided; usage: ${CLI_NAME} ${opts.sandboxName} upload <host-path> [sandbox-dest]`,
        );
      }
      const hostPath = resolveHostPathFromCwd(trimmedHostPath);
      const sandboxDest = (opts.sandboxDest ?? "").trim() || "/sandbox/";

      await ensureLiveSandboxOrExit(opts.sandboxName, {
        allowNonReadyPhase: opts.allowNonReadyPhase ?? true,
        exit: deferSandboxLifecycleExit,
      });

      const gatewayName = getKnownSandboxTargetGatewayName(opts.sandboxName);
      completion = await createCliOpenShellSandboxTransferExecutor().run({
        direction: "upload",
        sandboxName: opts.sandboxName,
        target: gatewayName ? { kind: "named", gatewayName } : { kind: "selected" },
        source: hostPath,
        destination: sandboxDest,
      });
      const exitCode =
        completion.outcome.kind === "completed" && !completion.wasInterrupted()
          ? completion.outcome.exitCode
          : null;
      if (exitCode !== 0) {
        throw new SandboxUploadTransferError(exitCode);
      }

      return { hostPath, sandboxDest };
    });
    if (completion?.wasInterrupted()) {
      throw new SandboxUploadTransferError(null);
    }
    return result;
  } finally {
    completion?.release();
  }
}
