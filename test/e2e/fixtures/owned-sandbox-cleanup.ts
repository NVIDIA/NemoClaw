// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveSandboxGatewayName } from "../../../src/lib/onboard/gateway-binding.ts";
import { getSandbox } from "../../../src/lib/state/registry.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import type { CleanupRegistry } from "./cleanup.ts";
import { cleanupAcquiredResource } from "./cleanup-resources.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { SandboxClient } from "./clients/sandbox.ts";
import { initializeGatewayForCleanup } from "./gateway-runtime-start.ts";

function buildOwnedSandboxCleanupEnv(
  sandboxName: string,
  orphanGatewayName?: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const registered = getSandbox(sandboxName);
  return {
    ...buildAvailabilityProbeEnv(baseEnv),
    // Bind trusted administrator cleanup to the gateway NemoClaw initialized.
    // ShellProbe otherwise forwards only PATH, which hides gateway metadata.
    OPENSHELL_GATEWAY: registered
      ? resolveSandboxGatewayName(registered)
      : resolveSandboxGatewayName({
          gatewayName: orphanGatewayName ?? (baseEnv.OPENSHELL_GATEWAY?.trim() || "nemoclaw"),
        }),
  };
}

/** Prepare a sandbox name exclusively owned by this isolated qualification job. */
export async function prepareOwnedSandboxForOnboard(
  host: Pick<HostCliClient, "cleanupSandbox" | "command">,
  sandbox: Pick<SandboxClient, "hasGatewayForInitialCleanup" | "cleanupSandbox">,
  cleanup: CleanupRegistry,
  sandboxName: string,
  orphanGatewayName?: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const cleanupRegisteredSandbox = (artifactName: string) =>
    cleanupAcquiredResource(getSandbox(sandboxName) !== null, () =>
      host.cleanupSandbox(sandboxName, {
        artifactName,
        env: buildOwnedSandboxCleanupEnv(sandboxName, orphanGatewayName, baseEnv),
        timeoutMs: 15 * 60_000,
      }),
    );
  cleanup.trackDisposable(`destroy sandbox ${sandboxName}`, () =>
    cleanupRegisteredSandbox("cleanup-destroy-sandbox"),
  );
  const cleanupOwnedSandbox = async (artifactName: string) => {
    const openshellCleanupEnv = buildOwnedSandboxCleanupEnv(
      sandboxName,
      orphanGatewayName,
      baseEnv,
    );
    const options = { artifactName, env: openshellCleanupEnv, timeoutMs: 15 * 60_000 };
    const gatewayName = openshellCleanupEnv.OPENSHELL_GATEWAY!;
    const gatewayPresent = await sandbox.hasGatewayForInitialCleanup(gatewayName, options);
    if (!gatewayPresent && getSandbox(sandboxName) !== null) {
      // A retained registration needs its selected provider's recovery owner before
      // CLI reconciliation. Fresh jobs must not acquire a gateway just for cleanup.
      await initializeGatewayForCleanup(host, gatewayName, options);
      if (!(await sandbox.hasGatewayForInitialCleanup(gatewayName, options))) {
        throw new Error(`Recovered cleanup gateway ${gatewayName} is still absent`);
      }
      await sandbox.cleanupSandbox(sandboxName, options);
    } else if (gatewayPresent) {
      await sandbox.cleanupSandbox(sandboxName, options);
    }
  };
  // Orphans still receive administrator deletion before CLI reconciliation (LIFO).
  cleanup.trackDisposable(`delete owned OpenShell sandbox ${sandboxName}`, () =>
    cleanupOwnedSandbox("cleanup-delete-openshell-sandbox"),
  );
  await cleanupOwnedSandbox("precleanup-delete-openshell-sandbox");
  await cleanupRegisteredSandbox("precleanup-destroy-sandbox");
}
