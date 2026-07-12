// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture } from "../../adapters/docker";
import * as agentRuntime from "../../agent/runtime";
import { shouldManageDashboardForAgent } from "../../onboard/dashboard-runtime";
import {
  type DockerContainerInspect,
  parseDockerInspectJson,
} from "../../onboard/docker-gpu-patch";
import {
  type DockerGpuPatchFinalizeOutcome,
  finalizeDockerGpuPatchBackup,
} from "../../onboard/docker-gpu-patch-finalize";
import { recreateOpenShellDockerSandboxWithStartupCommand } from "../../onboard/docker-startup-command-patch";
import { buildSandboxRuntimeEnvArgs } from "../../onboard/sandbox-create-launch";
import { resolveDirectSandboxContainer } from "../../sandbox/privileged-exec";
import { redact, redactFull } from "../../security/redact";
import * as registry from "../../state/registry";
import { resolveSandboxDashboardPort } from "./forward-recovery";

/**
 * Compatibility boundary for OpenShell 0.0.71's Docker driver: legacy
 * sandboxes persist `OPENSHELL_SANDBOX_COMMAND=sleep infinity` while
 * `scripts/nemoclaw-start.sh` owns the managed workload as a sibling process.
 * Only that inspected value authorizes this migration. Regression coverage is
 * named in `supervisor-relaunch.test.ts` and `gateway-guard-recovery.test.ts`.
 * Remove this path after supported upgrades rebuild every legacy keepalive
 * container with `nemoclaw-start` as its persisted startup command.
 */
const LEGACY_OPENSHELL_KEEPALIVE = "sleep infinity";
const DOCKER_INSPECT_TIMEOUT_MS = 15000;

export type ManagedSupervisorRelaunch = {
  containerId: string;
  finalize(supervisorReady: boolean): DockerGpuPatchFinalizeOutcome;
};

export type ManagedSupervisorRelaunchDeps = {
  getSandbox?: typeof registry.getSandbox;
  getSessionAgent?: typeof agentRuntime.getSessionAgent;
  resolveDashboardPort?: typeof resolveSandboxDashboardPort;
  resolveContainer?: typeof resolveDirectSandboxContainer;
  inspectContainer?: (containerId: string) => DockerContainerInspect;
  confirmMissingSupervisor?: (containerId: string) => boolean;
  recreate?: typeof recreateOpenShellDockerSandboxWithStartupCommand;
  finalize?: typeof finalizeDockerGpuPatchBackup;
};

function inspectContainer(containerId: string): DockerContainerInspect {
  return parseDockerInspectJson(
    dockerCapture(["inspect", "--type", "container", containerId], {
      ignoreError: true,
      timeout: DOCKER_INSPECT_TIMEOUT_MS,
    }),
  );
}

function hasLegacyKeepaliveStartup(inspect: DockerContainerInspect): boolean {
  const prefix = "OPENSHELL_SANDBOX_COMMAND=";
  const values = (inspect.Config?.Env ?? [])
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length));
  return values.length === 1 && values[0] === LEGACY_OPENSHELL_KEEPALIVE;
}

function reconstructSupervisorLaunchCommand(
  sandboxName: string,
  entry: NonNullable<ReturnType<typeof registry.getSandbox>>,
  deps: ManagedSupervisorRelaunchDeps,
): string[] | null {
  const getSessionAgent = deps.getSessionAgent ?? agentRuntime.getSessionAgent;
  const agent = getSessionAgent(sandboxName) ?? null;
  const persistedAgent = entry.agent ?? "openclaw";
  if (!["openclaw", "hermes"].includes(persistedAgent)) return null;
  if (persistedAgent === "hermes" && agent?.name !== "hermes") return null;
  if (agent && agent.name !== "openclaw" && agent.name !== "hermes") return null;

  const manageDashboard = shouldManageDashboardForAgent(agent);
  const resolveDashboardPort = deps.resolveDashboardPort ?? resolveSandboxDashboardPort;
  const dashboardPort = String(resolveDashboardPort(sandboxName));
  const chatUiUrl = manageDashboard ? `http://127.0.0.1:${dashboardPort}` : "";
  const hermesDashboardEnabled = entry.hermesDashboardEnabled === true;
  const { envArgs } = buildSandboxRuntimeEnvArgs({
    agent,
    chatUiUrl,
    manageDashboard,
    getDashboardForwardPort: () => dashboardPort,
    hermesDashboardState: {
      enabled: hermesDashboardEnabled,
      config: hermesDashboardEnabled
        ? {
            enabled: true,
            port: entry.hermesDashboardPort ?? 0,
            internalPort: entry.hermesDashboardInternalPort ?? 0,
            tuiEnabled: entry.hermesDashboardTui === true,
          }
        : null,
    },
    extraPlaceholderKeys: [],
    observabilityEnabled: entry.observabilityEnabled === true,
    sandboxName,
    env: process.env,
    omitCredentialEnv: true,
  });
  return ["env", ...envArgs, "nemoclaw-start"];
}

export function relaunchManagedSupervisorSession(
  sandboxName: string,
  {
    quiet,
    deps = {},
  }: {
    quiet: boolean;
    deps?: ManagedSupervisorRelaunchDeps;
  },
): ManagedSupervisorRelaunch | null {
  if (process.env.NEMOCLAW_DISABLE_SUPERVISOR_RELAUNCH === "1") return null;
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const entry = getSandbox(sandboxName);
  if (!entry) return null;
  const driver = entry.openshellDriver?.trim().toLowerCase() ?? null;
  if (driver !== null && driver !== "docker" && driver !== "vm") return null;
  const startupCommand = reconstructSupervisorLaunchCommand(sandboxName, entry, deps);
  if (startupCommand === null) return null;

  const resolveContainer = deps.resolveContainer ?? resolveDirectSandboxContainer;
  const inspect = deps.inspectContainer ?? inspectContainer;
  const confirmMissingSupervisor = deps.confirmMissingSupervisor;
  const recreate = deps.recreate ?? recreateOpenShellDockerSandboxWithStartupCommand;
  const finalize = deps.finalize ?? finalizeDockerGpuPatchBackup;
  try {
    const containerId = resolveContainer(sandboxName, driver);
    if (!hasLegacyKeepaliveStartup(inspect(containerId))) return null;
    if (!confirmMissingSupervisor?.(containerId)) return null;
    if (!quiet) {
      console.log("  Recreating the sandbox container with its managed startup command...");
    }
    const result = recreate({
      sandboxName,
      openshellSandboxCommand: startupCommand,
      expectedOldContainerId: containerId,
      waitForSupervisor: false,
    });
    let completed: { supervisorReady: boolean; outcome: DockerGpuPatchFinalizeOutcome } | null =
      null;
    return {
      containerId: result.newContainerId,
      finalize(supervisorReady) {
        if (completed) {
          if (completed.supervisorReady !== supervisorReady) {
            throw new Error(
              "Supervisor relaunch transaction was finalized with conflicting state.",
            );
          }
          return completed.outcome;
        }
        const outcome = finalize({ result, supervisorReady });
        completed = { supervisorReady, outcome };
        return outcome;
      },
    };
  } catch (error) {
    if (!quiet) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`  Trusted container recovery could not start: ${redactFull(redact(detail))}`);
    }
    return null;
  }
}
