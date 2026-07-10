// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import {
  type DockerCaptureProbe,
  hasNoLiveSandboxes,
  type LiveSandboxListProbe,
  shouldCleanupGatewayAfterDestroy,
} from "../../domain/sandbox/destroy";
import * as registry from "../../state/registry";

type SandboxListProvider = () => { sandboxes: unknown[] };

type LiveSandboxProbe = typeof hasNoLiveSandboxes;

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

export function shouldCleanupGatewayAfterConfirmedFinalDestroy(
  input: FinalDestroyGatewayCleanupInput,
  deps: FinalDestroyGatewayCleanupDeps = {},
): boolean {
  const listSandboxes = deps.listSandboxes ?? registry.listSandboxes;
  const liveSandboxProbe = deps.liveSandboxProbe ?? hasNoLiveSandboxes;
  const timeoutMs = deps.timeoutMs ?? OPENSHELL_PROBE_TIMEOUT_MS;
  const noRegisteredSandboxes = listSandboxes().sandboxes.length === 0;
  const noLiveSandboxes =
    input.deleteSucceededOrAlreadyGone &&
    input.removedRegistryEntry &&
    noRegisteredSandboxes &&
    liveSandboxProbe({
      captureOpenshell: captureLiveSandboxes,
      dockerCapture: captureDockerContainers,
      timeoutMs,
    });

  return shouldCleanupGatewayAfterDestroy({
    deleteSucceededOrAlreadyGone: input.deleteSucceededOrAlreadyGone,
    removedRegistryEntry: input.removedRegistryEntry,
    noRegisteredSandboxes,
    noLiveSandboxes,
  });
}
