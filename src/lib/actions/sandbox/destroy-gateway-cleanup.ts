// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import {
  type DockerSandboxContainerSnapshot,
  dockerSandboxContainerNamePrefix,
  getLiveSandboxNames,
  hasNoLiveSandboxes,
  hasRunningDockerSandboxContainer,
  type LiveSandboxListSnapshot,
  type SandboxRuntimeContainerSnapshot,
  shouldCleanupGatewayAfterDestroy,
} from "../../domain/sandbox/destroy";
import {
  CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES,
  type ManagedGatewayDriverProfile,
  type ManagedGatewayDriverProfileRegistry,
} from "../../onboard/compute/managed-gateway-profile";
import {
  OPENSHELL_MANAGED_BY_LABEL,
  OPENSHELL_MANAGED_BY_VALUE,
  OPENSHELL_SANDBOX_NAME_LABEL,
} from "../../onboard/docker-driver-sandbox-recovery";
import * as registry from "../../state/registry";
import {
  type CommandCapture,
  captureHostCommand,
  resolvePodmanRuntimeSocket,
} from "./doctor-host-command";

type SandboxListProvider = () => { sandboxes: unknown[] };

type LiveSandboxListProbe = (
  args: string[],
  opts?: { ignoreError?: boolean; timeout?: number },
) => LiveSandboxListSnapshot;

type DockerCaptureProbe = (args: string[], opts?: Record<string, unknown>) => string;
type HostCommandCaptureProbe = (
  command: string,
  args: string[],
  timeout?: number,
) => CommandCapture;

export interface SandboxRuntimeContainerProbeContext {
  readonly captureDocker: DockerCaptureProbe;
  readonly captureHostCommand: HostCommandCaptureProbe;
  readonly environment: NodeJS.ProcessEnv;
  readonly gatewayStateDir?: string | null;
  readonly liveSandboxNames: readonly string[];
  readonly resolvePodmanSocket: typeof resolvePodmanRuntimeSocket;
  readonly timeoutMs: number;
}

export interface SandboxRuntimeContainerProbeAdapter {
  readonly displayName: string;
  readonly driverName: string;
  createProbe(
    context: SandboxRuntimeContainerProbeContext,
  ): (sandboxName: string) => SandboxRuntimeContainerSnapshot;
}

export type SandboxRuntimeContainerProbeAdapterRegistry = Readonly<
  Record<string, SandboxRuntimeContainerProbeAdapter>
>;

type LiveSandboxProbe = (deps?: {
  captureOpenshell?: LiveSandboxListProbe;
  captureHostCommand?: HostCommandCaptureProbe;
  dockerCapture?: DockerCaptureProbe;
  environment?: NodeJS.ProcessEnv;
  gatewayStateDir?: string | null;
  managedGatewayProfiles?: ManagedGatewayDriverProfileRegistry;
  openshellDriver?: string | null;
  resolvePodmanSocket?: typeof resolvePodmanRuntimeSocket;
  runtimeContainerProbeAdapters?: SandboxRuntimeContainerProbeAdapterRegistry;
  timeoutMs?: number;
}) => boolean;

type FinalDestroyGatewayCleanupInput = {
  deleteSucceededOrAlreadyGone: boolean;
  gatewayStateDir?: string | null;
  openshellDriver?: string | null;
  removedRegistryEntry: boolean;
};

type FinalDestroyGatewayCleanupDeps = {
  listSandboxes?: SandboxListProvider;
  liveSandboxProbe?: LiveSandboxProbe;
  timeoutMs?: number;
};

function captureLiveSandboxes(...args: Parameters<LiveSandboxListProbe>) {
  const { captureOpenshell } = require("../../adapters/openshell/runtime") as {
    captureOpenshell: LiveSandboxListProbe;
  };
  return captureOpenshell(...args);
}

function captureDockerContainers(...args: Parameters<DockerCaptureProbe>) {
  const { dockerCapture } = require("../../adapters/docker/run") as {
    dockerCapture: DockerCaptureProbe;
  };
  return dockerCapture(...args);
}

function managedGatewayProfile(
  driverName: string,
  profiles: ManagedGatewayDriverProfileRegistry = CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES,
): ManagedGatewayDriverProfile | null {
  const profile = Object.hasOwn(profiles, driverName) ? profiles[driverName] : undefined;
  return profile?.driverName === driverName ? profile : null;
}

