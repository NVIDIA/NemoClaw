// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadServingCatalog } from "../inference/serving/catalog-loader";
import type { GooglechatTunnelRuntimeDeps } from "../messaging/channels/googlechat/hooks/tunnel-runtime";
import { type OnboardCommandOptions, runOnboardCommand } from "../onboard/command";
import { type OnboardFlags, readAgentRegistryNames } from "../onboard/command-support";
import {
  type DashboardReuseLifecycle,
  withDashboardReuseLifecycle,
} from "../onboard/dashboard/reuse-lifecycle";
import { resolveOnboardResumeIntent } from "../onboard/session-bootstrap";
import { loadOnboardCommandResumeSession } from "../onboard/sandbox-registration";
import type { OnboardOptions } from "../onboard/types";

export interface OnboardActionRuntimeDeps {
  readonly googlechatTunnelRuntime?: Omit<GooglechatTunnelRuntimeDeps, "prompt" | "sandboxName">;
  readonly dashboardReuseLifecycle?: DashboardReuseLifecycle;
}

export async function runOnboard(
  options: OnboardCommandOptions,
  runtimeDeps: OnboardActionRuntimeDeps = {},
): Promise<void> {
  // Keep the monolithic legacy onboarding graph lazy so command metadata/help
  // imports do not execute it. Resolve it only when the user invokes onboard.
  const { onboard } = (await import("../onboard")) as unknown as {
    onboard: (onboardOptions?: OnboardOptions) => Promise<void>;
  };
  const startActions = await import("./sandbox/start");
  const stopActions = await import("./sandbox/stop");
  const lifecycle = runtimeDeps.dashboardReuseLifecycle ?? {
    startSandbox: (sandboxName: string, revalidateAtMutationEdge: () => void) =>
      startActions.startSandbox(sandboxName, { revalidateAtMutationEdge }),
    stopSandbox: (sandboxName: string, revalidateAtMutationEdge: () => void) =>
      stopActions.stopSandbox(sandboxName, { revalidateAtMutationEdge }),
    withSandboxLifecycleLock: startActions.withSandboxLifecycleLock,
  };
  await withDashboardReuseLifecycle(lifecycle, () =>
    onboard({ ...options, googlechatTunnelRuntime: runtimeDeps.googlechatTunnelRuntime }),
  );
}

function buildOnboardCommandDeps(flags: OnboardFlags, runtimeDeps: OnboardActionRuntimeDeps) {
  return {
    flags,
    env: process.env,
    runOnboard: (options: OnboardCommandOptions) => runOnboard(options, runtimeDeps),
    listAgents: () => [...readAgentRegistryNames()],
    loadServingCatalog,
    loadSession: loadOnboardCommandResumeSession,
    resolveResumeIntent: resolveOnboardResumeIntent,
    log: console.log,
    error: console.error,
    exit: (code: number) => process.exit(code),
  };
}

export async function runOnboardAction(
  flags: OnboardFlags,
  runtimeDeps: OnboardActionRuntimeDeps = {},
): Promise<void> {
  await runOnboardCommand(buildOnboardCommandDeps(flags, runtimeDeps));
}
