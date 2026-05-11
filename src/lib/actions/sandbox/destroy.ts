// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0


import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLI_NAME } from "../../cli/branding";
import { prompt as askPrompt } from "../../credentials/store";
import {
  type DestroySandboxOptions,
  normalizeDestroySandboxOptions,
} from "../../domain/lifecycle/options";
import * as onboardSession from "../../state/onboard-session";
import type { Session } from "../../state/onboard-session";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { DASHBOARD_PORT } from "../../core/ports";
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
import { G, R, YW } from "../../cli/terminal-style";

type DockerRmi = (tag: string, opts?: { ignoreError?: boolean }) => { status: number | null };

type RemoveSandboxImageDeps = {
  getSandbox?: typeof registry.getSandbox;
  dockerRmi?: DockerRmi;
};

type RemoveSandboxRegistryEntryDeps = {
  removeImage?: (sandboxName: string) => void;
  removeSandbox?: typeof registry.removeSandbox;
};

type RunOpenshell = (
  args: string[],
  opts?: Record<string, unknown>,
) => { status: number | null };

export type CleanupSandboxServicesDeps = {
  getSandbox?: typeof registry.getSandbox;
  stopAll?: (opts: { sandboxName: string }) => void;
  unloadOllamaModels?: () => void;
  runOpenshell?: RunOpenshell;
  rmSync?: typeof fs.rmSync;
};

const NEMOCLAW_GATEWAY_NAME = "nemoclaw";
const DASHBOARD_FORWARD_PORT = String(DASHBOARD_PORT);

function dockerDriverGatewayPidFile(): string {
  const configured = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
  const stateDir = configured && configured.trim()
    ? path.resolve(configured.trim())
    : path.join(os.homedir(), ".local", "state", "nemoclaw", "openshell-docker-gateway");
  return path.join(stateDir, "openshell-gateway.pid");
}

function isDockerDriverGatewayPid(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
    return cmdline.includes("openshell-gateway");
  } catch {
    return false;
  }
}

