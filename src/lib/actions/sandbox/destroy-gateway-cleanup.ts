// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import {
  type DockerSandboxContainerSnapshot,
  dockerSandboxContainerNamePrefix,
  getLiveSandboxNames,
  hasNoLiveSandboxes,
  type LiveSandboxListSnapshot,
  shouldCleanupGatewayAfterDestroy,
} from "../../domain/sandbox/destroy";
import * as registry from "../../state/registry";

type SandboxListProvider = () => { sandboxes: unknown[] };

type LiveSandboxListProbe = (
  args: string[],
  opts?: { ignoreError?: boolean; timeout?: number },
) => LiveSandboxListSnapshot;

type DockerCaptureProbe = (args: string[], opts?: Record<string, unknown>) => string;

type LiveSandboxProbe = (deps?: {
  captureOpenshell?: LiveSandboxListProbe;
  dockerCapture?: DockerCaptureProbe;
  timeoutMs?: number;
}) => boolean;

type FinalDestroyGatewayCleanupInput = {
  deleteSucceededOrAlreadyGone: boolean;
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

export function collectLiveSandboxProbeSnapshot(
  deps: {
    captureOpenshell?: LiveSandboxListProbe;
    dockerCapture?: DockerCaptureProbe;
    timeoutMs?: number;
  } = {},
): Parameters<typeof hasNoLiveSandboxes>[0] {
  // Both host probes are synchronous so this produces one ordered snapshot
  // after the registry check and before the cleanup decision.
  const captureOpenshell = deps.captureOpenshell ?? captureLiveSandboxes;
  const dockerCapture = deps.dockerCapture ?? captureDockerContainers;
  const timeoutMs = deps.timeoutMs ?? OPENSHELL_PROBE_TIMEOUT_MS;
  const liveList = captureOpenshell(["sandbox", "list"], {
    ignoreError: true,
    timeout: timeoutMs,
  });
  const dockerContainersBySandboxName = new Map<string, DockerSandboxContainerSnapshot>();
  for (const sandboxName of getLiveSandboxNames(liveList)) {
    try {
      dockerContainersBySandboxName.set(sandboxName, {
        output: dockerCapture(
          [
            "ps",
            "--filter",
            `name=${dockerSandboxContainerNamePrefix(sandboxName)}`,
            "--format",
            "{{.Names}}",
          ],
          {
            timeout: timeoutMs,
          },
        ),
      });
    } catch (error) {
      // SOURCE_OF_TRUTH: this host Docker CLI probe follows a terminal OpenShell
      // row and must attest that its backing container is absent. An exception
      // leaves live-sandbox state unknown, so preserve the shared gateway.
      // NemoClaw cannot manufacture that container-runtime attestation here;
      // destroy-gateway-cleanup.test.ts locks this fail-closed behavior. Remove
      // it only when final cleanup has one authoritative sandbox/container state
      // source; see the OpenShell listener-removal boundary tracked in #6639.
      console.warn(
        `Docker container probe failed for sandbox '${sandboxName}'; preserving shared gateway: ${String(error)}`,
      );
      dockerContainersBySandboxName.set(sandboxName, { output: "", probeFailed: true });
    }
  }
  return { liveList, dockerContainersBySandboxName };
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
      timeoutMs,
    });

  return shouldCleanupGatewayAfterDestroy({
    deleteSucceededOrAlreadyGone: input.deleteSucceededOrAlreadyGone,
    removedRegistryEntry: input.removedRegistryEntry,
    noRegisteredSandboxes,
    noLiveSandboxes,
  });
}
