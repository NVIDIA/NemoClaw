// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { createForwardServiceController } from "../adapters/openshell/forward-service-controller";
import {
  getActiveMessagingHostForward,
  MessagingHostStateApplier,
  type SandboxMessagingPlan,
} from "../messaging";
import { hydrateDerivedSandboxMessagingPlanFields } from "../messaging/hydration";
import type { SandboxMessagingHostForwardPlan } from "../messaging/manifest";
import { parseSandboxMessagingPlan } from "../messaging/plan-validation";
import * as registry from "../state/registry";
import { withDashboardSandboxLifecycleLockSync } from "./dashboard-port";
import {
  requireProductionForwardServiceAuthority,
  retireProductionLegacySandboxForwards,
} from "./forward-service-migration";

type GatewayBinding =
  | {
      gatewayName?: string | null;
      gatewayPort?: number | null;
    }
  | null
  | undefined;

export function resolveProductionForwardServiceGatewayName(sandbox: GatewayBinding): string {
  if (sandbox?.gatewayPort !== undefined && sandbox.gatewayPort !== null) {
    const port = sandbox.gatewayPort;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return "invalid";
    return port === 8_080 ? "nemoclaw" : `nemoclaw-${String(port)}`;
  }
  if (sandbox?.gatewayName !== undefined && sandbox.gatewayName !== null) {
    return typeof sandbox.gatewayName === "string" ? sandbox.gatewayName : "invalid";
  }
  return "nemoclaw";
}

/** Bind production dashboard forwarding without widening the onboarding entry point. */
export function productionForwardServiceRegistryContext() {
  return {
    getSandbox: registry.getSandbox,
    listSandboxes: registry.listSandboxes,
    stateDirectory: path.join(path.dirname(registry.REGISTRY_FILE), "state"),
    runExclusive: withDashboardSandboxLifecycleLockSync,
    resolveGatewayName: resolveProductionForwardServiceGatewayName,
    migrateAuthority: requireProductionForwardServiceAuthority,
    retireLegacy: retireProductionLegacySandboxForwards,
  };
}

/** Stop every registered direct service, migrating any pre-cutover row first. */
export function stopAllProductionForwardServices(deps: {
  capture(gatewayName: string): {
    error?: unknown;
    output?: string | null;
    signal?: NodeJS.Signals | null;
    status?: number | null;
  };
  isReachable(port: number): boolean;
  run(gatewayName: string, sandboxName: string, port: number): { status?: number | null };
}): void {
  const context = productionForwardServiceRegistryContext();
  const controller = createForwardServiceController({
    executable: () => {
      throw new Error("ForwardTcp cleanup cannot start a process");
    },
    stateDirectory: context.stateDirectory,
    runExclusive: context.runExclusive,
  });
  for (const sandbox of context.listSandboxes().sandboxes) {
    const migration = context.migrateAuthority(sandbox.name);
    context.retireLegacy(migration, deps);
    controller.stopAll(migration.authority);
  }
}

export function createProductionForwardServiceCleanupDeps(deps: {
  isReachable(port: number): boolean;
  runCaptureOpenshell(args: string[], options: { ignoreError: true }): string | null;
  runOpenshell(args: string[], options: { ignoreError: true }): { status?: number | null };
}) {
  return {
    capture: (gatewayName: string) => {
      const output = deps.runCaptureOpenshell(["forward", "list", "--gateway", gatewayName], {
        ignoreError: true,
      });
      return { status: output === null ? 1 : 0, output };
    },
    isReachable: deps.isReachable,
    run: (gatewayName: string, sandboxName: string, port: number) =>
      deps.runOpenshell(["forward", "stop", String(port), sandboxName, "--gateway", gatewayName], {
        ignoreError: true,
      }),
  };
}

export interface MessagingHostForwardRollbackOptions {
  readonly stopForward: (sandboxName: string, port: number) => boolean;
  readonly buildRollbackMessage: (sandboxName: string, err: unknown) => readonly string[];
  readonly cliName: () => string;
  readonly forwardPortsToStop?: readonly (number | string | null | undefined)[];
  readonly error?: (message?: string) => void;
  readonly exit?: (code: number) => never;
}

