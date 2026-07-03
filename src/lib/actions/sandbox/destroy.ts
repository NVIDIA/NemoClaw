// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { CLI_NAME } from "../../cli/branding";
import { G, R, YW } from "../../cli/terminal-style";
import { prompt as askPrompt } from "../../credentials/store";
import {
  type DestroySandboxOptions,
  normalizeDestroySandboxOptions,
} from "../../domain/lifecycle/options";
import {
  getSandboxDeleteOutcome,
  shouldCleanupGatewayAfterDestroy,
  shouldStopHostServicesAfterDestroy,
} from "../../domain/sandbox/destroy";
import {
  emitProviderDetachResidualHint,
  runSandboxProviderPreDeleteCleanup,
  SANDBOX_PROVIDER_SUFFIXES,
} from "../../onboard/sandbox-provider-cleanup";
import { parseLiveSandboxNames } from "../../runtime-recovery";
import { redact } from "../../security/redact";
import { withTimerBoundShieldsMutationLock } from "../../shields/timer-bound-lock";
import { killTimer as defaultKillShieldsTimer, readTimerMarker } from "../../shields/timer-control";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import { resolveNemoclawStateDir } from "../../state/paths";
import * as registry from "../../state/registry";
import {
  createSystemDeps as createSessionDeps,
  getActiveSandboxSessions,
} from "../../state/sandbox-session";
import {
  cleanupGatewayAfterLastSandbox,
  type DestroyRunOpenshell,
  selectGatewayForSandboxDestroy,
} from "./destroy-gateway";
import { getSandboxTargetGatewayName } from "./gateway-target";
import { type WipeSandboxStateDeps, wipeSandboxState } from "./wipe-state";

type DockerRmi = (tag: string, opts?: { ignoreError?: boolean }) => { status: number | null };

type RemoveSandboxImageDeps = {
  getSandbox?: typeof registry.getSandbox;
  dockerRmi?: DockerRmi;
};

type RemoveSandboxRegistryEntryDeps = {
  removeImage?: (sandboxName: string) => void;
  removeSandbox?: typeof registry.removeSandbox;
};

type RunOpenshell = (args: string[], opts?: Record<string, unknown>) => { status: number | null };

export type CleanupSandboxServicesDeps = {
  getSandbox?: typeof registry.getSandbox;
  stopAll?: (opts: { sandboxName: string }) => void;
  unloadOllamaModels?: () => void;
  runOpenshell?: RunOpenshell;
  rmSync?: typeof fs.rmSync;
};

type ShieldsTimerNeutralizeResult = {
  warnings?: string[];
};

type CleanupShieldsDestroyArtifactsDeps = {
  killShieldsTimer?: (sandboxName: string) => ShieldsTimerNeutralizeResult | void;
  rmSync?: typeof fs.rmSync;
  stateDir?: string;
  warn?: (message: string) => void;
};

type RemoveShieldsStateDeps = {
  rmSync?: typeof fs.rmSync;
  warn?: (message: string) => void;
};

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
async function resolveCleanupGatewayDecision(options: DestroySandboxOptions): Promise<boolean> {
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
      const services = require("../../tunnel/services") as {
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
    // see src/lib/tunnel/services.ts. Don't double-call here.
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
    rmSync(`/tmp/nemoclaw-services-${sandboxName}`, {
      recursive: true,
      force: true,
    });
  } catch {
    // PID directory may not exist — ignore.
  }

  // Delete every per-sandbox messaging and search provider created during
  // onboard. Suppress stderr so "! Provider not found" noise doesn't appear
  // when messaging was never configured. The suffix set is shared with the
  // onboard rebuild path's pre-delete detach via
  // `src/lib/onboard/sandbox-provider-cleanup.ts` so the two paths can't
  // drift on which providers count as per-sandbox state.
  for (const suffix of SANDBOX_PROVIDER_SUFFIXES) {
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
  stateDir = resolveNemoclawStateDir(),
  deps: RemoveShieldsStateDeps = {},
): void {
  const rmSync = deps.rmSync ?? fs.rmSync;
  const warn = deps.warn ?? ((message: string) => console.warn(`  ${YW}⚠${R} ${message}`));
  const resolvedStateDir = path.resolve(stateDir);
  for (const prefix of ["shields-", "shields-timer-"]) {
    const filePath = path.resolve(resolvedStateDir, `${prefix}${sandboxName}.json`);
    if (!filePath.startsWith(`${resolvedStateDir}${path.sep}`)) {
      // Defense-in-depth: sandbox names are validated to [a-z0-9-] at
      // all entry points, but reject traversal attempts just in case.
      continue;
    }
    try {
      rmSync(filePath, { force: true });
    } catch (error) {
      // force: true already suppresses ENOENT; warn on real failures
      // (e.g. EPERM) so stale state doesn't silently survive.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const message = error instanceof Error ? error.message : String(error);
        warn(`Failed to remove shields cleanup artifact '${filePath}': ${message}`);
      }
    }
  }
}

