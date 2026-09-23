// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createSdkOpenShellSandboxStateLifecycle,
  type OpenShellSandboxStateLifecycle,
} from "../../../adapters/openshell/sandbox-lifecycle-sdk";
import type {
  RuntimeProviderLifecycleInput,
  RuntimeProviderLifecycleResult,
  RuntimeProviderLifecycleStopOutcome,
} from "../../../onboard/runtime-provider/contract";

export interface StandardSandboxLifecycleDeps {
  readonly openShellLifecycle?: OpenShellSandboxStateLifecycle;
}

/** Standard Docker and Podman lifecycle has one OpenShell SDK owner. */
export async function mutateStandardSandboxLifecycle(
  action: "start" | "stop",
  input: RuntimeProviderLifecycleInput,
  deps: StandardSandboxLifecycleDeps = {},
): Promise<RuntimeProviderLifecycleResult | RuntimeProviderLifecycleStopOutcome> {
  const sandboxIdentityFingerprint = input.sandbox.lifecycleLiveIdentityFingerprint;
  if (!sandboxIdentityFingerprint) {
    return {
      exitCode: 1,
      message: `  OpenShell cannot ${action} legacy sandbox '${input.sandboxName}' because its registry row predates immutable lifecycle identity. NemoClaw retained the row without mutation; rebuild the sandbox to migrate it safely.`,
    };
  }
  const lifecycle =
    deps.openShellLifecycle ?? createSdkOpenShellSandboxStateLifecycle({ env: input.environment });
  const request = {
    sandboxName: input.sandboxName,
    sandboxIdentityFingerprint,
    target: {
      kind: "named" as const,
      gatewayName: input.gatewayName ?? input.sandbox.gatewayName ?? "nemoclaw",
    },
  };
  const result =
    action === "start"
      ? await lifecycle.startSandbox(request)
      : await lifecycle.stopSandbox(request);
  if (result.kind === "failed") {
    return {
      exitCode: 1,
      message: `  OpenShell could not ${action} sandbox '${input.sandboxName}': ${result.error.message}`,
    };
  }
  input.log(
    `  Sandbox '${input.sandboxName}' ${action === "start" ? "started" : "stopped"} through OpenShell.`,
  );
  return action === "stop" ? { exitCode: 0, state: "stopped" } : { exitCode: 0 };
}
