// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stripAnsi } from "./adapters/openshell/client";
import * as openshellRuntime from "./adapters/openshell/runtime";
import {
  classifyCliOpenShellCommandError,
  type CapturedSandboxCommandResult,
} from "./adapters/openshell/sandbox-observer-cli";
import {
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "./adapters/openshell/timeouts";
import { GATEWAY_PORT } from "./core/ports";
import {
  resolveGatewayName,
  resolveGatewayPortFromName,
  resolveSandboxGatewayName,
} from "./onboard/gateway-binding";

export { resolveGatewayName, resolveSandboxGatewayName };

type StartGatewayForRecoveryOptions = {
  gatewayName?: string;
  gatewayPort?: number;
};

type LegacyOnboardModule = {
  startGatewayForRecovery(options?: StartGatewayForRecoveryOptions): Promise<void>;
};

/**
 * Injectable boundary for OpenShell calls and the deliberately lazy onboarding
 * recovery path. Source-backed tests spy here without loading the onboard graph
 * or invalidating the CommonJS module cache before every test.
 */
export const gatewayRuntimeDependencies = {
  captureOpenshell(...args: Parameters<typeof openshellRuntime.captureOpenshell>) {
    return openshellRuntime.captureOpenshell(...args);
  },
  runOpenshell(...args: Parameters<typeof openshellRuntime.runOpenshell>) {
    return openshellRuntime.runOpenshell(...args);
  },
  async startGatewayForRecovery(options?: StartGatewayForRecoveryOptions): Promise<void> {
    const onboard = (await import("./onboard")) as unknown as LegacyOnboardModule;
    return onboard.startGatewayForRecovery(options);
  },
};

/** Whether `gateway info` output names the given NemoClaw gateway. */
function hasNamedGateway(output = "", gatewayName = "nemoclaw"): boolean {
  return stripAnsi(output).includes(`Gateway: ${gatewayName}`);
}

/** Parse the active gateway name from `openshell status` output, or null. */
function getActiveGatewayName(output = ""): string | null {
  const match = stripAnsi(output).match(/^\s*Gateway:\s+(.+?)\s*$/m);
  return match ? match[1].trim() : null;
}

function blocksNamedGatewayRecovery(result: CapturedSandboxCommandResult): boolean {
  const error = classifyCliOpenShellCommandError(result);
  return (
    error?.kind === "authentication" ||
    error?.kind === "schema" ||
    (error?.kind === "transport" && error.reason === "identity_mismatch") ||
    (error?.kind === "command" && error.reason === "invalid_request")
  );
}

export type NamedGatewayLifecycleState = {
  state:
    | "healthy_named"
    | "named_unreachable"
    | "named_unhealthy"
    | "connected_other"
    | "missing_named";
  status: string;
  gatewayInfo: string;
  activeGateway: string | null;
  recoveryBlocked?: boolean;
};

/**
 * Classify the lifecycle state of the named gateway (healthy_named,
 * named_unreachable, named_unhealthy, connected_other, or missing_named) from
 * `openshell status` and `gateway info`. Pass `ignoreProbeErrors` to keep the
 * probes non-fatal so a hung/timed-out gateway is classified rather than
 * exiting the process.
 */
export function getNamedGatewayLifecycleState(
  gatewayName: string = resolveGatewayName(GATEWAY_PORT),
  opts: { ignoreProbeErrors?: boolean } = {},
): NamedGatewayLifecycleState {
  // #5714: callers that must stay non-fatal (e.g. plain `nemoclaw list`
  // recovery) opt into `ignoreProbeErrors` so a hung/timed-out `openshell
  // status` returns a not-healthy classification instead of `process.exit`ing
  // via captureOpenshell's default error handling. Other callers keep the
  // existing fatal behavior by default.
  const ignoreError = opts.ignoreProbeErrors === true;
  // When ignoring probe errors we must still capture stderr — OpenShell writes
  // the `Status:`/`Gateway:` lines there, and `ignoreError` would otherwise
  // drop stderr and break the healthy/connected classification.
  const status = gatewayRuntimeDependencies.captureOpenshell(["status"], {
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    ignoreError,
    includeStderr: ignoreError,
  });
  const gatewayInfo = gatewayRuntimeDependencies.captureOpenshell(
    ["gateway", "info", "-g", gatewayName],
    {
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      ignoreError,
      includeStderr: ignoreError,
    },
  );
  const cleanStatus = stripAnsi(status.output);
  const activeGateway = getActiveGatewayName(status.output);
  const connected = /^\s*Status:\s*Connected\b/im.test(cleanStatus);
  const named = hasNamedGateway(gatewayInfo.output, gatewayName);
  const gatewayInfoUnsupported = /gateway info is not supported by this gateway version/i.test(
    stripAnsi(gatewayInfo.output),
  );
  const refusing = /Connection refused|client error \(Connect\)|tcp connect error/i.test(
    cleanStatus,
  );
  const lifecycle = {
    status: status.output,
    gatewayInfo: gatewayInfo.output,
    activeGateway,
    recoveryBlocked: blocksNamedGatewayRecovery(status) || blocksNamedGatewayRecovery(gatewayInfo),
  };
  // OpenShell 0.0.72 can serve status and sandbox RPCs but does not implement
  // GetGatewayInfo. The pre-upgrade backup deliberately uses the current CLI
  // against that existing gateway before replacing it. Accept only the exact
  // unsupported response when status independently proves the requested
  // gateway is active and connected; arbitrary info failures remain unhealthy.
  if (connected && activeGateway === gatewayName && (named || gatewayInfoUnsupported)) {
    return {
      state: "healthy_named",
      ...lifecycle,
    };
  }
  if (activeGateway === gatewayName && named && refusing) {
    return {
      state: "named_unreachable",
      ...lifecycle,
    };
  }
  if (activeGateway === gatewayName && named) {
    return {
      state: "named_unhealthy",
      ...lifecycle,
    };
  }
  if (connected) {
    return {
      state: "connected_other",
      ...lifecycle,
    };
  }
  return {
    state: "missing_named",
    ...lifecycle,
  };
}

type NamedGatewayLifecycleStateName = NamedGatewayLifecycleState["state"];

export type RecoverNamedGatewayRuntimeOptions = {
  recoverableStates?: readonly NamedGatewayLifecycleStateName[];
  gatewayName?: string;
};

/** Attempt to recover the named NemoClaw gateway after a restart or connectivity loss. */
export async function recoverNamedGatewayRuntime(options: RecoverNamedGatewayRuntimeOptions = {}) {
  const gatewayName = options.gatewayName ?? resolveGatewayName(GATEWAY_PORT);
  const recoverableStates = new Set<NamedGatewayLifecycleStateName>(
    options.recoverableStates ?? [
      "missing_named",
      "named_unhealthy",
      "named_unreachable",
      "connected_other",
    ],
  );
  const before = getNamedGatewayLifecycleState(gatewayName);
  if (before.recoveryBlocked) {
    return { recovered: false, before, after: before, attempted: false };
  }
  if (before.state === "healthy_named") {
    return { recovered: true, before, after: before, attempted: false };
  }
  if (!recoverableStates.has(before.state)) {
    return { recovered: false, before, after: before, attempted: false };
  }

  gatewayRuntimeDependencies.runOpenshell(["gateway", "select", gatewayName], {
    ignoreError: true,
    stdio: "ignore",
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  let after = getNamedGatewayLifecycleState(gatewayName);
  if (after.recoveryBlocked) {
    return { recovered: false, before, after, attempted: true };
  }
  if (after.state === "healthy_named") {
    process.env.OPENSHELL_GATEWAY = gatewayName;
    return { recovered: true, before, after, attempted: true, via: "select" };
  }

  const shouldStartGateway = [before.state, after.state].some((state) =>
    recoverableStates.has(state),
  );

  if (shouldStartGateway) {
    try {
      await gatewayRuntimeDependencies.startGatewayForRecovery({
        gatewayName,
        gatewayPort: resolveGatewayPortFromName(gatewayName) ?? undefined,
      });
    } catch {
      // Fall through to the lifecycle re-check below so we preserve the
      // existing recovery result shape and emit the correct classification.
    }
    gatewayRuntimeDependencies.runOpenshell(["gateway", "select", gatewayName], {
      ignoreError: true,
      stdio: "ignore",
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    after = getNamedGatewayLifecycleState(gatewayName);
    if (after.state === "healthy_named") {
      process.env.OPENSHELL_GATEWAY = gatewayName;
      return { recovered: true, before, after, attempted: true, via: "start" };
    }
  }

  return { recovered: false, before, after, attempted: true };
}
