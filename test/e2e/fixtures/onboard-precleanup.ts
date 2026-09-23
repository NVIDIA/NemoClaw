// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertCleanupSucceededOrAbsent } from "./cleanup-resources.ts";
import type { CleanupRegistry } from "./cleanup.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { SandboxClient } from "./clients/sandbox.ts";
import { prepareOwnedSandboxForOnboard } from "./owned-sandbox-cleanup.ts";
import type { ShellProbeRunOptions } from "./shell-probe.ts";

/** Clear this scenario's owned resources without acquiring a gateway on a fresh runner. */
export async function prepareOnboardSandboxes(
  host: Pick<HostCliClient, "cleanupSandbox" | "command" | "cleanupForward">,
  sandbox: Pick<SandboxClient, "hasGatewayForInitialCleanup" | "cleanupSandbox" | "openshell">,
  cleanup: CleanupRegistry,
  sandboxNames: readonly string[],
  providerName: string,
  options: ShellProbeRunOptions,
): Promise<void> {
  const gatewayName = options.env?.OPENSHELL_GATEWAY;
  if (!gatewayName?.trim()) throw new Error("Onboard cleanup requires a named gateway");
  for (const name of sandboxNames) {
    await prepareOwnedSandboxForOnboard(host, sandbox, cleanup, name);
  }
  if (!(await sandbox.hasGatewayForInitialCleanup(gatewayName, options))) return;
  await host.cleanupForward(18789, {
    ...options,
    artifactName: "precleanup-forward-stop-18789",
  });
  const remove = await sandbox.openshell(["provider", "delete", "-g", gatewayName, providerName], {
    ...options,
    artifactName: "precleanup-live-extra-provider-delete",
  });
  assertCleanupSucceededOrAbsent(
    remove,
    /\bNotFound\b|provider[^\n]*(?:not found|does not exist)|no such provider/i,
    `cleanup provider ${providerName}`,
  );
}
