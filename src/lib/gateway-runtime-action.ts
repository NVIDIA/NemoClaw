// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { startGatewayForRecovery } = require("./onboard") as {
  startGatewayForRecovery: () => Promise<void>;
};
import { OPENSHELL_OPERATION_TIMEOUT_MS, OPENSHELL_PROBE_TIMEOUT_MS } from "./adapters/openshell/timeouts";
import { stripAnsi } from "./adapters/openshell/client";
import { captureOpenshell, runOpenshell } from "./adapters/openshell/runtime";

function hasNamedGateway(output = ""): boolean {
  return stripAnsi(output).includes("Gateway: nemoclaw");
}

function getActiveGatewayName(output = ""): string | null {
  const match = stripAnsi(output).match(/^\s*Gateway:\s+(.+?)\s*$/m);
  return match ? match[1].trim() : null;
}

export function getNamedGatewayLifecycleState() {
  const status = captureOpenshell(["status"], { timeout: OPENSHELL_PROBE_TIMEOUT_MS });
  const gatewayInfo = captureOpenshell(["gateway", "info", "-g", "nemoclaw"], {
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  const cleanStatus = stripAnsi(status.output);
  const activeGateway = getActiveGatewayName(status.output);
  const connected = /^\s*Status:\s*Connected\b/im.test(cleanStatus);
  const named = hasNamedGateway(gatewayInfo.output);
  const refusing = /Connection refused|client error \(Connect\)|tcp connect error/i.test(
    cleanStatus,
  );
  if (connected && activeGateway === "nemoclaw" && named) {
    return {
      state: "healthy_named",
      status: status.output,
      gatewayInfo: gatewayInfo.output,
      activeGateway,
    };
  }
  if (activeGateway === "nemoclaw" && named && refusing) {
    return {
      state: "named_unreachable",
      status: status.output,
      gatewayInfo: gatewayInfo.output,
      activeGateway,
    };
  }
  if (activeGateway === "nemoclaw" && named) {
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

/** Attempt to recover the named NemoClaw gateway after a restart or connectivity loss. */
export async function recoverNamedGatewayRuntime() {
  const before = getNamedGatewayLifecycleState();
  if (before.state === "healthy_named") {
    return { recovered: true, before, after: before, attempted: false };
  }

  runOpenshell(["gateway", "select", "nemoclaw"], {
    ignoreError: true,
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  let after = getNamedGatewayLifecycleState();
  if (after.state === "healthy_named") {
    process.env.OPENSHELL_GATEWAY = "nemoclaw";
    return { recovered: true, before, after, attempted: true, via: "select" };
  }

  const shouldStartGateway = [before.state, after.state].some((state) =>
    ["missing_named", "named_unhealthy", "named_unreachable", "connected_other"].includes(state),
  );

  if (shouldStartGateway) {
    try {
      await startGatewayForRecovery();
    } catch {
      // Fall through to the lifecycle re-check below so we preserve the
      // existing recovery result shape and emit the correct classification.
    }
    runOpenshell(["gateway", "select", "nemoclaw"], {
      ignoreError: true,
      timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
    });
    after = getNamedGatewayLifecycleState();
    if (after.state === "healthy_named") {
      process.env.OPENSHELL_GATEWAY = "nemoclaw";
      return { recovered: true, before, after, attempted: true, via: "start" };
    }
  }

  return { recovered: false, before, after, attempted: true };
}
