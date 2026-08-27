// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  detectOpenShellStateRpcPreflightIssue,
  printOpenShellStateRpcIssue,
} from "./adapters/openshell/gateway-drift";
import { createCliOpenShellSandboxObserver } from "./adapters/openshell/sandbox-observer-cli";
import {
  namedOpenShellGateway,
  selectedOpenShellGateway,
  type OpenShellSandboxInventory,
  type OpenShellSandboxObserver,
  type OpenShellSandboxResult,
} from "./adapters/openshell/sandbox-observer";
import { captureOpenshell } from "./adapters/openshell/runtime";
import { recoverNamedGatewayRuntime } from "./gateway-runtime-action";

type SandboxListResult = OpenShellSandboxResult<OpenShellSandboxInventory>;

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
  observer?: OpenShellSandboxObserver;
};

function isRecoverableObservedSandboxListGatewayFailure(result: SandboxListResult): boolean {
  return !result.ok && result.error.kind === "transport" && result.error.reason === "unreachable";
}

export async function captureSandboxListWithGatewayRecovery(
  options: CaptureSandboxListWithGatewayRecoveryOptions = {},
): Promise<SandboxListRecoveryResult> {
  const observer =
    options.observer ??
    createCliOpenShellSandboxObserver({
      capture: captureOpenshell,
    });
  const recoveryOptions: Parameters<typeof recoverNamedGatewayRuntime>[0] = {
    recoverableStates: ["missing_named", "named_unhealthy", "named_unreachable", "connected_other"],
  };
  if (options.gatewayName) {
    recoveryOptions.gatewayName = options.gatewayName;
  }

  const target = options.gatewayName
    ? namedOpenShellGateway(options.gatewayName)
    : selectedOpenShellGateway();
  let targetRecoveryAttempted = false;
  // Installer retirement can remove the named gateway. Recover it before inventory
  // so a missing-gateway command error cannot bypass bounded recovery.
  if (options.gatewayName) {
    const targetRecovery = await recoverNamedGatewayRuntime(recoveryOptions);
    targetRecoveryAttempted = targetRecovery.attempted === true;
    if (!targetRecovery.recovered) {
      return {
        result: {
          ok: false,
          error: {
            kind: "transport",
            reason: "unreachable",
            message: "OpenShell could not reach the selected gateway.",
          },
        },
        recoveryAttempted: targetRecoveryAttempted,
        recoverySucceeded: false,
      };
    }
  }

  const initial = await observer.listSandboxes({ target });
  if (!isRecoverableObservedSandboxListGatewayFailure(initial)) {
    return {
      result: initial,
      recoveryAttempted: targetRecoveryAttempted,
      recoverySucceeded: targetRecoveryAttempted,
    };
  }

  if (options.gatewayName && targetRecoveryAttempted) {
    return {
      result: initial,
      recoveryAttempted: true,
      recoverySucceeded: true,
    };
  }

  const recovery = await recoverNamedGatewayRuntime(recoveryOptions);
  if (!recovery.recovered) {
    return { result: initial, recoveryAttempted: true, recoverySucceeded: false };
  }

  return {
    result: await observer.listSandboxes({ target }),
    recoveryAttempted: true,
    recoverySucceeded: true,
  };
}

export async function captureSandboxListWithGatewayPreflightOrExit(
  context: SandboxListPreflightContext,
  options: CaptureSandboxListWithGatewayRecoveryOptions = {},
): Promise<OpenShellSandboxInventory> {
  const preflightOptions = options.gatewayName ? { gatewayName: options.gatewayName } : {};
  const preflightIssue = detectOpenShellStateRpcPreflightIssue(preflightOptions);
  if (preflightIssue) {
    printOpenShellStateRpcIssue(preflightIssue, context);
    process.exit(1);
  }

  const recovery = await captureSandboxListWithGatewayRecovery(options);
  if (!recovery.result.ok && recovery.result.error.kind === "schema") {
    printOpenShellStateRpcIssue({ kind: "protobuf_mismatch", drift: null, output: "" }, context);
    process.exit(1);
  }
  if (!recovery.result.ok) {
    printSandboxListFailureWithRecoveryContext(recovery);
    process.exit(
      recovery.result.error.kind === "command" && recovery.result.error.reason === "invalid_request"
        ? 2
        : 1,
    );
  }
  return recovery.result.value;
}

/**
 * Read-only sandbox list scoped to a named gateway, for commands that must not
 * mutate gateway state (e.g. `upgrade-sandboxes --check`, #7279). Unlike
 * captureSandboxListWithGatewayPreflightOrExit it never recovers, starts, or
 * `gateway select`s: it runs `sandbox list -g <name>`, which targets the named
 * gateway without selecting it. State-RPC drift still blocks (shared detectors),
 * but a down or unreachable gateway is non-fatal — its empty output makes the
 * sandbox report as unobserved instead of triggering a gateway start.
 */
export async function captureNamedGatewaySandboxListReadOnly(
  context: SandboxListPreflightContext,
  gatewayName: string,
  observer: OpenShellSandboxObserver = createCliOpenShellSandboxObserver({
    capture: captureOpenshell,
  }),
): Promise<OpenShellSandboxInventory> {
  const options: CaptureSandboxListWithGatewayRecoveryOptions = { gatewayName };
  const preflightIssue = detectOpenShellStateRpcPreflightIssue(options);
  if (preflightIssue) {
    printOpenShellStateRpcIssue(preflightIssue, context);
    process.exit(1);
  }

  const result = await observer.listSandboxes({ target: namedOpenShellGateway(gatewayName) });
  if (result.ok) return result.value;
  if (result.error.kind === "transport" && result.error.reason === "unreachable") {
    return { sandboxes: [] };
  }
  if (result.error.kind === "schema") {
    printOpenShellStateRpcIssue({ kind: "protobuf_mismatch", drift: null, output: "" }, context);
    process.exit(1);
  }
  console.error("  Failed to query running sandboxes from OpenShell.");
  console.error(`  ${result.error.message}`);
  process.exit(
    result.error.kind === "command" && result.error.reason === "invalid_request" ? 2 : 1,
  );
}

export function printSandboxListFailureWithRecoveryContext(
  recoveryResult: SandboxListRecoveryResult,
): void {
  console.error("  Failed to query running sandboxes from OpenShell.");
  if (!recoveryResult.result.ok) {
    const error = recoveryResult.result.error;
    const reason = "reason" in error ? error.reason : "none";
    console.error(
      `  OpenShell sandbox inventory error: kind=${error.kind}; reason=${reason}; gateway recovery attempted=${recoveryResult.recoveryAttempted ? "yes" : "no"}.`,
    );
    console.error(`  ${error.message}`);
  }
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
