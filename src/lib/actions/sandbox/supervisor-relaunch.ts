// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { dockerCapture, dockerRun } from "../../adapters/docker";
import * as agentRuntime from "../../agent/runtime";
import { shouldManageDashboardForAgent } from "../../onboard/dashboard-runtime";
import { hasZeroDockerExitStatus } from "../../onboard/docker-command-result";
import {
  type DockerContainerInspect,
  parseDockerInspectJson,
} from "../../onboard/docker-gpu-patch";
import { buildSandboxRuntimeEnvArgs } from "../../onboard/sandbox-create-launch";
import {
  privilegedSandboxExecArgv,
  resolveDirectSandboxContainer,
} from "../../sandbox/privileged-exec";
import { redact, redactFull } from "../../security/redact";
import * as registry from "../../state/registry";
import { resolveSandboxDashboardPort } from "./forward-recovery";

/**
 * Compatibility boundary for OpenShell 0.0.71's Docker driver: legacy
 * sandboxes persist `OPENSHELL_SANDBOX_COMMAND=sleep infinity` while
 * `scripts/nemoclaw-start.sh` owns the managed workload as a sibling process.
 * Relaunch requires that inspected legacy value, the registered exact container
 * identity, and the managed controller's exact pinned proof that no supervisor
 * is running. The root-owned controller then rechecks absence, refreshes the
 * current OpenShell CA, and launches one sandbox-UID supervisor. The caller
 * accepts it only after the same pinned controller proves managed health.
 * Replacing the container while its OpenShell supervisor is registered either
 * publishes terminal phase Error or blocks duplicate supervisor registration.
 * Regression coverage is named in `supervisor-relaunch.test.ts`,
 * `process-recovery-supervisor-relaunch.test.ts`, and `sandbox-survival.test.ts`.
 * Remove this path after supported upgrades rebuild every legacy keepalive
 * container with `nemoclaw-start` as its persisted startup command.
 */
const LEGACY_OPENSHELL_KEEPALIVE = "sleep infinity";
const DOCKER_CONTROL_TIMEOUT_MS = 30000;

export type ManagedSupervisorRelaunch = {
  containerId: string;
};

export type ManagedSupervisorRelaunchDeps = {
  getSandbox?: typeof registry.getSandbox;
  getSessionAgent?: typeof agentRuntime.getSessionAgent;
  resolveDashboardPort?: typeof resolveSandboxDashboardPort;
  resolveContainer?: typeof resolveDirectSandboxContainer;
  inspectContainer?: (containerId: string) => DockerContainerInspect;
  confirmMissingSupervisor?: (containerId: string) => boolean;
  createNonce?: () => string;
  privilegedExecArgv?: typeof privilegedSandboxExecArgv;
  runDocker?: typeof dockerRun;
};

function inspectContainer(containerId: string): DockerContainerInspect {
  return parseDockerInspectJson(
    dockerCapture(["inspect", "--type", "container", containerId], {
      ignoreError: true,
      timeout: DOCKER_CONTROL_TIMEOUT_MS,
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

function reconstructSupervisorRuntimeEnvironment(
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
  return envArgs;
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
  const runtimeEnvironment = reconstructSupervisorRuntimeEnvironment(sandboxName, entry, deps);
  if (runtimeEnvironment === null) return null;

  const resolveContainer = deps.resolveContainer ?? resolveDirectSandboxContainer;
  const inspect = deps.inspectContainer ?? inspectContainer;
  const confirmMissingSupervisor = deps.confirmMissingSupervisor;
  const privilegedExecArgv = deps.privilegedExecArgv ?? privilegedSandboxExecArgv;
  const runDocker = deps.runDocker ?? dockerRun;
  try {
    const containerId = resolveContainer(sandboxName, driver);
    if (!hasLegacyKeepaliveStartup(inspect(containerId))) return null;
    if (!confirmMissingSupervisor?.(containerId)) return null;
    if (!quiet) {
      console.log("  Launching the managed supervisor in the registered sandbox container...");
    }
    const nonce = (deps.createNonce ?? (() => randomBytes(32).toString("hex")))();
    const launchCommand = [
      "/usr/local/bin/nemoclaw-gateway-control",
      "launch-supervisor",
      nonce,
      ...runtimeEnvironment,
    ];
    const launchResult = runDocker(
      privilegedExecArgv(sandboxName, launchCommand, false, true, containerId),
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: DOCKER_CONTROL_TIMEOUT_MS,
      },
    );
    if (!hasZeroDockerExitStatus(launchResult)) {
      throw new Error("The registered container refused the managed supervisor launch.");
    }
    return { containerId };
  } catch (error) {
    if (!quiet) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`  Trusted container recovery could not start: ${redactFull(redact(detail))}`);
    }
    return null;
  }
}
