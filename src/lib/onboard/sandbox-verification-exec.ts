// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Run a shell snippet inside the named sandbox for verifyDeployment probes.
 * Returns null when the OpenShell exec itself fails to spawn or times out —
 * the verify layer treats that as "sandbox unreachable" rather than a probe
 * result, so we deliberately swallow spawn errors here.
 */

import type { OpenShellSandboxBufferedCommandExecutor } from "../adapters/openshell/sandbox-command";
import { selectedOpenShellGateway } from "../adapters/openshell/sandbox-observer";

const SANDBOX_EXEC_TIMEOUT_MS = 15000;

export function executeSandboxCommandForVerification(
  sandboxName: string,
  script: string,
  executor: OpenShellSandboxBufferedCommandExecutor,
): Promise<{ status: number; stdout: string; stderr: string } | null> {
  return executeSandboxVerification(executor, sandboxName, script);
}

async function executeSandboxVerification(
  executor: OpenShellSandboxBufferedCommandExecutor,
  sandboxName: string,
  script: string,
): Promise<{ status: number; stdout: string; stderr: string } | null> {
  try {
    const result = await executor.runBuffered({
      sandboxName,
      target: selectedOpenShellGateway(),
      command: ["sh", "-c", script],
      timeoutMilliseconds: SANDBOX_EXEC_TIMEOUT_MS,
    });
    if (result.outcome.kind === "failed") return null;
    return {
      status: result.outcome.exitCode,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch {
    return null;
  }
}
