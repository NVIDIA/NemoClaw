// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- exercised through CLI subprocess destroy/rebuild tests. */

import fs from "node:fs";

import { CLI_NAME } from "../../branding";
import { prompt as askPrompt } from "../../credentials";
import {
  type DestroySandboxOptions,
  normalizeDestroySandboxOptions,
} from "../../domain/lifecycle/options";
import * as onboardSession from "../../onboard-session";
import type { Session } from "../../onboard-session";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { DASHBOARD_PORT } from "../../ports";
import * as registry from "../../state/registry";
import { resolveOpenshell } from "../../adapters/openshell/resolve";
import { parseLiveSandboxNames } from "../../runtime-recovery";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "../../state/sandbox-session";
import {
  getSandboxDeleteOutcome,
  shouldCleanupGatewayAfterDestroy,
  shouldStopHostServicesAfterDestroy,
} from "../../domain/sandbox/destroy";
import { G, R, YW } from "../../terminal-style";

type DockerRmi = (tag: string, opts?: { ignoreError?: boolean }) => { status: number | null };

type RemoveSandboxImageDeps = {
  getSandbox?: typeof registry.getSandbox;
  dockerRmi?: DockerRmi;
};

type RemoveSandboxRegistryEntryDeps = {
  removeImage?: (sandboxName: string) => void;
  removeSandbox?: typeof registry.removeSandbox;
};

const NEMOCLAW_GATEWAY_NAME = "nemoclaw";
const DASHBOARD_FORWARD_PORT = String(DASHBOARD_PORT);

