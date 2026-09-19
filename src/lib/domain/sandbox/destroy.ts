// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseLiveSandboxEntries } from "../../runtime-recovery";
import { isNonInteractiveEnv } from "../../core/non-interactive";
import { resolveSandboxContainerOwner } from "./container-owner";

const TERMINAL_OPEN_SHELL_SANDBOX_PHASES = new Set(["Error", "Failed"]);

export type DestroyGatewayCleanupDecision = "cleanup" | "preserve" | "prompt";

export type DestroyGatewayCleanupOptions = {
  cleanupGateway?: boolean;
  yes?: boolean;
  force?: boolean;
};

export type DestroyGatewayCleanupContext = {
  nonInteractive: boolean;
  platform: NodeJS.Platform;
};

export type LiveSandboxListSnapshot = {
  status: number | null;
  output: string;
};

export type DockerSandboxContainerSnapshot = {
  output: string;
  probeFailed?: boolean;
};

export type LiveSandboxProbeSnapshot = {
  liveList: LiveSandboxListSnapshot;
  dockerContainersBySandboxName: ReadonlyMap<string, DockerSandboxContainerSnapshot>;
};

export function shouldStopHostServicesAfterDestroy(input: {
  deleteSucceededOrAlreadyGone: boolean;
  registeredSandboxCount: number;
  sandboxStillRegistered: boolean;
}): boolean {
  return (
    input.deleteSucceededOrAlreadyGone &&
    input.registeredSandboxCount === 1 &&
    input.sandboxStillRegistered
  );
}

export function isDestroyNonInteractiveEnv(): boolean {
  return isNonInteractiveEnv();
}

export type LiveSandboxProbeVerdict =
  | { readonly status: "none" }
  | { readonly status: "unavailable" }
  | { readonly status: "present"; readonly sandboxNames: readonly string[] };

/**
 * Decide the non-UI gateway cleanup path for a final sandbox destroy.
 *
 * Linux preserves the shared gateway by default for reuse (#2166), while
 * unattended macOS destroys clean it up so the leaked host listener is released
 * (#4662). Track removal in #6639: drop the macOS default after OpenShell
 * releases the Docker-driver listener fix, NemoClaw raises its supported
 * OpenShell floor to that fixed version, and live macOS final destroys release
 * the listener without forced gateway cleanup.
 * Native win32 hosts keep the conservative non-macOS default because supported
 * Windows runs go through WSL2 and report `linux`.
 */
export function resolveDestroyGatewayCleanupDecision(
  options: DestroyGatewayCleanupOptions,
  context: DestroyGatewayCleanupContext,
): DestroyGatewayCleanupDecision {
  if (options.cleanupGateway === true) return "cleanup";
  if (options.cleanupGateway === false) return "preserve";
  if (options.yes === true || options.force === true || context.nonInteractive) {
    return context.platform === "darwin" ? "cleanup" : "preserve";
  }
  return "prompt";
}

function dockerContainerNames(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((name) => name.trim())
    .filter(Boolean);
}

function ownsDockerSandboxContainer(
  containerName: string,
  sandboxName: string,
  knownSandboxNames: Iterable<string>,
): boolean {
  return (
    resolveSandboxContainerOwner(containerName, sandboxName, knownSandboxNames) === containerName
  );
}

export function hasRunningDockerSandboxContainer(
  sandboxName: string,
  snapshot: DockerSandboxContainerSnapshot | undefined,
  knownSandboxNames: Iterable<string> = [sandboxName],
): boolean {
  if (!snapshot || snapshot.probeFailed) {
    return true;
  }
  return dockerContainerNames(snapshot.output).some((name) =>
    ownsDockerSandboxContainer(name, sandboxName, knownSandboxNames),
  );
}

export function getLiveSandboxNames(liveList: LiveSandboxListSnapshot): string[] {
  if (liveList.status !== 0) {
    return [];
  }
  return parseLiveSandboxEntries(liveList.output).map((entry) => entry.name);
}

export function classifyLiveSandboxesWithResourceObservation(
  liveList: LiveSandboxListSnapshot,
  hasRunningResource: (sandboxName: string, knownSandboxNames: readonly string[]) => boolean,
): LiveSandboxProbeVerdict {
  // Fail closed: if OpenShell cannot report authoritative sandbox state,
  // preserve the shared gateway so a sandbox never loses its listener.
  if (liveList.status !== 0) {
    return { status: "unavailable" };
  }
  const entries = parseLiveSandboxEntries(liveList.output);
  const sandboxNames = entries.map((entry) => entry.name);
  const liveSandboxNames = entries
    .filter(
      (entry) =>
        !TERMINAL_OPEN_SHELL_SANDBOX_PHASES.has(entry.phase ?? "") ||
        hasRunningResource(entry.name, sandboxNames),
    )
    .map((entry) => entry.name);
  return liveSandboxNames.length === 0
    ? { status: "none" }
    : { status: "present", sandboxNames: liveSandboxNames };
}

export function classifyLiveSandboxes({
  liveList,
  dockerContainersBySandboxName,
}: LiveSandboxProbeSnapshot): LiveSandboxProbeVerdict {
  return classifyLiveSandboxesWithResourceObservation(liveList, (sandboxName, sandboxNames) =>
    hasRunningDockerSandboxContainer(
      sandboxName,
      dockerContainersBySandboxName.get(sandboxName),
      sandboxNames,
    ),
  );
}
