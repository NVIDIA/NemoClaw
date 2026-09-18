// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellRuntimeSelection } from "../../../adapters/openshell/runtime-selection";
import {
  executePrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
} from "../../../sandbox/privileged-exec";
import type { GatewayRestartCommandResult } from "../gateway-restart";

/** Run the native lifecycle command as the agent user through host runtime authority. */
export function restartOpenClawGatewayThroughProvider(
  sandboxName: string,
  runtimeSelection?: OpenShellRuntimeSelection,
  registeredGatewayName?: string | null,
): GatewayRestartCommandResult {
  try {
    if (
      runtimeSelection &&
      (runtimeSelection.workspace !== "default" ||
        runtimeSelection.gatewayName !== registeredGatewayName)
    ) {
      throw new Error("Native restart runtime selection does not match the registered sandbox");
    }
    const target = resolvePrivilegedSandboxTarget(sandboxName);
    // The gateway runs outside sandbox exec's Landlock domain. Host runtime
    // authority can launch its native CLI there without widening device scopes.
    // Drop root and all capabilities before loading any agent code or config.
    const result = executePrivilegedSandboxCommand(
      sandboxName,
      [
        "/usr/bin/setpriv",
        "--reuid=sandbox",
        "--regid=sandbox",
        "--init-groups",
        "--no-new-privs",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--bounding-set=-all",
        "/usr/bin/env",
        "-i",
        "HOME=/sandbox",
        "USER=sandbox",
        "LOGNAME=sandbox",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "OPENSHELL_SANDBOX=1",
        "/usr/local/bin/openclaw",
        "gateway",
        "restart",
        "--json",
      ],
      { sanitizeEnvironment: true, expectedResourceHandle: target.resourceHandle, timeout: 210000 },
    );
    return {
      status: result.error ? 1 : (result.status ?? 1),
      stdout: result.stdout.toString("utf8"),
      stderr: result.error?.message ?? result.stderr.toString("utf8"),
    };
  } catch (error) {
    return {
      status: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : "Host runtime restart unavailable",
    };
  }
}
