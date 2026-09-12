// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { retryUntilAsync } from "../../core/retry";
import {
  classifyLiveSandboxes,
  type DockerSandboxContainerSnapshot,
  getLiveSandboxNames,
  type LiveSandboxListSnapshot,
  type LiveSandboxProbeSnapshot,
  type LiveSandboxProbeVerdict,
} from "../../domain/sandbox/destroy";
import { resolveRegisteredRuntimeProvider } from "../../onboard/runtime-provider/selection";
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
}) => LiveSandboxProbeVerdict;

type FinalDestroyGatewayCleanupInput = {
  deleteSucceededOrAlreadyGone: boolean;
  removedRegistryEntry: boolean;
  runtimeProviderId?: string | null;
  sandboxName: string;
};

export type FinalDestroyGatewayCleanupVerdict =
  | { readonly status: "not-final" }
  | { readonly status: "cleanup" }
  | { readonly status: "live-list-unavailable" }
  | { readonly status: "live-sandboxes"; readonly sandboxNames: readonly string[] };

type FinalDestroyGatewayCleanupDeps = {
  captureOpenshell?: LiveSandboxListProbe;
  dockerCapture?: DockerCaptureProbe;
  listSandboxes?: SandboxListProvider;
  liveSandboxProbe?: LiveSandboxProbe;
  now?: () => number;
  resolveRuntimeProvider?: typeof resolveRegisteredRuntimeProvider;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

// OpenShell keeps listing a deleted sandbox until its runtime finishes
// terminating, so the final probe waits for that one row before it treats the
// row as a live sandbox that blocks gateway cleanup. The retry schedule caps
// the attempts; the deadline caps the wall-clock wait when each list probe is
// slow, so the wait cannot multiply the probe timeout by the attempt count.
const DELETED_SANDBOX_ABSENCE_TIMEOUT_MS = 30_000;
const DELETED_SANDBOX_ABSENCE_RETRY_DELAY_MS = 2_000;
const DELETED_SANDBOX_ABSENCE_RETRY_DELAYS_MS: readonly number[] = Array.from(
  { length: DELETED_SANDBOX_ABSENCE_TIMEOUT_MS / DELETED_SANDBOX_ABSENCE_RETRY_DELAY_MS },
  () => DELETED_SANDBOX_ABSENCE_RETRY_DELAY_MS,
);

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
): LiveSandboxProbeSnapshot {
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
        output: dockerCapture(["ps", "--filter", "name=openshell-", "--format", "{{.Names}}"], {
          timeout: timeoutMs,
        }),
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

function classifyLiveSandboxesFromHost(
  deps?: Parameters<LiveSandboxProbe>[0],
): LiveSandboxProbeVerdict {
  return classifyLiveSandboxes(collectLiveSandboxProbeSnapshot(deps));
}

function classifyLiveSandboxesWithoutDocker(
  timeoutMs: number,
  captureOpenshell: LiveSandboxListProbe = captureLiveSandboxes,
): LiveSandboxProbeVerdict {
  const liveList = captureOpenshell(["sandbox", "list"], {
    ignoreError: true,
    timeout: timeoutMs,
  });
  // OpenShell terminal rows do not record their backing runtime. A Podman
  // absence proof therefore cannot establish that a same-named Docker
  // resource is absent. Preserve the shared gateway whenever any unclassified
  // row remains; an empty successful OpenShell snapshot is the only
  // cross-runtime absence proof available without invoking Docker.
  if (liveList.status !== 0) return { status: "unavailable" };
  const sandboxNames = getLiveSandboxNames(liveList);
  return sandboxNames.length === 0 ? { status: "none" } : { status: "present", sandboxNames };
}

function resolveFinalDestroyGatewayCleanupOnce(
  input: FinalDestroyGatewayCleanupInput,
  deps: FinalDestroyGatewayCleanupDeps,
): FinalDestroyGatewayCleanupVerdict {
  const listSandboxes = deps.listSandboxes ?? registry.listSandboxes;
  if (
    !input.deleteSucceededOrAlreadyGone ||
    !input.removedRegistryEntry ||
    listSandboxes().sandboxes.length > 0
  ) {
    return { status: "not-final" };
  }
  const timeoutMs = deps.timeoutMs ?? OPENSHELL_PROBE_TIMEOUT_MS;
  const provider = input.runtimeProviderId
    ? (deps.resolveRuntimeProvider ?? resolveRegisteredRuntimeProvider)(input.runtimeProviderId)
    : null;
  const liveProbeDeps = {
    ...(deps.captureOpenshell ? { captureOpenshell: deps.captureOpenshell } : {}),
    ...(deps.dockerCapture ? { dockerCapture: deps.dockerCapture } : {}),
    timeoutMs,
  };
  const liveSandboxes = deps.liveSandboxProbe
    ? deps.liveSandboxProbe(liveProbeDeps)
    : provider?.gateway.ownsHostReadiness === true
      ? classifyLiveSandboxesWithoutDocker(timeoutMs, deps.captureOpenshell)
      : classifyLiveSandboxesFromHost(liveProbeDeps);
  if (liveSandboxes.status === "none") return { status: "cleanup" };
  if (liveSandboxes.status === "unavailable") return { status: "live-list-unavailable" };
  return { status: "live-sandboxes", sandboxNames: liveSandboxes.sandboxNames };
}

function onlyDeletedSandboxRemains(
  verdict: FinalDestroyGatewayCleanupVerdict,
  sandboxName: string,
): boolean {
  return (
    verdict.status === "live-sandboxes" &&
    verdict.sandboxNames.every((liveSandboxName) => liveSandboxName === sandboxName)
  );
}

export async function resolveFinalDestroyGatewayCleanup(
  input: FinalDestroyGatewayCleanupInput,
  deps: FinalDestroyGatewayCleanupDeps = {},
): Promise<FinalDestroyGatewayCleanupVerdict> {
  const now = deps.now ?? Date.now;
  const deadline = now() + DELETED_SANDBOX_ABSENCE_TIMEOUT_MS;
  return retryUntilAsync(() => resolveFinalDestroyGatewayCleanupOnce(input, deps), {
    accept: (verdict) =>
      !onlyDeletedSandboxRemains(verdict, input.sandboxName) || now() >= deadline,
    onRetry: (_verdict, _delayMs, attempt) => {
      if (attempt === 1) {
        console.log(
          `  Waiting for OpenShell to finish removing sandbox '${input.sandboxName}' before the shared gateway decision...`,
        );
      }
    },
    retryDelaysMs: deps.retryDelaysMs ?? DELETED_SANDBOX_ABSENCE_RETRY_DELAYS_MS,
    sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  });
}
