// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createCliOpenShellGatewayObserver } from "./adapters/openshell/gateway-observer-cli";
import type { OpenShellGatewayObservation } from "./adapters/openshell/gateway-observer";
import * as openshellRuntime from "./adapters/openshell/runtime";
import { GATEWAY_PORT } from "./core/ports";
import {
  resolveGatewayName,
  resolveGatewayPortFromName,
  resolveSandboxGatewayName,
} from "./onboard/gateway-binding";
import type { GatewayRecoveryOutput } from "./onboard/gateway-recovery";

export { resolveGatewayName, resolveSandboxGatewayName };

export const replaceOpenShellRuntimeSelectionEnv =
  openshellRuntime.replaceOpenShellRuntimeSelectionEnv;
export const snapshotOpenShellEnv = openshellRuntime.snapshotOpenShellEnv;

type StartGatewayForRecoveryOptions = {
  gatewayName?: string;
  gatewayPort?: number;
  output?: GatewayRecoveryOutput;
  runtimeSelection?: openshellRuntime.OpenShellRuntimeSelection;
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
  observeGateway: createCliOpenShellGatewayObserver((args, opts) =>
    openshellRuntime.captureResolvedOpenshell(args, opts),
  ).observeGateway,
  runOpenshell(...args: Parameters<typeof openshellRuntime.runOpenshell>) {
    return openshellRuntime.runOpenshell(...args);
  },
  async startGatewayForRecovery(options?: StartGatewayForRecoveryOptions): Promise<void> {
    const onboard = (await import("./onboard")) as unknown as LegacyOnboardModule;
    return onboard.startGatewayForRecovery(options);
  },
};

export type NamedGatewayLifecycleState = OpenShellGatewayObservation;

/** Read gateway identity and selection through the typed observation boundary. */
export async function getNamedGatewayLifecycleState(
  gatewayName: string = resolveGatewayName(GATEWAY_PORT),
  opts: { runtimeSelection?: openshellRuntime.OpenShellRuntimeSelection } = {},
): Promise<NamedGatewayLifecycleState> {
  return gatewayRuntimeDependencies.observeGateway({
    target: { kind: "named", gatewayName },
    ...(opts.runtimeSelection ? { runtimeSelection: opts.runtimeSelection } : {}),
  });
}

type NamedGatewayLifecycleStateName = NamedGatewayLifecycleState["state"];

export type RecoverNamedGatewayRuntimeOptions = {
  recoverableStates?: readonly NamedGatewayLifecycleStateName[];
  gatewayName?: string;
  output?: GatewayRecoveryOutput;
  runtimeSelection?: openshellRuntime.OpenShellRuntimeSelection;
};

/** Attempt to recover the named NemoClaw gateway after a restart or connectivity loss. */
export async function recoverNamedGatewayRuntime(options: RecoverNamedGatewayRuntimeOptions = {}) {
  const gatewayName = options.gatewayName ?? resolveGatewayName(GATEWAY_PORT);
  if (options.runtimeSelection && options.runtimeSelection.gatewayName !== gatewayName) {
    throw new Error(
      `Gateway recovery target '${gatewayName}' does not match runtime selection '${options.runtimeSelection.gatewayName}'`,
    );
  }
  const lifecycleOptions = options.runtimeSelection
    ? { runtimeSelection: options.runtimeSelection }
    : {};
  const recoverableStates = new Set<NamedGatewayLifecycleStateName>(
    options.recoverableStates ?? [
      "missing_named",
      "named_unhealthy",
      "named_unreachable",
      "connected_other",
    ],
  );
  const before = await getNamedGatewayLifecycleState(gatewayName, lifecycleOptions);
  if (before.recoveryBlocked) {
    return { recovered: false, before, after: before, attempted: false };
  }
  if (before.state === "healthy_named") {
    return { recovered: true, before, after: before, attempted: false };
  }
  if (!recoverableStates.has(before.state)) {
    return { recovered: false, before, after: before, attempted: false };
  }

  gatewayRuntimeDependencies.runOpenshell(
    ["gateway", "select", gatewayName],
    openshellRuntime.withSelectedOpenShellCommandOptions(
      {
        ignoreError: true,
        stdio: "ignore",
        timeout: openshellRuntime.OPENSHELL_OPERATION_TIMEOUT_MS,
      },
      options.runtimeSelection,
    ),
  );
  let after = await getNamedGatewayLifecycleState(gatewayName, lifecycleOptions);
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
        ...(options.output ? { output: options.output } : {}),
        ...(options.runtimeSelection ? { runtimeSelection: options.runtimeSelection } : {}),
      });
    } catch {
      // Fall through to the lifecycle re-check below so we preserve the
      // existing recovery result shape and emit the correct classification.
    }
    gatewayRuntimeDependencies.runOpenshell(
      ["gateway", "select", gatewayName],
      openshellRuntime.withSelectedOpenShellCommandOptions(
        {
          ignoreError: true,
          stdio: "ignore",
          timeout: openshellRuntime.OPENSHELL_OPERATION_TIMEOUT_MS,
        },
        options.runtimeSelection,
      ),
    );
    after = await getNamedGatewayLifecycleState(gatewayName, lifecycleOptions);
    if (after.state === "healthy_named") {
      process.env.OPENSHELL_GATEWAY = gatewayName;
      return { recovered: true, before, after, attempted: true, via: "start" };
    }
  }

  return { recovered: false, before, after, attempted: true };
}