function cleanupGatewayAfterLastSandbox(): void {
  const { runOpenshell } = require("../../adapters/openshell/runtime") as {
    runOpenshell: (args: string[], opts?: Record<string, unknown>) => { status: number | null };
  };
  const { dockerRemoveVolumesByPrefix } = require("../../adapters/docker") as {
    dockerRemoveVolumesByPrefix: (prefix: string, opts?: { ignoreError?: boolean }) => void;
  };

  runOpenshell(["forward", "stop", DASHBOARD_FORWARD_PORT], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  runOpenshell(["gateway", "destroy", "-g", NEMOCLAW_GATEWAY_NAME], { ignoreError: true });
  dockerRemoveVolumesByPrefix(`openshell-cluster-${NEMOCLAW_GATEWAY_NAME}`, {
    ignoreError: true,
  });
}

function hasNoLiveSandboxes(): boolean {
  const { captureOpenshell } = require("../../adapters/openshell/runtime") as {
    captureOpenshell: (
      args: string[],
      opts?: { ignoreError?: boolean; timeout?: number },
    ) => { status: number | null; output: string };
  };
  const liveList = captureOpenshell(["sandbox", "list"], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  if (liveList.status !== 0) {
    return false;
  }
  return parseLiveSandboxNames(liveList.output).size === 0;
}

function cleanupSandboxServices(
  sandboxName: string,
  { stopHostServices = false }: { stopHostServices?: boolean } = {},
): void {
  if (stopHostServices) {
    const { stopAll } = require("../../services");
    stopAll({ sandboxName });
  }

  const sb = registry.getSandbox(sandboxName);
  if (sb?.provider?.includes("ollama")) {
    const { unloadOllamaModels } = require("../../onboard-ollama-proxy");
    unloadOllamaModels();
  }

  try {
    fs.rmSync(`/tmp/nemoclaw-services-${sandboxName}`, { recursive: true, force: true });
  } catch {
    // PID directory may not exist — ignore.
  }

  // Delete messaging providers created during onboard. Suppress stderr so
  // "! Provider not found" noise doesn't appear when messaging was never configured.
  const { runOpenshell } = require("../../adapters/openshell/runtime") as {
    runOpenshell: (args: string[], opts?: Record<string, unknown>) => { status: number | null };
  };
  for (const suffix of ["telegram-bridge", "discord-bridge", "slack-bridge"]) {
    runOpenshell(["provider", "delete", `${sandboxName}-${suffix}`], {
      ignoreError: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
  }
}

/**
 * Remove the host-side Docker image that was built for a sandbox during onboard.
 * Must be called before registry.removeSandbox() since the imageTag is stored there.
 */
export function removeSandboxImage(
  sandboxName: string,
  deps: RemoveSandboxImageDeps = {},
): void {
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const removeImage =
    deps.dockerRmi ?? (require("../../adapters/docker") as { dockerRmi: DockerRmi }).dockerRmi;
  const sb = getSandbox(sandboxName);
  if (!sb?.imageTag) return;
  const result = removeImage(sb.imageTag, { ignoreError: true });
  if (result.status === 0) {
    console.log(`  Removed Docker image ${sb.imageTag}`);
  } else {
    console.warn(
      `  ${YW}⚠${R} Failed to remove Docker image ${sb.imageTag}; run '${CLI_NAME} gc' to clean up.`,
    );
  }
}

export function removeSandboxRegistryEntry(
  sandboxName: string,
  deps: RemoveSandboxRegistryEntryDeps = {},
): boolean {
  const removeImage = deps.removeImage ?? removeSandboxImage;
  const removeSandbox = deps.removeSandbox ?? registry.removeSandbox;
  removeImage(sandboxName);
  return removeSandbox(sandboxName);
}

export async function destroySandbox(
  sandboxName: string,
  options: string[] | DestroySandboxOptions = {},
): Promise<void> {
  const normalized = normalizeDestroySandboxOptions(options);
  const skipConfirm = normalized.yes === true || normalized.force === true;

  // Active session detection — enrich the confirmation prompt if sessions are active
  let activeSessionCount = 0;
  const opsBin = resolveOpenshell();
  if (opsBin) {
    try {
      const sessionResult = getActiveSandboxSessions(sandboxName, createSessionDeps(opsBin));
      if (sessionResult.detected) {
        activeSessionCount = sessionResult.sessions.length;
      }
    } catch {
      /* non-fatal */
    }
  }

  if (!skipConfirm) {
    console.log(`  ${YW}Destroy sandbox '${sandboxName}'?${R}`);
    if (activeSessionCount > 0) {
      const plural = activeSessionCount > 1 ? "sessions" : "session";
      console.log(
        `  ${YW}⚠  Active SSH ${plural} detected (${activeSessionCount} connection${activeSessionCount > 1 ? "s" : ""})${R}`,
      );
      console.log(
        `  Destroying will terminate ${activeSessionCount === 1 ? "the" : "all"} active ${plural} with a Broken pipe error.`,
      );
    }
    console.log("  This will permanently delete the sandbox and all workspace files inside it.");
    console.log("  This cannot be undone.");
    const answer = await askPrompt("  Type 'yes' to confirm, or press Enter to cancel [y/N]: ");
    if (answer.trim().toLowerCase() !== "y" && answer.trim().toLowerCase() !== "yes") {
      console.log("  Cancelled.");
      return;
    }
  }

  const nim = require("../../nim") as {
    stopNimContainer: (sandboxName: string, opts?: { silent?: boolean }) => void;
    stopNimContainerByName: (name: string) => void;
  };
  const sb = registry.getSandbox(sandboxName);
  if (sb && sb.nimContainer) {
    console.log(`  Stopping NIM for '${sandboxName}'...`);
    nim.stopNimContainerByName(sb.nimContainer);
  } else {
    // Best-effort cleanup of convention-named NIM containers that may not
    // be recorded in the registry (e.g. older sandboxes).  Suppress output
    // so the user doesn't see "No such container" noise when no NIM exists.
    nim.stopNimContainer(sandboxName, { silent: true });
  }

  if (sb?.provider?.includes("ollama")) {
    const { unloadOllamaModels, killStaleProxy } = require("../../onboard-ollama-proxy");
    unloadOllamaModels();
    killStaleProxy();
  }

  console.log(`  Deleting sandbox '${sandboxName}'...`);
  const { runOpenshell } = require("../../adapters/openshell/runtime") as {
    runOpenshell: (
      args: string[],
      opts?: Record<string, unknown>,
    ) => { status: number | null; stdout?: string; stderr?: string };
  };
  const deleteResult = runOpenshell(["sandbox", "delete", sandboxName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { output: deleteOutput, alreadyGone } = getSandboxDeleteOutcome(deleteResult);

  if (deleteResult.status !== 0 && !alreadyGone) {
    if (deleteOutput) {
      console.error(`  ${deleteOutput}`);
    }
    console.error(`  Failed to destroy sandbox '${sandboxName}'.`);
    process.exit(deleteResult.status || 1);
  }

  const deleteSucceededOrAlreadyGone = deleteResult.status === 0 || alreadyGone;
  const shouldStopHostServices = shouldStopHostServicesAfterDestroy({
    deleteSucceededOrAlreadyGone,
    registeredSandboxCount: registry.listSandboxes().sandboxes.length,
    sandboxStillRegistered: !!registry.getSandbox(sandboxName),
  });

  cleanupSandboxServices(sandboxName, { stopHostServices: shouldStopHostServices });
  const removed = removeSandboxRegistryEntry(sandboxName);
  const session = onboardSession.loadSession();
  if (session && session.sandboxName === sandboxName) {
    onboardSession.updateSession((s: Session) => {
      s.sandboxName = null;
      return s;
    });
  }
  if (
    shouldCleanupGatewayAfterDestroy({
      deleteSucceededOrAlreadyGone,
      removedRegistryEntry: removed,
      noRegisteredSandboxes: registry.listSandboxes().sandboxes.length === 0,
      noLiveSandboxes: hasNoLiveSandboxes(),
    })
  ) {
    cleanupGatewayAfterLastSandbox();
  }
  if (alreadyGone) {
    console.log(`  Sandbox '${sandboxName}' was already absent from the live gateway.`);
  }
  console.log(`  ${G}✓${R} Sandbox '${sandboxName}' destroyed`);
}
