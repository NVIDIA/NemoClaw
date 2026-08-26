// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture } from "../../adapters/docker";
import * as agentRuntime from "../../agent/runtime";
import { shouldManageDashboardForAgent } from "../../onboard/dashboard-runtime";
import {
  type DockerContainerInspect,
  parseDockerInspectJson,
} from "../../onboard/docker-gpu-patch";
import { sameContainerId } from "../../onboard/docker-gpu-patch-clone";
import {
  type DockerGpuPatchFinalizeOutcome,
  finalizeDockerGpuPatchBackup,
} from "../../onboard/docker-gpu-patch-finalize";
import { getDockerGpuSupervisorReconnectTimeoutSecs } from "../../onboard/docker-gpu-supervisor-reconnect";
import { recreateOpenShellDockerSandboxWithStartupCommand } from "../../onboard/docker-startup-command-patch";
import { buildSandboxRuntimeEnvArgs } from "../../onboard/sandbox-create-launch";
import { resolveDirectSandboxContainer } from "../../sandbox/privileged-exec";
import { redact, redactFull } from "../../security/redact";
import * as registry from "../../state/registry";
import * as sandboxState from "../../state/sandbox";
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
const STATE_BACKUP_MAX_RETRIES = 5;
const STATE_BACKUP_RETRY_SECONDS = 2;

export type ManagedSupervisorRelaunch = {
  containerId: string;
  finalize(supervisorReady: boolean): DockerGpuPatchFinalizeOutcome & {
    stateRestored?: boolean;
    stateBackupRemoved?: boolean;
  };
};