/**
 * Remove the host-side Docker image that was built for a sandbox during onboard.
 * Must be called before registry.removeSandbox() since the imageTag is stored there.
 */
export function removeSandboxImage(sandboxName: string, deps: RemoveSandboxImageDeps = {}): void {
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

function defaultDestroyWarn(message: string): void {
  console.warn(`  ${YW}⚠${R} ${message}`);
}

export function cleanupShieldsDestroyArtifacts(
  sandboxName: string,
  deps: CleanupShieldsDestroyArtifactsDeps = {},
): void {
  const killShieldsTimer = deps.killShieldsTimer ?? defaultKillShieldsTimer;
  const stateDir = deps.stateDir ?? resolveNemoclawStateDir();
  const warn = deps.warn ?? defaultDestroyWarn;

  const timerResult = killShieldsTimer(sandboxName);
  for (const warning of timerResult?.warnings ?? []) {
    warn(warning);
  }

  removeShieldsState(sandboxName, stateDir, {
    rmSync: deps.rmSync ?? fs.rmSync,
    warn,
  });
}

export type { WipeSandboxStateDeps };
// Re-export so existing callers (tests, downstream code) keep working after
// the wipe was extracted out of the destroy monolith (#5455 PRA-2).
export { wipeSandboxState };

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
    runOpenshell: DestroyRunOpenshell;
  };
  // Capture and select the sandbox's gateway before any destructive OpenShell
  // operation. Provider cleanup and sandbox delete must address the gateway
  // recorded for this sandbox, not whichever gateway happens to be active.
  const cleanupGatewayName = getSandboxTargetGatewayName(sandboxName);
  selectGatewayForSandboxDestroy(sandboxName, cleanupGatewayName, runOpenshell);

  const destructiveResult = withTimerBoundShieldsMutationLock(
    sandboxName,
    "destroy sandbox",
    () => {
      // Wipe persistent state AFTER the gateway is selected so the exec targets
      // the sandbox's recorded gateway (#5455 PRA-5), but BEFORE delete because
      // `sandbox delete` unmounts the PVC and `rm -rf` could no longer reach it.
      // Hold the same lock used by the auto-restore timer through wipe, provider
      // detach, and delete. A timer that is already restoring finishes first;
      // a waiting timer cannot mutate this sandbox or a same-name replacement.
      wipeSandboxState(sandboxName);

      // The wipe needs the timed mutable posture so the sandbox user can
      // remove manifest state. Convert it back to a verified locked posture
      // immediately afterward and before delete. The outer owner carries the
      // timer takeover token throughout, so a deadline/crash during the wipe
      // can still reclaim it; after shieldsUp succeeds, delete failure or
      // process death leaves a surviving sandbox hardened.
      if (readTimerMarker(sandboxName)) {
        const { shieldsUp: hardenShields } =
          require("../../shields") as typeof import("../../shields");
        hardenShields(sandboxName, {
          throwOnError: true,
          allowLegacyHermesProtocol: true,
        });
      }

      const lockedDetachOutcome = runSandboxProviderPreDeleteCleanup(sandboxName, {
        runOpenshell,
        redact,
      });
      const lockedDeleteResult = runOpenshell(["sandbox", "delete", sandboxName], {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const {
        output: deleteOutput,
        alreadyGone: lockedAlreadyGone,
        gatewayUnreachable,
      } = getSandboxDeleteOutcome(lockedDeleteResult);

      // When the OpenShell gateway is down, every gateway call (including the
      // final delete) gets a connection-refused/transport error. That used to
      // abort destroy with no bypass, leaving no supported way to remove the
      // sandbox record (#6046). Under --force, fall back to local cleanup;
      // otherwise keep failing but point at the recovery paths.
      const forcedLocalCleanup =
        lockedDeleteResult.status !== 0 &&
        !lockedAlreadyGone &&
        gatewayUnreachable &&
        normalized.force === true;

      if (lockedDeleteResult.status !== 0 && !lockedAlreadyGone && !forcedLocalCleanup) {
        // Any active timer was cleared only after shieldsUp verified the live
        // sandbox was hardened. Preserve that locked state on delete failure;
        // do not remove its local shields record as if deletion had succeeded.
        return {
          ok: false as const,
          deleteOutput,
          gatewayUnreachable,
          exitCode: lockedDeleteResult.status || 1,
        };
      }

      // Either the live sandbox is confirmed gone, or --force is discarding the
      // local record for an unreachable gateway. In both cases the sandbox is
      // no longer tracked locally, so revoke the timer and local shields state
      // before releasing the lock so neither can target a subsequently created
      // sandbox with the same name.
      cleanupShieldsDestroyArtifacts(sandboxName);
      return {
        ok: true as const,
        detachOutcome: lockedDetachOutcome,
        deleteResult: lockedDeleteResult,
        alreadyGone: lockedAlreadyGone,
        forcedLocalCleanup,
        deleteOutput,
      };
    },
  );
  if (!destructiveResult.ok) {
    if (destructiveResult.deleteOutput) {
      console.error(`  ${destructiveResult.deleteOutput}`);
    }
    console.error(`  Failed to destroy sandbox '${sandboxName}'.`);
    if (destructiveResult.gatewayUnreachable) {
      console.error(
        `  The OpenShell gateway is unreachable. Start it (run '${CLI_NAME} ${sandboxName} status'),`,
      );
      console.error(
        `  or re-run with --force to remove the local sandbox record without the gateway.`,
      );
    }
    process.exit(destructiveResult.exitCode);
  }
  const { detachOutcome, deleteResult, alreadyGone, forcedLocalCleanup, deleteOutput } =
    destructiveResult;

  if (forcedLocalCleanup) {
    if (deleteOutput) {
      console.error(`  ${deleteOutput}`);
    }
    console.warn(
      `  ${YW}⚠${R} OpenShell gateway unreachable; removing the local record for '${sandboxName}' (--force).`,
    );
    console.warn(
      `  ${YW}⚠${R} If the gateway comes back, the sandbox may still exist — re-run destroy or remove it via openshell.`,
    );
  }

  // Forced local cleanup removes the registry entry/local artifacts but cannot
  // confirm the gateway-side delete, so it must not trigger shared host-service
  // or gateway teardown: the sandbox may still exist on the (unreachable)
  // gateway. Gate that teardown on the *confirmed* delete state only — never on
  // forcedLocalCleanup — so a forced cleanup of the last registered sandbox does
  // not shut down services for a sandbox we never confirmed deleted (#6046).
  const deleteSucceededOrAlreadyGone = deleteResult.status === 0 || alreadyGone;
  const shouldStopHostServices = shouldStopHostServicesAfterDestroy({
    deleteSucceededOrAlreadyGone,
    registeredSandboxCount: registry.listSandboxes().sandboxes.length,
    sandboxStillRegistered: !!registry.getSandbox(sandboxName),
  });

  cleanupSandboxServices(sandboxName, {
    stopHostServices: shouldStopHostServices,
  });
  // The sandbox's gateway was captured before the registry entry is removed —
  // post-removal lookups return null and would collapse the cleanup target
  // back to the default gateway.
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
      cleanupGatewayAfterLastSandbox(cleanupGatewayName, runOpenshell);
    } else {
      const gatewayRemovalHint =
        process.platform === "linux"
          ? `openshell gateway remove ${cleanupGatewayName}`
          : `openshell gateway destroy -g ${cleanupGatewayName}`;
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
  emitProviderDetachResidualHint(sandboxName, detachOutcome.failures, (m) =>
    console.warn(`  ${YW}⚠${R}${m}`),
  );
  console.log(`  ${G}✓${R} Sandbox '${sandboxName}' destroyed`);
}
