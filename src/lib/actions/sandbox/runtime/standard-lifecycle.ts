// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createSdkOpenShellSandboxStateLifecycle,
  type OpenShellSandboxStateLifecycle,
} from "../../../adapters/openshell/sandbox-lifecycle-sdk";
import { cliName } from "../../../onboard/branding";
import { normalizeRuntimeProviderIdentity } from "../../../onboard/runtime-provider/access";
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
    const messages = [
      `  OpenShell could not ${action} sandbox '${input.sandboxName}': ${result.error.message}`,
    ];
    if (
      result.error.kind === "timeout" ||
      (result.error.kind === "transport" && result.error.reason === "unreachable")
    ) {
      // A transport failure can occur after submission; never infer removal or retry a mutation.
      messages.push(
        "  Sandbox state is unverified; this failure does not prove the sandbox was removed.",
        "  Preserve the sandbox; do not rebuild, destroy, or re-onboard it to resolve a connection failure.",
      );
      if (normalizeRuntimeProviderIdentity(input.sandbox.openshellDriver) === "docker") {
        messages.push(
          "  Run `docker info` on the owning gateway's host to inspect daemon, permission, context, or TLS errors.",
        );
      }
      messages.push(
        `  Restore access to OpenShell gateway '${request.target.gatewayName}'.`,
        `  Then run \`${cliName()} ${input.sandboxName} status\` before retrying.`,
      );
    }
    return { exitCode: 1, message: messages.join("\n") };
  }
  input.log(
    `  Sandbox '${input.sandboxName}' ${action === "start" ? "started" : "stopped"} through OpenShell.`,
  );
  return action === "stop" ? { exitCode: 0, state: "stopped" } : { exitCode: 0 };
}