export function resolveMessagingHostForward(
  plan: SandboxMessagingPlan | null | undefined,
): SandboxMessagingHostForwardPlan | null {
  const normalizedPlan = plan ? parseSandboxMessagingPlan(plan) : null;
  if (!normalizedPlan) return null;
  const hydratedPlan = hydrateDerivedSandboxMessagingPlanFields(normalizedPlan);
  return getActiveMessagingHostForward(hydratedPlan);
}

function resolveMessagingPlanForSandbox(sandboxName: string): SandboxMessagingPlan | null {
  const envState = MessagingHostStateApplier.readPlanStateFromEnv();
  if (envState?.plan.sandboxName === sandboxName) return envState.plan;
  return registry.getSandbox(sandboxName)?.messaging?.plan ?? null;
}

export function resolveMessagingHostForwardForSandbox(
  sandboxName: string,
): SandboxMessagingHostForwardPlan | null {
  return resolveMessagingHostForward(resolveMessagingPlanForSandbox(sandboxName));
}

export function ensureMessagingHostForwardIfConfigured({
  sandboxName,
  plan,
  ensureForward,
  note,
  rollbackOnFailure,
}: {
  readonly sandboxName: string;
  readonly plan: SandboxMessagingPlan | null | undefined;
  readonly ensureForward: (sandboxName: string, port: number, label: string) => boolean;
  readonly note: (message: string) => void;
  readonly rollbackOnFailure?: MessagingHostForwardRollbackOptions;
}): boolean {
  const forward = resolveMessagingHostForward(plan);
  if (!forward) return true;

  const ok = ensureForward(sandboxName, forward.port, forward.label);
  if (ok) {
    note(`  ✓ ${forward.label} forwarded at http://127.0.0.1:${forward.port}/`);
  } else if (rollbackOnFailure) {
    abortMessagingHostForwardFailure({ sandboxName, forward, rollback: rollbackOnFailure });
  }
  return ok;
}

export function ensureMessagingHostForwardForSandbox({
  sandboxName,
  ensureForward,
  note,
  rollbackOnFailure,
}: {
  readonly sandboxName: string;
  readonly ensureForward: (sandboxName: string, port: number, label: string) => boolean;
  readonly note: (message: string) => void;
  readonly rollbackOnFailure?: MessagingHostForwardRollbackOptions;
}): boolean {
  return ensureMessagingHostForwardIfConfigured({
    sandboxName,
    plan: resolveMessagingPlanForSandbox(sandboxName),
    ensureForward,
    note,
    rollbackOnFailure,
  });
}

function abortMessagingHostForwardFailure({
  sandboxName,
  forward,
  rollback,
}: {
  readonly sandboxName: string;
  readonly forward: SandboxMessagingHostForwardPlan;
  readonly rollback: MessagingHostForwardRollbackOptions;
}): never {
  const portsToStop = new Set<string>();
  for (const port of rollback.forwardPortsToStop ?? []) {
    if (port !== null && port !== undefined && String(port).trim() !== "") {
      portsToStop.add(String(port));
    }
  }
  portsToStop.add(String(forward.port));

  for (const port of portsToStop) {
    if (!rollback.stopForward(sandboxName, Number(port))) {
      throw new Error(`ForwardTcp rollback authority is unavailable for '${sandboxName}'`);
    }
  }
  const error = new Error(
    `Failed to start ${forward.label} forward on port ${forward.port}. Free the port and ` +
      `re-run \`${rollback.cliName()} onboard\`, or choose a different messaging channel port.`,
  );
  const writeError = rollback.error ?? console.error;
  for (const line of rollback.buildRollbackMessage(sandboxName, error)) {
    writeError(line);
  }
  const exit = rollback.exit ?? process.exit;
  return exit(1);
}