function runtimeProbeDriverName(
  openshellDriver: string | null | undefined,
  profiles: ManagedGatewayDriverProfileRegistry,
): string {
  const driver = openshellDriver?.trim().toLowerCase();
  // Entries written before openshellDriver was persisted are legacy managed
  // Docker entries. Unknown future drivers must fail closed instead of
  // inheriting Docker compatibility behavior.
  if (!driver) return "docker";
  const profile = managedGatewayProfile(driver, profiles);
  return profile?.capabilities.legacyDockerGatewayCleanup === true ? "docker" : driver;
}

function podmanContainerPresent(output: string): boolean {
  const parsed = JSON.parse(output) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Podman container probe returned a non-array JSON payload");
  }
  return parsed.length > 0;
}

function failedRuntimeSnapshot(
  sandboxName: string,
  runtimeName: string,
  error: unknown,
): SandboxRuntimeContainerSnapshot {
  console.warn(
    `${runtimeName} container probe failed for sandbox '${sandboxName}'; preserving shared gateway: ${String(error)}`,
  );
  return { present: false, probeFailed: true };
}

export const CURRENT_SANDBOX_RUNTIME_CONTAINER_PROBE_ADAPTERS = {
  docker: {
    displayName: "Docker",
    driverName: "docker",
    createProbe(context: SandboxRuntimeContainerProbeContext) {
      return (sandboxName: string): SandboxRuntimeContainerSnapshot => {
        try {
          const snapshot: DockerSandboxContainerSnapshot = {
            output: context.captureDocker(
              [
                "ps",
                "--filter",
                `name=${dockerSandboxContainerNamePrefix(sandboxName)}`,
                "--format",
                "{{.Names}}",
              ],
              {
                timeout: context.timeoutMs,
              },
            ),
          };
          return {
            present: hasRunningDockerSandboxContainer(
              sandboxName,
              snapshot,
              context.liveSandboxNames,
            ),
          };
        } catch (error) {
          // This probe follows a terminal OpenShell row and must attest that
          // its backing container is absent. Unknown state preserves the
          // shared gateway.
          return failedRuntimeSnapshot(sandboxName, "Docker", error);
        }
      };
    },
  },
  podman: {
    displayName: "Podman",
    driverName: "podman",
    createProbe(context: SandboxRuntimeContainerProbeContext) {
      let socketPath = "";
      let socketError: unknown;
      try {
        socketPath = context.resolvePodmanSocket(context.gatewayStateDir, context.environment);
      } catch (error) {
        socketError = error;
      }
      return (sandboxName: string): SandboxRuntimeContainerSnapshot => {
        if (socketError) return failedRuntimeSnapshot(sandboxName, "Podman", socketError);
        try {
          const result = context.captureHostCommand(
            "podman",
            [
              "--url",
              `unix://${socketPath}`,
              "ps",
              "--all",
              "--filter",
              `label=${OPENSHELL_MANAGED_BY_LABEL}=${OPENSHELL_MANAGED_BY_VALUE}`,
              "--filter",
              `label=${OPENSHELL_SANDBOX_NAME_LABEL}=${sandboxName}`,
              "--format",
              "json",
            ],
            context.timeoutMs,
          );
          if (result.status !== 0) {
            return failedRuntimeSnapshot(
              sandboxName,
              "Podman",
              result.stderr || result.error?.message || `podman exited ${String(result.status)}`,
            );
          }
          return { present: podmanContainerPresent(result.stdout) };
        } catch (error) {
          return failedRuntimeSnapshot(sandboxName, "Podman", error);
        }
      };
    },
  },
} as const satisfies SandboxRuntimeContainerProbeAdapterRegistry;

export function resolveSandboxRuntimeContainerProbeAdapter(
  openshellDriver: string | null | undefined,
  adapters: SandboxRuntimeContainerProbeAdapterRegistry = CURRENT_SANDBOX_RUNTIME_CONTAINER_PROBE_ADAPTERS,
  profiles: ManagedGatewayDriverProfileRegistry = CURRENT_MANAGED_GATEWAY_DRIVER_PROFILES,
): SandboxRuntimeContainerProbeAdapter | null {
  const driverName = runtimeProbeDriverName(openshellDriver, profiles);
  const adapter = Object.hasOwn(adapters, driverName) ? adapters[driverName] : undefined;
  return adapter?.driverName === driverName ? adapter : null;
}

