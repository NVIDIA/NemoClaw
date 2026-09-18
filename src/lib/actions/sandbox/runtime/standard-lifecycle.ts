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
  readonly persistSandboxIdentity?: (
    sandboxName: string,
    sandboxIdentityFingerprint: string,
  ) => boolean;
}

/** Standard Docker and Podman lifecycle has one OpenShell SDK owner. */
export async function mutateStandardSandboxLifecycle(
  action: "start" | "stop",
  input: RuntimeProviderLifecycleInput,
  deps: StandardSandboxLifecycleDeps = {},
): Promise<RuntimeProviderLifecycleResult | RuntimeProviderLifecycleStopOutcome> {
  const lifecycle =
    deps.openShellLifecycle ?? createSdkOpenShellSandboxStateLifecycle({ env: input.environment });
  let sandboxIdentityFingerprint = input.sandbox.lifecycleLiveIdentityFingerprint;
  if (!sandboxIdentityFingerprint) {
    const identify = lifecycle.identifySandbox;
    if (!identify || !deps.persistSandboxIdentity) {
      return {
        exitCode: 1,
        message: `  OpenShell cannot ${action} legacy sandbox '${input.sandboxName}' until its immutable identity is migrated. Run '${input.sandboxName} status' and retry.`,
      };
    }
    const identified = await identify({
      sandboxName: input.sandboxName,
      target: {
        kind: "named",
        gatewayName: input.sandbox.gatewayName ?? "nemoclaw",
      },
    });
    if (identified.kind === "failed") {
      return {
        exitCode: 1,
        message: `  OpenShell could not migrate sandbox '${input.sandboxName}' identity: ${identified.error.message}`,
      };
    }
    sandboxIdentityFingerprint = identified.sandboxIdentityFingerprint;
    if (!deps.persistSandboxIdentity(input.sandboxName, sandboxIdentityFingerprint)) {
      return {
        exitCode: 1,
        message: `  OpenShell identified legacy sandbox '${input.sandboxName}', but NemoClaw could not persist its immutable identity.`,
      };
    }
  }
  const request = {
    sandboxName: input.sandboxName,
    sandboxIdentityFingerprint,
    target: {
      kind: "named" as const,
      gatewayName: input.sandbox.gatewayName ?? "nemoclaw",
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
