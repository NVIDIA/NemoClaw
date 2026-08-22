// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GATEWAY_PORT } from "../core/ports";
import { listSandboxes as listRegisteredSandboxes } from "../state/registry";
import { releaseManagedGatewayPort } from "../tunnel/gateway-port-release";
import { resolveGatewayName, resolveSandboxGatewayName } from "./gateway-binding";
import { isExternallySupervised } from "./gateway-ownership";
import {
  GatewayAuthorityError,
  resolveGatewayTeardownAuthority,
} from "./gateway-teardown-authority";

export type RunOpenshell = (
  args: string[],
  opts: { ignoreError: true },
) => { status: number | null };

export type RemoveVolumesByPrefix = (prefix: string, opts: { ignoreError: true }) => unknown;

export type DestroyGatewayDeps = {
  clearRegistry: () => void;
  dockerRemoveVolumesByPrefix: RemoveVolumesByPrefix;
  gatewayName: string;
  hasLifecycleCommands: () => boolean;
  isDockerDriverGatewayEnabled: () => boolean;
  removeDockerDriverGatewayRegistration: () => boolean;
  runOpenshell: RunOpenshell;
  stopDockerDriverGatewayProcess: () => void;
};

/**
 * Abort cleanup runs after the OpenShell gateway starts and before NemoClaw
 * registers a sandbox. The Docker-driver gateway inherits provider credentials
 * from onboarding, so an unowned listener must not survive a failed run.
 */
export type AbortGatewayTeardownDeps = {
  env?: NodeJS.ProcessEnv;
  gatewayPort?: number;
  gatewayName?: string;
  listSandboxes?: typeof listRegisteredSandboxes;
  resolveAuthority?: typeof resolveGatewayTeardownAuthority;
  releaseManagedGatewayPort?: typeof releaseManagedGatewayPort;
  removeGatewayRegistration?: (gatewayName: string) => boolean;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

function defaultRemoveGatewayRegistration(gatewayName: string): boolean {
  // Lazy require keeps unit tests free of openshell binary resolution.
  const runtime =
    require("../adapters/openshell/runtime") as typeof import("../adapters/openshell/runtime");
  return (
    runtime.runOpenshell(["gateway", "remove", gatewayName], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).status === 0
  );
}

/**
 * True when a registered sandbox is bound to `gatewayName`, false when none
 * are bound, and null when a binding cannot be resolved.
 */
export function gatewayHasRegisteredSandbox(
  gatewayName: string,
  listSandboxes: typeof listRegisteredSandboxes = listRegisteredSandboxes,
): boolean | null {
  for (const sandbox of listSandboxes().sandboxes) {
    try {
      if (resolveSandboxGatewayName(sandbox) === gatewayName) return true;
    } catch {
      return null;
    }
  }
  return false;
}

/**
 * Best-effort: stop the managed host gateway listener and remove its OpenShell
 * registration when no sandbox still owns that gateway. Never throws — callers
 * on fatal exit paths must still be able to `process.exit(1)` after a warning.
 *
 * @returns true when teardown completed or no teardown was required.
 */
export function teardownOrphanManagedGatewayOnAbort(deps: AbortGatewayTeardownDeps = {}): boolean {
  const log = deps.log ?? ((message: string) => console.error(message));
  const warn = deps.warn ?? ((message: string) => console.error(message));

  try {
    const env = deps.env ?? process.env;
    const port = deps.gatewayPort ?? GATEWAY_PORT;
    const gatewayName = deps.gatewayName ?? resolveGatewayName(port);
    const listSandboxes = deps.listSandboxes ?? listRegisteredSandboxes;
    const resolveAuthority = deps.resolveAuthority ?? resolveGatewayTeardownAuthority;
    const release = deps.releaseManagedGatewayPort ?? releaseManagedGatewayPort;
    const removeRegistration = deps.removeGatewayRegistration ?? defaultRemoveGatewayRegistration;

    const hasRegisteredSandbox = gatewayHasRegisteredSandbox(gatewayName, listSandboxes);
    if (hasRegisteredSandbox === null) {
      warn(
        "  Skipping gateway teardown after onboard abort: sandbox gateway binding is unreadable.",
      );
      return false;
    }
    if (hasRegisteredSandbox) {
      return true;
    }

    try {
      const owner = resolveAuthority({ gatewayName, gatewayPort: port }, { env });
      if (isExternallySupervised(owner)) {
        log(
          `  Keeping externally supervised OpenShell gateway '${gatewayName}' running after onboard abort.`,
        );
        return true;
      }
    } catch (error) {
      if (error instanceof GatewayAuthorityError) {
        warn(`  Skipping gateway teardown after onboard abort: ${error.message}`);
        return false;
      }
      warn(
        `  Skipping gateway teardown after onboard abort: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    log(
      `  Onboard aborted before a sandbox was created; releasing managed gateway '${gatewayName}' so provider credentials do not remain in a live process.`,
    );

    let releaseConfirmed = false;
    try {
      const result = release({ port });
      releaseConfirmed = result.released;
      if (result.released && result.stopped.length > 0) {
        log(
          `  Released gateway port ${String(result.port)} (stopped host process ${result.stopped.join(", ")}).`,
        );
      } else if (!result.released && !result.skipped) {
        warn(
          `  Gateway port ${String(result.port ?? port)} was not confirmed released after onboard abort. Inspect the listener and stop only the matching openshell-gateway process.`,
        );
      }
    } catch (error) {
      warn(
        `  Gateway process stop after onboard abort failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Keep the OpenShell registration when the listener may still be up — it is
    // the supported recovery handle for a credential-bearing process.
    if (!releaseConfirmed) return false;

    try {
      if (!removeRegistration(gatewayName)) {
        warn(
          `  Gateway registration '${gatewayName}' was not confirmed removed after onboard abort.`,
        );
        return false;
      }
    } catch (error) {
      warn(
        `  Gateway registration remove after onboard abort failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    return true;
  } catch (error) {
    // Warn and continue to fatal exit; do not hide a still-live listener.
    warn(
      `  Gateway teardown after onboard abort failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

export function destroyGatewayWithVolumeCleanup({
  clearRegistry,
  dockerRemoveVolumesByPrefix,
  gatewayName,
  hasLifecycleCommands,
  isDockerDriverGatewayEnabled,
  removeDockerDriverGatewayRegistration,
  runOpenshell,
  stopDockerDriverGatewayProcess,
}: DestroyGatewayDeps): boolean {
  const dockerDriver = isDockerDriverGatewayEnabled();
  if (dockerDriver) {
    stopDockerDriverGatewayProcess();
  }

  const lifecycleCommands = hasLifecycleCommands();
  const gatewayRemoved = dockerDriver
    ? removeDockerDriverGatewayRegistration()
    : (() => {
        const removeResult = runOpenshell(["gateway", "remove", gatewayName], {
          ignoreError: true,
        });
        if (removeResult.status === 0) return true;
        // Pre-0.0.44 builds exposed `gateway destroy` instead of `gateway remove`.
        if (!lifecycleCommands) return false;
        return (
          runOpenshell(["gateway", "destroy", "-g", gatewayName], { ignoreError: true }).status ===
          0
        );
      })();

  if (gatewayRemoved) {
    clearRegistry();
  }

  if (gatewayRemoved && (dockerDriver || lifecycleCommands)) {
    dockerRemoveVolumesByPrefix(`openshell-cluster-${gatewayName}`, { ignoreError: true });
  }

  return gatewayRemoved;
}