export type ManagedSupervisorRelaunchDeps = {
  getSandbox?: typeof registry.getSandbox;
  getSessionAgent?: typeof agentRuntime.getSessionAgent;
  resolveDashboardPort?: typeof resolveSandboxDashboardPort;
  resolveContainer?: typeof resolveDirectSandboxContainer;
  inspectContainer?: (containerId: string) => DockerContainerInspect;
  confirmMissingSupervisor?: (containerId: string) => boolean;
  restartRestoredManagedGateway?: (containerId: string) => boolean;
  backupState?: typeof sandboxState.backupSandboxState;
  sleep?: (seconds: number) => void;
  restoreState?: typeof sandboxState.restoreSandboxState;
  removeBackup?: typeof sandboxState.removeSandboxStateBackup;
  recreate?: typeof recreateOpenShellDockerSandboxWithStartupCommand;
  finalize?: typeof finalizeDockerGpuPatchBackup;
  runOpenshell?: NonNullable<Parameters<typeof finalizeDockerGpuPatchBackup>[1]>["runOpenshell"];
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
  const restartRestoredManagedGateway = deps.restartRestoredManagedGateway;
  const backupState = deps.backupState ?? sandboxState.backupSandboxState;
  const restoreState = deps.restoreState ?? sandboxState.restoreSandboxState;
  const removeBackup = deps.removeBackup ?? sandboxState.removeSandboxStateBackup;
  const recreate = deps.recreate ?? recreateOpenShellDockerSandboxWithStartupCommand;
  const finalize = deps.finalize ?? finalizeDockerGpuPatchBackup;
  let pendingStateBackupPath: string | null = null;
  try {
    const containerId = resolveContainer(sandboxName, driver);
    const sleep =
      deps.sleep ??
      ((seconds: number) => {
        dockerCapture(["exec", containerId, "sleep", String(seconds)], {
          ignoreError: true,
          timeout: (seconds + 5) * 1000,
        });
      });
    if (!hasLegacyKeepaliveStartup(inspect(containerId))) return null;
    if (!confirmMissingSupervisor?.(containerId)) return null;
    let backup = backupState(sandboxName);
    // Docker can restore the OpenShell exec relay before its SSH transport.
    // Retry only that typed transport lag; integrity and audit failures remain terminal.
    for (
      let retry = 0;
      retry < STATE_BACKUP_MAX_RETRIES && !backup.success && backup.unreachable === true;
      retry += 1
    ) {
      if (backup.manifest) {
        try {
          if (!removeBackup(sandboxName, backup.manifest.backupPath)) return null;
        } catch {
          return null;
        }
      }
      sleep(STATE_BACKUP_RETRY_SECONDS);
      backup = backupState(sandboxName);
    }
    if (
      !backup.success ||
      !backup.manifest ||
      backup.failedDirs.length > 0 ||
      backup.failedFiles.length > 0
    ) {
      if (backup.manifest) {
        try {
          removeBackup(sandboxName, backup.manifest.backupPath);
        } catch {
          // Preserve the backup failure that stopped container recreation.
        }
      }
      if (!quiet) {
        console.error(
          "  Trusted container recovery stopped before recreation because sandbox state could not be fully backed up.",
        );
        console.error("  The existing sandbox container was left unchanged.");
      }
      return null;
    }
    const backupManifest = backup.manifest;
    pendingStateBackupPath = backupManifest.backupPath;
    if (!quiet) {
      console.log("  Recreating the sandbox container with its managed startup command...");
    }
    const result = recreate({
      sandboxName,
      openshellSandboxCommand: startupCommand,
      expectedOldContainerId: containerId,
      waitForSupervisor: false,
    });
    pendingStateBackupPath = null;
    let completed: {
      supervisorReady: boolean;
      outcome: DockerGpuPatchFinalizeOutcome & {
        stateRestored?: boolean;
        stateBackupRemoved?: boolean;
      };
    } | null = null;
    const removeSettledStateBackup = (): boolean => {
      try {
        return removeBackup(sandboxName, backupManifest.backupPath);
      } catch {
        return false;
      }
    };
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
        const finalizeFailure = () => {
          const finalized = finalize({ result, supervisorReady: false });
          const outcome = {
            ...finalized,
            stateRestored: false,
            ...(finalized.rolledBack ? { stateBackupRemoved: removeSettledStateBackup() } : {}),
          };
          completed = { supervisorReady, outcome };
          return outcome;
        };
        if (!supervisorReady) {
          return finalizeFailure();
        }
        let replacementOwned = false;
        try {
          replacementOwned = sameContainerId(
            resolveContainer(sandboxName, driver),
            result.newContainerId,
          );
        } catch {
          replacementOwned = false;
        }
        if (!replacementOwned) {
          return finalizeFailure();
        }
        let stateRestored = false;
        try {
          stateRestored = restoreState(sandboxName, backupManifest.backupPath).success;
        } catch {
          stateRestored = false;
        }
        if (!stateRestored) {
          return finalizeFailure();
        }
        let restoredManagedGatewayReady = false;
        try {
          restoredManagedGatewayReady =
            restartRestoredManagedGateway?.(result.newContainerId) === true;
        } catch {
          restoredManagedGatewayReady = false;
        }
        if (!restoredManagedGatewayReady) {
          // Apply restored state to a fresh managed gateway process. OpenClaw
          // can otherwise retain pre-restore runtime state or enter its
          // in-process reload path. Keep the previous container available for
          // rollback until the pinned replacement restart and health proof
          // both succeed.
          return finalizeFailure();
        }
        const runLifecycleProbe = deps.runOpenshell;
        if (!runLifecycleProbe) return finalizeFailure();
        const lifecycleDeps = {
          runOpenshell: runLifecycleProbe,
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
        };
        const outcome = {
          ...finalize(
            {
              result,
              supervisorReady: true,
              sandboxName,
              lifecycleReleaseTimeoutSecs: getDockerGpuSupervisorReconnectTimeoutSecs(1),
            },
            lifecycleDeps,
          ),
          stateRestored: true,
          stateBackupRemoved: removeSettledStateBackup(),
        };
        completed = { supervisorReady, outcome };
        return outcome;
      },
    };
  } catch (error) {
    if (pendingStateBackupPath) {
      try {
        removeBackup(sandboxName, pendingStateBackupPath);
      } catch {
        // Preserve the recreation failure that stopped container recovery.
      }
    }
    if (!quiet || process.env.NEMOCLAW_REBUILD_VERBOSE === "1") {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`  Trusted container recovery could not start: ${redactFull(redact(detail))}`);
    }
    return null;
  }
}
