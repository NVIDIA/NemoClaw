// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stripAnsi } from "./adapters/openshell/client";
import {
  detectOpenShellStateRpcPreflightIssue,
  detectOpenShellStateRpcResultIssue,
  printOpenShellStateRpcIssue,
} from "./adapters/openshell/gateway-drift";
import { captureOpenshell } from "./adapters/openshell/runtime";
import { recoverNamedGatewayRuntime } from "./gateway-runtime-action";

type SandboxListResult = ReturnType<typeof captureOpenshell>;

export type SandboxListPreflightContext = {
  action: string;
  command: string;
};

export type SandboxListRecoveryResult = {
  result: SandboxListResult;
  recoveryAttempted: boolean;
  recoverySucceeded: boolean;
};

export type CaptureSandboxListWithGatewayRecoveryOptions = {
  gatewayName?: string;
};

export function isRecoverableSandboxListGatewayFailure(
  result: SandboxListResult,
  options: CaptureSandboxListWithGatewayRecoveryOptions = {},
): boolean {
  if (result.status === 0 || detectOpenShellStateRpcResultIssue(result, options)) {
    return false;
  }
  const output = stripAnsi(String(result.output || ""));
  return /Connection refused|client error \(Connect\)|tcp connect error|No active gateway|No gateway configured|Status:\s*Disconnected/i.test(
    output,
  );
}

export async function captureSandboxListWithGatewayRecovery(
  options: CaptureSandboxListWithGatewayRecoveryOptions = {},
): Promise<SandboxListRecoveryResult> {
  const recoveryOptions: Parameters<typeof recoverNamedGatewayRuntime>[0] = {
    recoverableStates: ["missing_named", "named_unhealthy", "named_unreachable", "connected_other"],
  };
  if (options.gatewayName) {
    recoveryOptions.gatewayName = options.gatewayName;
  }

  // An explicit target must be proven healthy and active before an unscoped
  // `sandbox list` can be trusted. OpenShell otherwise leaves a failed select
  // on the current sibling gateway, whose successful list would be unsafe
  // evidence for destructive recovery decisions (#6114).
  let targetRecoveryAttempted = false;
  if (options.gatewayName) {
    const targetRecovery = await recoverNamedGatewayRuntime(recoveryOptions);
    targetRecoveryAttempted = targetRecovery.attempted === true;
    if (!targetRecovery.recovered) {
      return {
        result: { status: 1, output: "" },
        recoveryAttempted: targetRecovery.attempted === true,
        recoverySucceeded: false,
      };
    }
  }

  const initial = captureOpenshell(["sandbox", "list"]);
  if (!isRecoverableSandboxListGatewayFailure(initial, options)) {
    return {
      result: initial,
      recoveryAttempted: targetRecoveryAttempted,
      recoverySucceeded: targetRecoveryAttempted,
    };
  }

  const recovery = await recoverNamedGatewayRuntime(recoveryOptions);
  if (!recovery.recovered) {
    return { result: initial, recoveryAttempted: true, recoverySucceeded: false };
  }

  return {
    result: captureOpenshell(["sandbox", "list"]),
    recoveryAttempted: true,
    recoverySucceeded: true,
  };
}

export async function captureSandboxListWithGatewayPreflightOrExit(
  context: SandboxListPreflightContext,
  options: CaptureSandboxListWithGatewayRecoveryOptions = {},
): Promise<SandboxListResult> {
  const preflightIssue = detectOpenShellStateRpcPreflightIssue(options);
  if (preflightIssue) {
    printOpenShellStateRpcIssue(preflightIssue, context);
    process.exit(1);
  }

  const recovery = await captureSandboxListWithGatewayRecovery(options);
  const resultIssue = detectOpenShellStateRpcResultIssue(recovery.result, options);
  if (resultIssue) {
    printOpenShellStateRpcIssue(resultIssue, context);
    process.exit(1);
  }
  if (recovery.result.status !== 0) {
    printSandboxListFailureWithRecoveryContext(recovery);
    process.exit(recovery.result.status || 1);
  }
  return recovery.result;
}

export function printSandboxListFailureWithRecoveryContext(
  recoveryResult: SandboxListRecoveryResult,
): void {
  console.error("  Failed to query running sandboxes from OpenShell.");
  if (recoveryResult.recoveryAttempted) {
    if (recoveryResult.recoverySucceeded) {
      console.error(
        "  The NemoClaw OpenShell gateway was recovered, but the sandbox query still failed.",
      );
    } else {
      console.error(
        "  NemoClaw tried to recover its OpenShell gateway, but recovery did not complete.",
      );
    }
  }
  console.error("  Ensure OpenShell is running: openshell status");
}
