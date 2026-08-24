// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  detectOpenShellStateRpcPreflightIssue,
  printOpenShellStateRpcIssue,
} from "./adapters/openshell/gateway-drift";
import {
  createCliOpenShellSandboxObserver,
  namedOpenShellGateway,
  selectedOpenShellGateway,
  type OpenShellSandboxInventory,
  type OpenShellSandboxObserver,
  type OpenShellSandboxResult,
} from "./adapters/openshell/sandbox-observer-cli";
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
  return !result.ok && result.error.kind === "transport";
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
        result: {
          ok: false,
          error: {
            kind: "transport",
            reason: "unreachable",
            message: "OpenShell could not reach the selected gateway.",
          },
        },
        recoveryAttempted: targetRecovery.attempted === true,
        recoverySucceeded: false,
      };
    }
  }

  const target = options.gatewayName
    ? namedOpenShellGateway(options.gatewayName)
    : selectedOpenShellGateway();
  const initial = await observer.listSandboxes({ target });
  if (!isRecoverableObservedSandboxListGatewayFailure(initial)) {
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
  if (!result.ok && result.error.kind === "schema") {
    printOpenShellStateRpcIssue({ kind: "protobuf_mismatch", drift: null, output: "" }, context);
    process.exit(1);
  }
  return result.ok ? result.value : { sandboxes: [] };
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
