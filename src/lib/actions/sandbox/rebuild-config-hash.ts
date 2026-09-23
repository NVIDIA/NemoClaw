// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { SandboxCommandTransportError } from "../../adapters/sandbox/command-transport";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime";
import { R, YW } from "../../cli/terminal-style";
import { redact } from "../../security/redact";
import { executeSandboxExecCommand } from "../../adapters/sandbox/command-transport";
import {
  buildRefreshMutableOpenClawConfigHashCommand,
  buildVerifyMutableOpenClawConfigHashCommand,
} from "./rebuild-config-hash-command";

export { buildRefreshMutableOpenClawConfigHashCommand };

function transportFailureResult(error: unknown) {
  if (!(error instanceof SandboxCommandTransportError)) throw error;
  return { status: 1, stdout: "", stderr: error.message };
}

export async function refreshMutableOpenClawConfigHashAfterPostRestoreWrites(
  sandboxName: string,
  log: (msg: string) => void,
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<boolean> {
  const result = await (
    runtimeSelection
      ? executeSandboxExecCommand(
          sandboxName,
          buildRefreshMutableOpenClawConfigHashCommand(),
          undefined,
          { runtimeSelection },
        )
      : executeSandboxExecCommand(sandboxName, buildRefreshMutableOpenClawConfigHashCommand())
  ).catch(transportFailureResult);
  if (result.status === 0) {
    log("Mutable OpenClaw config hash refreshed after post-restore config writes");
    return true;
  }

  const detail =
    [result.stderr, result.stdout].filter(Boolean).join("; ") || `exit ${result.status}`;
  console.error(`  ${YW}⚠${R} Mutable OpenClaw config hash was not refreshed: ${redact(detail)}`);
  return false;
}

export async function verifyFinalMutableOpenClawConfigHash(
  sandboxName: string,
  log: (msg: string) => void,
  runtimeSelection?: OpenShellRuntimeSelection,
): Promise<boolean> {
  const result = await (
    runtimeSelection
      ? executeSandboxExecCommand(
          sandboxName,
          buildVerifyMutableOpenClawConfigHashCommand(),
          undefined,
          { runtimeSelection },
        )
      : executeSandboxExecCommand(sandboxName, buildVerifyMutableOpenClawConfigHashCommand())
  ).catch(transportFailureResult);
  if (result.status === 0) {
    log("Final mutable OpenClaw config hash verified after post-restore finalization");
    return true;
  }

  const detail =
    [result.stderr, result.stdout].filter(Boolean).join("; ") || `exit ${result.status}`;
  console.error(
    `  ${YW}⚠${R} Final mutable OpenClaw config hash was not verified: ${redact(detail)}`,
  );
  return false;
}
