// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MANAGED_IMAGE_AGENTS } from "../../../src/lib/onboard/managed-image/agents.ts";
import { managedStartupStateRootOwnership } from "../../../src/lib/onboard/managed-startup/state-roots.ts";
import { resolveSandboxGatewayName } from "../../../src/lib/onboard/gateway-binding.ts";
import { getSandbox } from "../../../src/lib/state/registry.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import type { CleanupRegistry } from "./cleanup.ts";
import { cleanupAcquiredResource } from "./cleanup-resources.ts";
import type { HostCliClient } from "./clients/host.ts";
import { type SandboxClient, validateSandboxName } from "./clients/sandbox.ts";
import type { RuntimeProviderPrerequisite } from "./runtime-provider.ts";
import type { ShellProbeRunOptions } from "./shell-probe.ts";
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

/** Avoid named CLI recovery when this job has no recorded sandbox to destroy. */
export function cleanupRegisteredSandbox(
  sandboxName: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  return cleanupAcquiredResource(getSandbox(sandboxName) !== null, cleanup);
}

/** Verify absence after onboarding released its gateway before creating a sandbox. */
export async function cleanupOwnedSandboxAfterOnboard(
  sandbox: Pick<SandboxClient, "hasGatewayForInitialCleanup" | "cleanupSandbox">,
  runtimeProvider: Pick<RuntimeProviderPrerequisite, "command">,
  sandboxName: string,
  options: ShellProbeRunOptions,
): Promise<void> {
  validateSandboxName(sandboxName);
  const gatewayName = resolveSandboxGatewayName({
    gatewayName: options.env?.OPENSHELL_GATEWAY?.trim() || "nemoclaw",
  });
  const scopedOptions = {
    ...options,
    env: { ...options.env, OPENSHELL_GATEWAY: gatewayName },
  };
  if (await sandbox.hasGatewayForInitialCleanup(gatewayName, scopedOptions)) {
    await sandbox.cleanupSandbox(sandboxName, scopedOptions);
    return;
  }
  if (getSandbox(sandboxName) !== null) {
    throw new Error(
      `Cannot verify cleanup of registered sandbox '${sandboxName}' without its gateway.`,
    );
  }
  // Include stopped workloads and supervisors; state volumes can outlive a failed create.
  const requests = [
    {
      kind: "containers",
      args: [
        "container",
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=openshell.ai/sandbox-name=${sandboxName}`,
        "--format",
        "{{.ID}}",
      ],
    },
    ...MANAGED_IMAGE_AGENTS.flatMap((agent) =>
      managedStartupStateRootOwnership({ agent, sandboxName }).map((root) => ({
        kind: root.resourceIdentity,
        args: [
          "volume",
          "ls",
          "--filter",
          `name=${root.resourceIdentity}`,
          "--format",
          "{{.Name}}",
        ],
      })),
    ),
  ];
  const inventories = await Promise.all(
    requests.map(({ kind, args }) =>
      runtimeProvider.command(args, {
        ...scopedOptions,
        artifactName: `cleanup-${sandboxName}-${kind}`,
        captureLimitBytes: 4096,
        timeoutMs: Math.min(options.timeoutMs ?? 30_000, 30_000),
      }),
    ),
  );
  if (
    inventories.some(
      (inventory) =>
        inventory.exitCode !== 0 ||
        inventory.signal !== null ||
        inventory.timedOut ||
        inventory.stdout !== "" ||
        inventory.stderr !== "",
    ) ||
    getSandbox(sandboxName) !== null
  ) {
    throw new Error(
      `Cannot verify runtime absence for sandbox '${sandboxName}' after its gateway was removed.`,
    );
  }
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
  const cleanupRegistered = (artifactName: string) =>
    cleanupRegisteredSandbox(sandboxName, () =>
      host.cleanupSandbox(sandboxName, {
        artifactName,
        env: buildOwnedSandboxCleanupEnv(sandboxName, orphanGatewayName, baseEnv),
        timeoutMs: 15 * 60_000,
      }),
    );
  cleanup.trackDisposable(`destroy sandbox ${sandboxName}`, () =>
    cleanupRegistered("cleanup-destroy-sandbox"),
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
  await cleanupRegistered("precleanup-destroy-sandbox");
}
