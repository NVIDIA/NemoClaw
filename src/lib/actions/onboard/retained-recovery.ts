// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import type { OpenShellSandboxPresence } from "../../adapters/openshell/sandbox-presence";
import { isDeferredN1xManagedVllmAcceptanceRoute } from "../../domain/sandbox/n1x-managed-vllm-rebuild";
import {
  observeNamedGatewaySandboxPresence,
  recoverNamedGatewayRuntime,
  replaceOpenShellRuntimeSelectionEnv,
  snapshotOpenShellEnv,
  resolveGatewayName,
} from "../../gateway-runtime-action";
import type { OnboardCommandOptions } from "../../onboard/command";
import { RESERVED_SANDBOX_NAMES } from "../../onboard/sandbox-agent";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock-acquisition";
import type { RetainedSandboxRecoveryRecord } from "../../state/onboard-session/retained-sandbox-recovery";
import type { SandboxEntry } from "../../state/registry/types";
import { destroySandbox } from "../../actions/sandbox/destroy";

type RecoveryOptions = Pick<
  OnboardCommandOptions,
  "sandboxName" | "resume" | "agent" | "experimentalProfile" | "apfInterceptorRequested"
>;

export interface RetainedOnboardRecoveryDeps {
  readonly gatewayPort: number;
  readonly env: NodeJS.ProcessEnv;
  validateName(name: string, kind: string): string;
  loadSession(): { sandboxName?: string | null } | null;
  listRecords(): readonly RetainedSandboxRecoveryRecord[];
  getSandbox(name: string): SandboxEntry | null;
  withLock(name: string, operation: () => Promise<string | null>): Promise<string | null>;
  recoverGateway(record: RetainedSandboxRecoveryRecord): Promise<boolean>;
  observeSandbox(record: RetainedSandboxRecoveryRecord): OpenShellSandboxPresence;
  confirm(name: string): Promise<boolean>;
  destroy(name: string): Promise<void>;
}

type RecoveryHostDeps = Pick<
  RetainedOnboardRecoveryDeps,
  "gatewayPort" | "loadSession" | "listRecords" | "getSandbox" | "validateName"
> & { prompt(question: string): Promise<string> };

export function createRetainedOnboardRecovery(host: RecoveryHostDeps) {
  const deps: RetainedOnboardRecoveryDeps = {
    ...host,
    env: process.env,
    withLock: (name, operation) =>
      withMcpLifecycleLock(name, async () => {
        const restore = snapshotOpenShellEnv();
        replaceOpenShellRuntimeSelectionEnv(process.env, {
          gatewayName: resolveGatewayName(host.gatewayPort),
          workspace: "default",
        });
        try {
          return await operation();
        } finally {
          restore();
        }
      }),
    recoverGateway: async (record) =>
      (
        await recoverNamedGatewayRuntime({
          gatewayName: record.gatewayName,
          ignoreProbeErrors: true,
        })
      ).recovered,
    observeSandbox: (record) =>
      observeNamedGatewaySandboxPresence(record.sandboxName, record.gatewayName),
    confirm: async (name) => {
      if (!process.stdin.isTTY) return false;
      const answer = await host.prompt(
        `  Sandbox '${name}' is absent after an earlier failed setup. Remove its verified leftovers and retry this name? [y/N]: `,
      );
      return /^(?:y|yes)$/iu.test(answer.trim());
    },
    destroy: (name) => destroySandbox(name, { yes: true, cleanupGateway: false }),
  };
  return (options: RecoveryOptions) => reconcileRetainedN1xOnboard(options, deps);
}

/** Reconcile an absent failed N1x attempt before normal same-name admission. */
export async function reconcileRetainedN1xOnboard(
  options: RecoveryOptions,
  deps: RetainedOnboardRecoveryDeps,
): Promise<string | null> {
  if (
    options.resume ||
    options.experimentalProfile ||
    options.apfInterceptorRequested ||
    (options.agent || deps.env.NEMOCLAW_AGENT?.trim() || "openclaw") !== "openclaw" ||
    (deps.env.OPENSHELL_WORKSPACE && deps.env.OPENSHELL_WORKSPACE !== "default")
  ) {
    return null;
  }
  const name = deps.validateName(
    options.sandboxName ||
      deps.env.NEMOCLAW_SANDBOX_NAME?.trim() ||
      deps.loadSession()?.sandboxName ||
      "my-assistant",
    "sandbox name",
  );
  if (RESERVED_SANDBOX_NAMES.has(name)) return null;
  const matching = deps.listRecords().filter((record) => record.sandboxName === name);
  if (matching.length !== 1) return null;
  const record = matching[0];
  const entry = deps.getSandbox(name);
  if (
    record.reason !== "retained_after_sandbox_creation_failure" ||
    record.gatewayPort !== deps.gatewayPort ||
    record.gatewayName !== resolveGatewayName(deps.gatewayPort) ||
    !entry?.pendingRouteReservation ||
    !isDeferredN1xManagedVllmAcceptanceRoute({
      ...entry,
      openshellDriver: entry.openshellDriver ?? "docker",
    }) ||
    (entry.agent != null && entry.agent !== "openclaw") ||
    entry.gatewayName !== record.gatewayName ||
    entry.gatewayPort !== record.gatewayPort
  ) {
    return null;
  }
  return deps.withLock(name, async () => {
    const assertCurrent = () => {
      const current = deps.listRecords().filter((candidate) => candidate.sandboxName === name);
      if (
        !isDeepStrictEqual(current, [record]) ||
        !isDeepStrictEqual(deps.getSandbox(name), entry)
      ) {
        throw new Error(`Recovery authority for sandbox '${name}' changed; retry stopped.`);
      }
    };
    assertCurrent();
    if (!(await deps.recoverGateway(record))) {
      throw new Error(`Could not restore gateway '${record.gatewayName}'; recovery was preserved.`);
    }
    assertCurrent();
    if (deps.observeSandbox(record) !== "absent") return null;
    if (!(await deps.confirm(name))) {
      throw new Error(
        `Recovery for '${name}' was preserved. Run 'nemoclaw ${name} destroy --yes' to authorize cleanup, then retry onboarding.`,
      );
    }
    assertCurrent();
    await deps.destroy(name);
    if (
      deps.listRecords().some((candidate) => candidate.sandboxName === name) ||
      deps.getSandbox(name)
    ) {
      throw new Error(`Cleanup for sandbox '${name}' was not confirmed; retry stopped.`);
    }
    return name;
  });
}