function stopDockerDriverGatewayProcess(): void {
  const pidFile = dockerDriverGatewayPidFile();
  let pid: number | null = null;
  try {
    pid = Number.parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    fs.rmSync(pidFile, { force: true });
    return;
  }
  if (!isDockerDriverGatewayPid(pid)) {
    fs.rmSync(pidFile, { force: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    fs.rmSync(pidFile, { force: true });
    return;
  }
  fs.rmSync(pidFile, { force: true });
}

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
  if (process.platform === "linux") {
    stopDockerDriverGatewayProcess();
    const removeResult = runOpenshell(["gateway", "remove", NEMOCLAW_GATEWAY_NAME], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (removeResult.status !== 0) {
      runOpenshell(["gateway", "destroy", "-g", NEMOCLAW_GATEWAY_NAME], {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  } else {
    runOpenshell(["gateway", "destroy", "-g", NEMOCLAW_GATEWAY_NAME], { ignoreError: true });
  }
  dockerRemoveVolumesByPrefix(`openshell-cluster-${NEMOCLAW_GATEWAY_NAME}`, {
    ignoreError: true,
  });
}

// Mirrors the body of `isNonInteractive()` in src/lib/onboard.ts. Duplicated
// here to avoid an awkward sibling-action -> onboard import; the canonical
// helper should be lifted to src/lib/core/ so this and the lazy requires in
// policy-channel.ts and inference/ollama/proxy.ts can all share one source.
function isNonInteractive(): boolean {
  return process.env.NEMOCLAW_NON_INTERACTIVE === "1";
}

/**
 * Decide whether to tear down the shared NemoClaw gateway after destroying
 * the last sandbox. Default is to preserve it (#2166); explicit opt-in via
 * `cleanupGateway: true` (which `normalizeDestroySandboxOptions` also reads
 * from `--cleanup-gateway` / `NEMOCLAW_CLEANUP_GATEWAY`).
 *
 * Prompt rules:
 *   - explicit `cleanupGateway` set         → honour it without prompting
 *   - non-interactive or `--yes` / `--force` → preserve gateway (safe default)
 *   - interactive without `--yes`           → prompt the user
 */
async function resolveCleanupGatewayDecision(
  options: DestroySandboxOptions,
): Promise<boolean> {
  if (options.cleanupGateway === true) return true;
  if (options.cleanupGateway === false) return false;
  if (options.yes === true || options.force === true) return false;
  if (isNonInteractive()) return false;
  console.log(`  ${YW}This was the last sandbox.${R}`);
  console.log(
    "  Also destroy the shared NemoClaw gateway (port forward, gateway pod, cluster volumes)?",
  );
  console.log("  Saying 'no' keeps the gateway so the next 'nemoclaw onboard' is faster.");
  const answer = await askPrompt(
    "  Type 'yes' to destroy the gateway, or press Enter to keep it [y/N]: ",
  );
  const trimmed = answer.trim().toLowerCase();
  return trimmed === "y" || trimmed === "yes";
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

export function cleanupSandboxServices(
  sandboxName: string,
  { stopHostServices = false }: { stopHostServices?: boolean } = {},
  deps: CleanupSandboxServicesDeps = {},
): void {
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const stopAll =
    deps.stopAll ??
    ((opts: { sandboxName: string }) => {
      const services = require("../../services") as {
        stopAll: (opts: { sandboxName: string }) => void;
      };
      services.stopAll(opts);
    });
  const unloadOllamaModels =
    deps.unloadOllamaModels ??
    (() => {
      const { unloadOllamaModels: unload } = require("../../inference/ollama/proxy") as {
        unloadOllamaModels: () => void;
      };
      unload();
    });
  const runOpenshell =
    deps.runOpenshell ??
    ((args: string[], opts?: Record<string, unknown>) => {
      const runtime = require("../../adapters/openshell/runtime") as {
        runOpenshell: RunOpenshell;
      };
      return runtime.runOpenshell(args, opts);
    });
  const rmSync = deps.rmSync ?? fs.rmSync;

  if (stopHostServices) {
    // `stopAll()` already runs `unloadOllamaModels()` unconditionally —
    // see src/lib/services.ts. Don't double-call here.
    stopAll({ sandboxName });
  } else {
    // No global stop, so `stopAll()` did not run; explicitly free Ollama
    // models for this sandbox if its provider used Ollama. Without this
    // branch a single-sandbox destroy would leave models loaded on the GPU.
    const sb = getSandbox(sandboxName);
    if (sb?.provider?.includes("ollama")) {
      unloadOllamaModels();
    }
  }

  try {
    rmSync(`/tmp/nemoclaw-services-${sandboxName}`, { recursive: true, force: true });
  } catch {
    // PID directory may not exist — ignore.
  }

  // Delete messaging providers created during onboard. Suppress stderr so
  // "! Provider not found" noise doesn't appear when messaging was never configured.
  for (const suffix of ["telegram-bridge", "discord-bridge", "slack-bridge", "slack-app"]) {
    runOpenshell(["provider", "delete", `${sandboxName}-${suffix}`], {
      ignoreError: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
  }
}

/**
 * Remove host-side shields state files for a sandbox.
 *
 * Without this cleanup a stale shields-<name>.json from a previous
 * `shields up` survives destroy → re-onboard and causes
 * `deriveShieldsMode` to report "locked" on a fresh sandbox.
 *
 * See: https://github.com/NVIDIA/NemoClaw/issues/3114
 */
export function removeShieldsState(
  sandboxName: string,
  stateDir = path.join(process.env.HOME ?? "/tmp", ".nemoclaw", "state"),
): void {
  const resolvedStateDir = path.resolve(stateDir);
  for (const prefix of ["shields-", "shields-timer-"]) {
    const filePath = path.resolve(resolvedStateDir, `${prefix}${sandboxName}.json`);
    if (!filePath.startsWith(`${resolvedStateDir}${path.sep}`)) {
      // Defense-in-depth: sandbox names are validated to [a-z0-9-] at
      // all entry points, but reject traversal attempts just in case.
      continue;
    }
    try {
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      // force: true already suppresses ENOENT; warn on real failures
      // (e.g. EPERM) so stale state doesn't silently survive.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  ${YW}⚠${R} Failed to remove shields state '${filePath}': ${message}`);
    }
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

  const nim = require("../../inference/nim") as {
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

  // The Ollama auth proxy is per-sandbox and only spawned when the provider
  // is Ollama, so this guard scopes only `killStaleProxy()`. GPU unload is
  // handled separately by `cleanupSandboxServices` above (which routes
  // through `stopAll()` or directly into `unloadOllamaModels()` based on
  // whether host services are being torn down).
  if (sb?.provider?.includes("ollama")) {
    const { killStaleProxy } = require("../../inference/ollama/proxy");
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
  removeShieldsState(sandboxName);
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
    const shouldCleanupGateway = await resolveCleanupGatewayDecision(normalized);
    if (shouldCleanupGateway) {
      cleanupGatewayAfterLastSandbox();
    } else {
      const gatewayRemovalHint =
        process.platform === "linux"
          ? `openshell gateway remove ${NEMOCLAW_GATEWAY_NAME}`
          : `openshell gateway destroy -g ${NEMOCLAW_GATEWAY_NAME}`;
      console.log(
        `  Shared NemoClaw gateway preserved. Re-run '${gatewayRemovalHint}' to remove it,`,
      );
      console.log(
        `  or pass '--cleanup-gateway' / set NEMOCLAW_CLEANUP_GATEWAY=1 next time. (#2166)`,
      );
    }
  }
  if (alreadyGone) {
    console.log(`  Sandbox '${sandboxName}' was already absent from the live gateway.`);
  }
  console.log(`  ${G}✓${R} Sandbox '${sandboxName}' destroyed`);
}
