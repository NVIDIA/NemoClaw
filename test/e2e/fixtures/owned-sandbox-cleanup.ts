// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox } from "../../../src/lib/state/registry.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import type { CleanupRegistry } from "./cleanup.ts";
import { cleanupAcquiredResource } from "./cleanup-resources.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { SandboxClient } from "./clients/sandbox.ts";

function buildOwnedSandboxCleanupEnv(): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    // Bind trusted administrator cleanup to the gateway NemoClaw initialized.
    // ShellProbe otherwise forwards only PATH, which hides gateway metadata.
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY?.trim() || "nemoclaw",
  };
}

/** Prepare a sandbox name exclusively owned by this isolated qualification job. */
export async function prepareOwnedSandboxForOnboard(
  host: Pick<HostCliClient, "cleanupSandbox">,
  sandbox: Pick<SandboxClient, "cleanupSandboxBeforeOnboard">,
  cleanup: CleanupRegistry,
  sandboxName: string,
): Promise<void> {
  const openshellCleanupEnv = buildOwnedSandboxCleanupEnv();
  const cleanupRegisteredSandbox = (artifactName: string) =>
    cleanupAcquiredResource(getSandbox(sandboxName) !== null, () =>
      host.cleanupSandbox(sandboxName, {
        artifactName,
        env: openshellCleanupEnv,
        timeoutMs: 15 * 60_000,
      }),
    );
  cleanup.trackDisposable(`destroy sandbox ${sandboxName}`, () =>
    cleanupRegisteredSandbox("cleanup-destroy-sandbox"),
  );
  // An orphan can exist without a NemoClaw registry entry. Keep administrator
  // deletion first in LIFO cleanup, but never start a gateway just to clean up.
  cleanup.trackDisposable(`delete owned OpenShell sandbox ${sandboxName}`, () =>
    sandbox.cleanupSandboxBeforeOnboard(sandboxName, {
      artifactName: "cleanup-delete-openshell-sandbox",
      env: openshellCleanupEnv,
      timeoutMs: 15 * 60_000,
    }),
  );
  await sandbox.cleanupSandboxBeforeOnboard(sandboxName, {
    artifactName: "precleanup-delete-openshell-sandbox",
    env: openshellCleanupEnv,
    timeoutMs: 15 * 60_000,
  });
  await cleanupRegisteredSandbox("precleanup-destroy-sandbox");
}
