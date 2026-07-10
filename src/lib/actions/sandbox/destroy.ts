// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../../adapters/openshell/timeouts";
import { CLI_NAME } from "../../cli/branding";
import { G, R, YW } from "../../cli/terminal-style";
import { prompt as askPrompt } from "../../credentials/store";
import {
  type DestroySandboxOptions,
  normalizeDestroySandboxOptions,
} from "../../domain/lifecycle/options";
import {
  shouldCleanupGatewayAfterDestroy,
  shouldStopHostServicesAfterDestroy,
} from "../../domain/sandbox/destroy";
import {
  emitProviderDetachResidualHint,
  SANDBOX_PROVIDER_SUFFIXES,
} from "../../onboard/sandbox-provider-cleanup";
import { validateName } from "../../runner";
import { parseLiveSandboxNames } from "../../runtime-recovery";
import { killTimer as defaultKillShieldsTimer } from "../../shields/timer-control";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import { resolveNemoclawStateDir } from "../../state/paths";
import * as registry from "../../state/registry";
import { confirmSandboxDestroy } from "./destroy-confirmation";
import { executeSandboxDestroy } from "./destroy-execution";
import { cleanupGatewayAfterLastSandbox } from "./destroy-gateway";
import { prepareSandboxDestroy } from "./destroy-preflight";
import { type WipeSandboxStateDeps, wipeSandboxState } from "./wipe-state";

export { classifyDestroySandboxPresence } from "./destroy-presence";

type DockerRmi = (tag: string, opts?: { ignoreError?: boolean }) => { status: number | null };

type RemoveSandboxImageDeps = {
  getSandbox?: typeof registry.getSandbox;
  dockerRmi?: DockerRmi;
};

type RemoveSandboxRegistryEntryDeps = {
  removeImage?: (sandboxName: string) => void;
  removeSandbox?: typeof registry.removeSandbox;
};

type RemoveSandboxRegistryEntryWithReceiptDeps = {
  removeImage?: (sandboxName: string) => void;
  removeSandboxWithReceipt?: typeof registry.removeSandboxWithReceipt;
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
  // Source boundary: this exported helper can be called independently of CLI
  // dispatch, including from forced local recovery. Validate once before every
  // host and provider cleanup side effect, then derive the PID path from that
  // same RFC 1123 name. Remove only when the helper accepts a validated-name
  // type that cannot be constructed from unchecked input.
  const validatedSandboxName = validateName(sandboxName, "sandbox name");
  const servicesPidDir = path.resolve("/tmp", `nemoclaw-services-${validatedSandboxName}`);
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
    stopAll({ sandboxName: validatedSandboxName });
  } else {
    // No global stop, so `stopAll()` did not run; explicitly free Ollama
    // models for this sandbox if its provider used Ollama. Without this
    // branch a single-sandbox destroy would leave models loaded on the GPU.
    const sb = getSandbox(validatedSandboxName);
    if (sb?.provider?.includes("ollama")) {
      unloadOllamaModels();
    }
  }

  try {
    rmSync(servicesPidDir, {
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
    runOpenshell(["provider", "delete", `${validatedSandboxName}-${suffix}`], {
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

export function removeSandboxRegistryEntryWithReceipt(
  sandboxName: string,
  deps: RemoveSandboxRegistryEntryWithReceiptDeps = {},
): registry.SandboxRemovalReceipt | null {
  const removeImage = deps.removeImage ?? removeSandboxImage;
  const removeSandboxWithReceipt =
    deps.removeSandboxWithReceipt ?? registry.removeSandboxWithReceipt;
  removeImage(sandboxName);
  return removeSandboxWithReceipt(sandboxName);
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
  return withMcpLifecycleLock(sandboxName, () => destroySandboxUnlocked(sandboxName, options));
}

async function destroySandboxUnlocked(
  sandboxName: string,
  options: string[] | DestroySandboxOptions = {},
): Promise<void> {
  const normalized = normalizeDestroySandboxOptions(options);
  if (!(await confirmSandboxDestroy(sandboxName, normalized))) return;

  const { cleanupGatewayName, runOpenshell, sandbox, sandboxConfirmedAbsent } =
    prepareSandboxDestroy(sandboxName);
  const destructiveResult = await executeSandboxDestroy({
    cleanupShieldsArtifacts: cleanupShieldsDestroyArtifacts,
    force: normalized.force === true,
    runOpenshell,
    sandbox,
    sandboxConfirmedAbsent,
    sandboxName,
  });
  if (!destructiveResult.ok) {
    if (destructiveResult.deleteOutput) {
      console.error(`  ${destructiveResult.deleteOutput}`);
    }
    if (destructiveResult.mcpRecoveryFailure) {
      console.error(
        `  Failed to restore MCP runtime state after the sandbox delete failed: ${destructiveResult.mcpRecoveryFailure}`,
      );
      console.error(
        `  MCP definitions and OpenShell providers were preserved; fix the reported cause and retry MCP restart or destroy.`,
      );
    }
    console.error(`  Failed to destroy sandbox '${sandboxName}'.`);
    if (destructiveResult.gatewayUnreachable) {
      if (destructiveResult.mcpOwnershipRequiresGateway) {
        console.error(
          `  The OpenShell gateway is unreachable. Local state was preserved because it contains MCP ownership required for exact provider cleanup.`,
        );
        console.error(
          `  Start the gateway (run '${CLI_NAME} ${sandboxName} status'), then retry destroy; --force cannot safely discard MCP ownership.`,
        );
      } else {
        console.error(
          `  The OpenShell gateway is unreachable. Start it (run '${CLI_NAME} ${sandboxName} status'),`,
        );
        console.error(
          `  or re-run with --force to remove the local sandbox record without the gateway.`,
        );
      }
    }
    process.exit(destructiveResult.exitCode);
  }
  const { detachOutcome, deleteResult, alreadyGone, forcedLocalCleanup, deleteOutput } =
    destructiveResult;

  /**
   * SOURCE_OF_TRUTH
   * Invalid state: the OpenShell gateway is unreachable while a local sandbox
   * record still exists, so a normal destroy cannot confirm remote deletion.
   * Source boundary: destroySandbox -> executeSandboxDestroy -> `openshell
   * sandbox delete`; only an explicit --force and no retained MCP ownership may
   * select forcedLocalCleanup.
   * Source-fix constraint: NemoClaw cannot make an unreachable remote gateway
   * delete or attest the sandbox, so this path discards local state only.
   * Regression proof: destroy-flow.test.ts and the CLI integration test
   * test/cli/destroy-gateway-unreachable.test.ts prove the forced cleanup,
   * registry removal, and preservation of shared host/gateway services.
   * Removal condition: remove this workaround when OpenShell provides an
   * authenticated force-cleanup operation for an unreachable gateway.
   */
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
      // `gateway remove <name>` is the modern OpenShell subcommand on every
      // platform; the old `gateway destroy -g` was pre-0.0.44 only and current
      // OpenShell rejects it as unrecognized, so never recommend it (#6569).
      const gatewayRemovalHint = `openshell gateway remove ${cleanupGatewayName}`;
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
