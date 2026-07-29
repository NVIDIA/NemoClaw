// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../cli/branding";
import * as registry from "../../state/registry";
import { stopSandboxChannels } from "../../tunnel/sandbox-gateway-stop";
import { teardownSandboxDashboardForward } from "./forward-recovery";
import { isDockerRuntimeDown, printDockerRuntimeDownGuidance } from "./gateway-failure-classifier";
import {
  CURRENT_SANDBOX_LIFECYCLE_RUNTIME_ADAPTERS,
  resolveSandboxLifecycleRuntimeAdapter,
  resolveSandboxLifecycleRuntimeDependencies,
  type SandboxLifecycleResult,
  type SandboxLifecycleRuntimeAdapterRegistry,
  type SandboxLifecycleRuntimeDependencies,
} from "./runtime/lifecycle-runtime";

function teardownDashboardForwardBestEffort(
  sandboxName: string,
  teardown: typeof teardownSandboxDashboardForward,
  warn: (message: string) => void,
): void {
  try {
    teardown(sandboxName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`  Warning: could not release the dashboard port-forward: ${detail}`);
  }
}

export type { SandboxLifecycleResult } from "./runtime/lifecycle-runtime";

export interface SandboxStopDeps extends Partial<SandboxLifecycleRuntimeDependencies> {
  environment?: NodeJS.ProcessEnv;
  getSandbox?: typeof registry.getSandbox;
  runtimeAdapters?: SandboxLifecycleRuntimeAdapterRegistry;
  stopSandboxChannels?: typeof stopSandboxChannels;
  teardownSandboxDashboardForward?: typeof teardownSandboxDashboardForward;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

function normalizeDriver(driver: unknown): string | null {
  return typeof driver === "string" && driver.trim() ? driver.trim().toLowerCase() : null;
}

/**
 * Refuse direct lifecycle mutation unless the persisted compute driver has an
 * exact registered adapter. A future runtime never inherits Docker or Podman
 * behavior merely because NemoClaw launches its gateway.
 */
export function gateDirectDriverLifecycle(
  sandboxName: string,
  action: "stop" | "start",
  getSandbox: typeof registry.getSandbox,
  adapters: SandboxLifecycleRuntimeAdapterRegistry = CURRENT_SANDBOX_LIFECYCLE_RUNTIME_ADAPTERS,
): SandboxLifecycleResult | null {
  const entry = getSandbox(sandboxName);
  if (!entry) {
    return {
      exitCode: 1,
      message:
        `  Sandbox '${sandboxName}' is not registered. ` +
        `Run '${CLI_NAME} list' to see registered sandboxes.`,
    };
  }
  const driver = normalizeDriver(entry.openshellDriver);
  if (!resolveSandboxLifecycleRuntimeAdapter(driver, adapters)) {
    return {
      exitCode: 1,
      message:
        `  '${CLI_NAME} ${sandboxName} ${action}' has no registered local lifecycle ` +
        `adapter for driver '${driver}'.`,
    };
  }
  return null;
}

/**
 * Fail fast with the shared #4428 outage guidance when the Docker daemon is
 * unreachable. Without this preflight an empty `docker ps` result is
 * indistinguishable from "no containers", and stop/start would misreport a
 * daemon outage as a removed container and steer the user toward `rebuild` —
 * exactly the guidance printDockerRuntimeDownGuidance exists to prevent.
 */
export function gateDockerRuntimeUp(
  sandboxName: string,
  retryCommand: "stop" | "start",
  deps: Pick<SandboxStopDeps, "isDockerRuntimeDown" | "printDockerRuntimeDownGuidance">,
): SandboxLifecycleResult | null {
  if (!(deps.isDockerRuntimeDown ?? isDockerRuntimeDown)(sandboxName)) return null;
  (deps.printDockerRuntimeDownGuidance ?? printDockerRuntimeDownGuidance)(sandboxName, {
    retryCommand,
  });
  return { exitCode: 1 };
}

/**
 * Stop a sandbox's runtime container while preserving every piece of state
 * destroy would remove: the workspace volume, registry entry, OpenShell
 * sandbox record, credentials, and images all stay in place (#6026).
 *
 * The shared host gateway, tunnel, and any inference service are
 * gateway-scoped and serve other sandboxes — deliberately untouched.
 */
export function stopSandbox(
  sandboxName: string,
  deps: SandboxStopDeps = {},
): SandboxLifecycleResult {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const sandbox = getSandbox(sandboxName);

  const gate = gateDirectDriverLifecycle(sandboxName, "stop", () => sandbox, deps.runtimeAdapters);
  if (gate) return gate;

  const adapter = resolveSandboxLifecycleRuntimeAdapter(
    sandbox?.openshellDriver,
    deps.runtimeAdapters,
  );
  if (!adapter || !sandbox) {
    return {
      exitCode: 1,
      message: `  No lifecycle runtime adapter is available for sandbox '${sandboxName}'.`,
    };
  }
  const runtimeDeps = resolveSandboxLifecycleRuntimeDependencies(deps);
  const input = {
    environment: deps.environment ?? process.env,
    log,
    sandbox,
    sandboxName,
  };
  const runtimeGate = adapter.preflight("stop", input, runtimeDeps);
  if (runtimeGate) return runtimeGate;

  let channelsStopped = false;
  const outcome = adapter.stop(input, runtimeDeps, {
    beforeStop() {
      if (channelsStopped) return;
      channelsStopped = true;
      // Graceful in-sandbox gateway shutdown first, so channels disconnect
      // cleanly instead of dying with the container's SIGTERM. Best-effort:
      // a stop must still free resources when the gateway is unreachable.
      // Agent-managed gateways (e.g. Hermes) are supervised inside the sandbox
      // and shut down with the container's stop signal instead.
      try {
        (deps.stopSandboxChannels ?? stopSandboxChannels)(sandboxName, {
          allowDockerGatewayExec: adapter.channelStopTransport === "docker-kubectl-first",
          info: (message) => log(`  ${message}`),
          warn: (message) => warn(`  ${message}`),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warn(`  Warning: could not stop in-sandbox channels gracefully: ${detail}`);
      }
    },
  });
  if (outcome.exitCode !== 0) return outcome;

  if (outcome.state === "already-stopped") {
    log(`  Sandbox '${sandboxName}' is already stopped.`);
    // Idempotent teardown: an earlier stop may have left the dashboard forward
    // alive (e.g. openshell was unreachable then, or the forward was orphaned by
    // a raw `docker stop`). Release it here too so a repeated stop always
    // converges on no leftover listener (#7227).
    teardownDashboardForwardBestEffort(
      sandboxName,
      deps.teardownSandboxDashboardForward ?? teardownSandboxDashboardForward,
      warn,
    );
    log(`  Start it again with '${CLI_NAME} ${sandboxName} start'.`);
    return { exitCode: 0 };
  }

  // Release the host-side dashboard port-forward this sandbox created. Without
  // this, the `ssh -L` listener stays alive after the container is stopped, so
  // `status` misreports the cleanly-stopped sandbox as a foreign
  // `sandbox_dashboard_port_conflict` and `start`/`recover` contend with the
  // still-held port (#7227). Best-effort — the container is already stopped.
  teardownDashboardForwardBestEffort(
    sandboxName,
    deps.teardownSandboxDashboardForward ?? teardownSandboxDashboardForward,
    warn,
  );

  log(`  Sandbox '${sandboxName}' stopped. Workspace state is preserved.`);
  log(`  Start it again with '${CLI_NAME} ${sandboxName} start'.`);
  return { exitCode: 0 };
}
