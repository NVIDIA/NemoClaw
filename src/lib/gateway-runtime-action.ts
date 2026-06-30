// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { startGatewayForRecovery } = require("./onboard") as {
  startGatewayForRecovery: (options?: {
    gatewayName?: string;
    gatewayPort?: number;
  }) => Promise<void>;
};

import { stripAnsi } from "./adapters/openshell/client";
import { captureOpenshell, runOpenshell } from "./adapters/openshell/runtime";
import {
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "./adapters/openshell/timeouts";
import { GATEWAY_PORT } from "./core/ports";
import { resolveGatewayName, resolveGatewayPortFromName } from "./onboard/gateway-binding";

/** Whether `gateway info` output names the given NemoClaw gateway. */
function hasNamedGateway(output = "", gatewayName = "nemoclaw"): boolean {
  return stripAnsi(output).includes(`Gateway: ${gatewayName}`);
}

/** Parse the active gateway name from `openshell status` output, or null. */
function getActiveGatewayName(output = ""): string | null {
  const match = stripAnsi(output).match(/^\s*Gateway:\s+(.+?)\s*$/m);
  return match ? match[1].trim() : null;
}

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
) {
  // #5714: callers that must stay non-fatal (e.g. plain `nemoclaw list`
  // recovery) opt into `ignoreProbeErrors` so a hung/timed-out `openshell
  // status` returns a not-healthy classification instead of `process.exit`ing
  // via captureOpenshell's default error handling. Other callers keep the
  // existing fatal behavior by default.
  const ignoreError = opts.ignoreProbeErrors === true;
  // When ignoring probe errors we must still capture stderr — OpenShell writes
  // the `Status:`/`Gateway:` lines there, and `ignoreError` would otherwise
  // drop stderr and break the healthy/connected classification.
  const status = captureOpenshell(["status"], {
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    ignoreError,
    includeStderr: ignoreError,
  });
  const gatewayInfo = captureOpenshell(["gateway", "info", "-g", gatewayName], {
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    ignoreError,
    includeStderr: ignoreError,
  });
  const cleanStatus = stripAnsi(status.output);
  const activeGateway = getActiveGatewayName(status.output);
  const connected = /^\s*Status:\s*Connected\b/im.test(cleanStatus);
  const named = hasNamedGateway(gatewayInfo.output, gatewayName);
  const refusing = /Connection refused|client error \(Connect\)|tcp connect error/i.test(
    cleanStatus,
  );
  if (connected && activeGateway === gatewayName && named) {
    return {
      state: "healthy_named",
      status: status.output,
      gatewayInfo: gatewayInfo.output,
      activeGateway,
    };
  }
  if (activeGateway === gatewayName && named && refusing) {
    return {
      state: "named_unreachable",
      status: status.output,
      gatewayInfo: gatewayInfo.output,
      activeGateway,
    };
  }
  if (activeGateway === gatewayName && named) {
    return {
      state: "named_unhealthy",
      status: status.output,
      gatewayInfo: gatewayInfo.output,
      activeGateway,
    };
  }
  if (connected) {
    return {
      state: "connected_other",
      status: status.output,
      gatewayInfo: gatewayInfo.output,
      activeGateway,
    };
  }
  return {
    state: "missing_named",
    status: status.output,
    gatewayInfo: gatewayInfo.output,
    activeGateway,
  };
}

type NamedGatewayLifecycleStateName = ReturnType<typeof getNamedGatewayLifecycleState>["state"];

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
  if (before.state === "healthy_named") {
    return { recovered: true, before, after: before, attempted: false };
  }
  if (!recoverableStates.has(before.state)) {
    return { recovered: false, before, after: before, attempted: false };
  }

  runOpenshell(["gateway", "select", gatewayName], {
    ignoreError: true,
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  let after = getNamedGatewayLifecycleState(gatewayName);
  if (after.state === "healthy_named") {
    process.env.OPENSHELL_GATEWAY = gatewayName;
    return { recovered: true, before, after, attempted: true, via: "select" };
  }

  const shouldStartGateway = [before.state, after.state].some(
    (state) =>
      recoverableStates.has(state) &&
      ["missing_named", "named_unhealthy", "named_unreachable", "connected_other"].includes(state),
  );

  if (shouldStartGateway) {
    try {
      await startGatewayForRecovery({
        gatewayName,
        gatewayPort: resolveGatewayPortFromName(gatewayName) ?? undefined,
      });
    } catch {
      // Fall through to the lifecycle re-check below so we preserve the
      // existing recovery result shape and emit the correct classification.
    }
    runOpenshell(["gateway", "select", gatewayName], {
      ignoreError: true,
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
