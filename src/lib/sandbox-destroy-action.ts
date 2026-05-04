// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- exercised through CLI subprocess destroy/rebuild tests. */

import fs from "node:fs";

import { CLI_NAME } from "./branding";
import { prompt as askPrompt } from "./credentials";
import * as onboardSession from "./onboard-session";
import type { Session } from "./onboard-session";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./openshell-timeouts";
import { DASHBOARD_PORT } from "./ports";
import * as registry from "./registry";
import { resolveOpenshell } from "./resolve-openshell";
import { parseLiveSandboxNames } from "./runtime-recovery";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "./sandbox-session-state";
import { stripAnsi } from "./openshell";
import { G, R, YW } from "./terminal-style";

type SpawnLikeResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
};

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
  const { runOpenshell } = require("./openshell-runtime") as {
    runOpenshell: (args: string[], opts?: Record<string, unknown>) => { status: number | null };
  };
  const { dockerRemoveVolumesByPrefix } = require("./docker") as {
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
  const { captureOpenshell } = require("./openshell-runtime") as {
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

function isMissingSandboxDeleteResult(output = ""): boolean {
  return /\bNotFound\b|\bNot Found\b|sandbox not found|sandbox .* not found|sandbox .* not present|sandbox does not exist|no such sandbox/i.test(
    stripAnsi(output),
  );
}

export function getSandboxDeleteOutcome(deleteResult: SpawnLikeResult): {
  output: string;
  alreadyGone: boolean;
} {
  const output = `${deleteResult.stdout || ""}${deleteResult.stderr || ""}`.trim();
  return {
    output,
    alreadyGone: deleteResult.status !== 0 && isMissingSandboxDeleteResult(output),
  };
}

function cleanupSandboxServices(
  sandboxName: string,
  { stopHostServices = false }: { stopHostServices?: boolean } = {},
): void {
  if (stopHostServices) {
    const { stopAll } = require("./services");
    stopAll({ sandboxName });
  }

  const sb = registry.getSandbox(sandboxName);
  if (sb?.provider?.includes("ollama")) {
    const { unloadOllamaModels } = require("./onboard-ollama-proxy");
    unloadOllamaModels();
  }

  try {
    fs.rmSync(`/tmp/nemoclaw-services-${sandboxName}`, { recursive: true, force: true });
  } catch {
    // PID directory may not exist — ignore.
  }

  // Delete messaging providers created during onboard. Suppress stderr so
  // "! Provider not found" noise doesn't appear when messaging was never configured.
  const { runOpenshell } = require("./openshell-runtime") as {
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
    deps.dockerRmi ?? (require("./docker") as { dockerRmi: DockerRmi }).dockerRmi;
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

export async function destroySandbox(sandboxName: string, args: string[] = []): Promise<void> {
  const skipConfirm = args.includes("--yes") || args.includes("--force");

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

  const nim = require("./nim") as {
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
    const { unloadOllamaModels, killStaleProxy } = require("./onboard-ollama-proxy");
    unloadOllamaModels();
    killStaleProxy();
  }

  console.log(`  Deleting sandbox '${sandboxName}'...`);
  const { runOpenshell } = require("./openshell-runtime") as {
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

  const shouldStopHostServices =
    (deleteResult.status === 0 || alreadyGone) &&
    registry.listSandboxes().sandboxes.length === 1 &&
    !!registry.getSandbox(sandboxName);

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
    (deleteResult.status === 0 || alreadyGone) &&
    removed &&
    registry.listSandboxes().sandboxes.length === 0 &&
    hasNoLiveSandboxes()
  ) {
    cleanupGatewayAfterLastSandbox();
  }
  if (alreadyGone) {
    console.log(`  Sandbox '${sandboxName}' was already absent from the live gateway.`);
  }
  console.log(`  ${G}✓${R} Sandbox '${sandboxName}' destroyed`);
}
