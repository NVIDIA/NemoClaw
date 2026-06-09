// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { bestEffortForwardStopForSandbox } from "./forward-cleanup";

export interface DashboardForwardOptions {
  rollbackSandboxOnFailure?: boolean;
  preserveSandboxPorts?: Array<number | string>;
  allowPortReallocation?: boolean;
}

export function normalizeDashboardForwardOptions(options: DashboardForwardOptions = {}): {
  rollbackSandboxOnFailure: boolean;
  preservedPorts: Set<string>;
  allowPortReallocation: boolean;
} {
  return {
    rollbackSandboxOnFailure: options.rollbackSandboxOnFailure === true,
    preservedPorts: new Set((options.preserveSandboxPorts ?? []).map((port) => String(port))),
    allowPortReallocation: options.allowPortReallocation !== false,
  };
}

export function createSandboxForwardStopper(deps: {
  runOpenshell: Parameters<typeof bestEffortForwardStopForSandbox>[0];
  runCaptureOpenshell: (args: string[], opts?: Record<string, unknown>) => string | null;
  sandboxName: string;
}): (port: string | number) => ReturnType<typeof bestEffortForwardStopForSandbox> | null {
  const stoppedPorts = new Set<string>();
  return (port: string | number) => {
    const portKey = String(port);
    if (stoppedPorts.has(portKey)) return null;
    const result = bestEffortForwardStopForSandbox(
      deps.runOpenshell,
      (args, opts) => {
        const output = deps.runCaptureOpenshell(args, opts);
        if (output === null) {
          throw new Error("Failed to list OpenShell forwards before stopping dashboard forward");
        }
        return output;
      },
      port,
      deps.sandboxName,
    );
    if (result === "stopped" || result === "no-entry") {
      stoppedPorts.add(portKey);
    }
    return result;
  };
}