export function collectLiveSandboxProbeSnapshot(
  deps: {
    captureOpenshell?: LiveSandboxListProbe;
    captureHostCommand?: HostCommandCaptureProbe;
    dockerCapture?: DockerCaptureProbe;
    environment?: NodeJS.ProcessEnv;
    gatewayStateDir?: string | null;
    managedGatewayProfiles?: ManagedGatewayDriverProfileRegistry;
    openshellDriver?: string | null;
    resolvePodmanSocket?: typeof resolvePodmanRuntimeSocket;
    runtimeContainerProbeAdapters?: SandboxRuntimeContainerProbeAdapterRegistry;
    timeoutMs?: number;
  } = {},
): Parameters<typeof hasNoLiveSandboxes>[0] {
  // Both host probes are synchronous so this produces one ordered snapshot
  // after the registry check and before the cleanup decision.
  const captureOpenshell = deps.captureOpenshell ?? captureLiveSandboxes;
  const dockerCapture = deps.dockerCapture ?? captureDockerContainers;
  const captureRuntimeCommand = deps.captureHostCommand ?? captureHostCommand;
  const timeoutMs = deps.timeoutMs ?? OPENSHELL_PROBE_TIMEOUT_MS;
  const liveList = captureOpenshell(["sandbox", "list"], {
    ignoreError: true,
    timeout: timeoutMs,
  });
  const sandboxNames = getLiveSandboxNames(liveList);
  const runtimeContainersBySandboxName = new Map<string, SandboxRuntimeContainerSnapshot>();
  const adapter = resolveSandboxRuntimeContainerProbeAdapter(
    deps.openshellDriver,
    deps.runtimeContainerProbeAdapters,
    deps.managedGatewayProfiles,
  );
  const probe =
    sandboxNames.length > 0
      ? adapter?.createProbe({
          captureDocker: dockerCapture,
          captureHostCommand: captureRuntimeCommand,
          environment: deps.environment ?? process.env,
          gatewayStateDir: deps.gatewayStateDir,
          liveSandboxNames: sandboxNames,
          resolvePodmanSocket: deps.resolvePodmanSocket ?? resolvePodmanRuntimeSocket,
          timeoutMs,
        })
      : undefined;
  for (const sandboxName of sandboxNames) {
    if (!probe || !adapter) {
      runtimeContainersBySandboxName.set(
        sandboxName,
        failedRuntimeSnapshot(
          sandboxName,
          deps.openshellDriver?.trim() || "Unknown runtime",
          "no runtime container probe is registered",
        ),
      );
      continue;
    }
    runtimeContainersBySandboxName.set(sandboxName, probe(sandboxName));
  }
  return { liveList, runtimeContainersBySandboxName };
}

function hasNoLiveSandboxesFromHost(deps?: Parameters<LiveSandboxProbe>[0]): boolean {
  return hasNoLiveSandboxes(collectLiveSandboxProbeSnapshot(deps));
}

export function shouldCleanupGatewayAfterConfirmedFinalDestroy(
  input: FinalDestroyGatewayCleanupInput,
  deps: FinalDestroyGatewayCleanupDeps = {},
): boolean {
  const listSandboxes = deps.listSandboxes ?? registry.listSandboxes;
  const liveSandboxProbe = deps.liveSandboxProbe ?? hasNoLiveSandboxesFromHost;
  const timeoutMs = deps.timeoutMs ?? OPENSHELL_PROBE_TIMEOUT_MS;
  const noRegisteredSandboxes = listSandboxes().sandboxes.length === 0;
  const noLiveSandboxes =
    input.deleteSucceededOrAlreadyGone &&
    input.removedRegistryEntry &&
    noRegisteredSandboxes &&
    liveSandboxProbe({
      gatewayStateDir: input.gatewayStateDir,
      openshellDriver: input.openshellDriver,
      timeoutMs,
    });

  return shouldCleanupGatewayAfterDestroy({
    deleteSucceededOrAlreadyGone: input.deleteSucceededOrAlreadyGone,
    removedRegistryEntry: input.removedRegistryEntry,
    noRegisteredSandboxes,
    noLiveSandboxes,
  });
}
