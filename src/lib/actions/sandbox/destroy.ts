// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { CLI_NAME } from "../../cli/branding";
import { G, R, YW } from "../../cli/terminal-style";
import { prompt as askPrompt } from "../../credentials/store";
import {
  type DestroySandboxOptions,
  normalizeDestroySandboxOptions,
} from "../../domain/lifecycle/options";
import {
  isDestroyNonInteractiveEnv,
  resolveDestroyGatewayCleanupDecision,
  shouldStopHostServicesAfterDestroy,
} from "../../domain/sandbox/destroy";
import { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";
import {
  parseHttpsPinRouteId,
  revokeHttpsPinRuntimeAdapterRoute,
} from "../../inference/https-pin-runtime-adapter";
import { prepareManagedLlamaCppRuntimeCleanupForSandbox } from "../../inference/local-model-profile/cleanup";
import {
  isLocalOllamaRouteOwner,
  loadPersistedOllamaHost,
  type OllamaUnloadResult,
  withOllamaModelOwnershipTransaction,
} from "../../inference/ollama/proxy";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  normalizeRuntimeProviderIdentity,
  type RuntimeProviderBundleRegistry,
  type RuntimeProviderWorkloadCleanupResult,
  requireRuntimeProviderDestructiveCleanupAuthority,
} from "../../onboard/runtime-provider/access";
import {
  emitProviderDetachResidualHint,
  removeManagedAgentStateVolumes,
  SANDBOX_PROVIDER_SUFFIXES,
} from "../../onboard/sandbox-provider-cleanup";
import { validateName } from "../../runner";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import {
  enforceRemovedImmutabilityMigrationBoundary,
  retireRemovedImmutabilityStateRecord,
} from "../../state/migrations/removed-immutability";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import {
  assertSandboxDestroyCommandAvailable,
  confirmSandboxDestroy,
} from "./destroy-confirmation";
import {
  executeSandboxDestroy,
  preparePortableDemoSandboxDestroyAuthority,
  redactDestroyError,
  retirePortableLifecycleAuthority,
} from "./destroy-execution";
import { cleanupGatewayAfterLastSandbox } from "./destroy-gateway";
import { shouldCleanupGatewayAfterConfirmedFinalDestroy } from "./destroy-gateway-cleanup";
import {
  assertUnambiguousDestroyContainerIdentity,
  classifyDestroyContainerIdentity,
  classifyDestroySandboxPresence,
  isSameDestroyContainerIdentityProof,
  observeDestroyContainerIdentity,
} from "./destroy-presence";
import {
  prepareSandboxDestroy,
  stopModelRouterForDestroyedSandbox,
  stopSandboxInferenceResources,
  teardownSandboxDashboardForward,
} from "./destroy-preflight";
import { type WipeSandboxStateDeps, wipeSandboxState } from "./wipe-state";

export { assertUnambiguousDestroyContainerIdentity, classifyDestroySandboxPresence };

type RemoveSandboxImageDeps = {
  getSandbox?: typeof registry.getSandbox;
  runtimeProviders?: RuntimeProviderBundleRegistry;
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

type RemoveSandboxRegistryEntryDeps = {
  removeImage?: (sandboxName: string) => RuntimeProviderWorkloadCleanupResult | void;
  removeSandbox?: typeof registry.removeSandbox;
};

type RemoveSandboxRegistryEntryWithReceiptDeps = {
  removeImage?: (sandboxName: string) => RuntimeProviderWorkloadCleanupResult | void;
  removeSandboxWithReceipt?: typeof registry.removeSandboxWithReceipt;
};

function selectRetainedSandboxRecoveryAuthority(
  sandboxName: string,
  sandbox: registry.SandboxEntry | null,
  records: readonly onboardSession.RetainedSandboxRecoveryRecord[],
): onboardSession.RetainedSandboxRecoveryRecord | null {
  const candidates = records.filter(
    (record) => record.sandboxName === sandboxName && record.sandboxIdentityFingerprint !== null,
  );
  if (!sandbox) {
    // Once resource cleanup has removed the registry row, a retry must still
    // select the lone durable record so the later Docker proof can confirm
    // absence and retire it. Multiple records continue to require immutable
    // Docker evidence so the mutable name never chooses between authorities.
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length === 0) return null;
    const observation = observeDestroyContainerIdentity(sandboxName);
    const observedMatches = candidates.filter((record) => {
      const verdict = classifyDestroyContainerIdentity(
        sandboxName,
        observation,
        record.sandboxIdentityFingerprint!,
      );
      return (
        verdict.status === "recovery" || (verdict.status === "clear" && verdict.identity !== null)
      );
    });
    return observedMatches.length === 1 ? observedMatches[0]! : null;
  }

  const matchesRegistryAuthority = (
    record: onboardSession.RetainedSandboxRecoveryRecord,
  ): boolean => {
    const pending = sandbox.pendingCreateIdentity;
    if (pending) {
      return (
        record.gatewayName === pending.gatewayName &&
        record.gatewayPort === pending.gatewayPort &&
        record.lifecycleGeneration === pending.lifecycleGeneration &&
        record.sandboxIdentityFingerprint === pending.sandboxIdentityFingerprint &&
        (pending.createAttemptNonce === undefined ||
          record.createAttemptNonce === pending.createAttemptNonce)
      );
    }
    return (
      record.gatewayName === sandbox.gatewayName &&
      record.gatewayPort === sandbox.gatewayPort &&
      record.lifecycleGeneration === sandbox.lifecycleGeneration &&
      record.sandboxIdentityFingerprint === sandbox.lifecycleLiveIdentityFingerprint
    );
  };
  const matching = candidates.filter(matchesRegistryAuthority);
  return matching.length === 1 ? matching[0]! : null;
}

export type RemoveSandboxRegistryEntryOutcome =
  | {
      readonly status: "complete";
      readonly removed: true;
    }
  | {
      readonly status: "not-found";
      readonly removed: false;
    }
  | {
      readonly status: "blocked";
      readonly reason: "authority-unproven";
      readonly removed: false;
    };

export function requireSandboxDestructiveCleanupAuthority(
  sandboxName: string,
  sandbox: registry.SandboxEntry,
  providers: RuntimeProviderBundleRegistry = CURRENT_RUNTIME_PROVIDER_BUNDLES,
) {
  return requireRuntimeProviderDestructiveCleanupAuthority(sandboxName, sandbox, providers);
}

type RunOpenshell = (args: string[], opts?: Record<string, unknown>) => { status: number | null };

export type CleanupSandboxServicesDeps = {
  getSandbox?: typeof registry.getSandbox;
  listSandboxes?: typeof registry.listSandboxes;
  stopAll?: (opts: {
    sandboxName: string;
    cleanupOllamaModels?: boolean;
    unloadOllamaModels?: () => OllamaUnloadResult | void;
  }) => OllamaUnloadResult | void;
  unloadOllamaModels?: (onlyModels?: readonly string[]) => OllamaUnloadResult | void;
  loadPendingOllamaModelCleanup?: (sandboxName: string) => readonly string[];
  clearPendingOllamaModelCleanup?: (
    sandboxName: string,
    releasedModels?: readonly string[],
  ) => void;
  loadPersistedOllamaHost?: () => "127.0.0.1" | "host.docker.internal" | null;
  withOllamaModelOwnershipLock?: <T>(operation: () => T) => T;
  ollamaModelRefsMatch?: (left: string, right: string) => boolean;
  runOpenshell?: RunOpenshell;
  rmSync?: typeof fs.rmSync;
  stopGooglechatWebhookTunnel?: (sandboxName: string) => string;
  googlechatWebhookTunnelPidDir?: (servicePidDir: string) => string;
};

async function resolveCleanupGatewayDecision(options: DestroySandboxOptions): Promise<boolean> {
  const decision = resolveDestroyGatewayCleanupDecision(options, {
    nonInteractive: isDestroyNonInteractiveEnv(),
    platform: process.platform,
  });
  if (decision === "cleanup") return true;
  if (decision === "preserve") return false;

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

export function cleanupSandboxServices(
  sandboxName: string,
  { stopHostServices = false }: { stopHostServices?: boolean } = {},
  deps: CleanupSandboxServicesDeps = {},
): void {
  // Source boundary: this exported helper can be called independently of CLI
  // dispatch, including from forced local recovery. Validate once before every
  // host and provider cleanup side effect, then derive the PID path from that
  // same canonical OpenShell-compatible name. Remove only when the helper
  // accepts a validated-name type that cannot be constructed from unchecked
  // input.
  const validatedSandboxName = validateName(sandboxName, "sandbox name");
  const servicesPidDir = path.resolve("/tmp", `nemoclaw-services-${validatedSandboxName}`);
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const listSandboxes = deps.listSandboxes ?? registry.listSandboxes;
  const stopAll =
    deps.stopAll ??
    ((opts: {
      sandboxName: string;
      cleanupOllamaModels?: boolean;
      unloadOllamaModels?: () => OllamaUnloadResult | void;
    }) => {
      const services = require("../../tunnel/services") as {
        stopAll: (opts: {
          sandboxName: string;
          cleanupOllamaModels?: boolean;
          unloadOllamaModels?: () => OllamaUnloadResult | void;
        }) => OllamaUnloadResult | void;
      };
      return services.stopAll(opts);
    });
  const unloadOllamaModels =
    deps.unloadOllamaModels ??
    ((onlyModels?: readonly string[]) => {
      const { unloadOllamaModels: unload } = require("../../inference/ollama/proxy") as {
        unloadOllamaModels: (onlyModels?: readonly string[]) => OllamaUnloadResult;
      };
      return unload(onlyModels);
    });
  const loadPendingOllamaModelCleanup =
    deps.loadPendingOllamaModelCleanup ??
    ((name: string) => {
      const local = require("../../inference/ollama/proxy") as {
        loadPendingOllamaModelCleanup(sandboxName: string): readonly string[];
      };
      return local.loadPendingOllamaModelCleanup(name);
    });
  const clearPendingOllamaModelCleanup =
    deps.clearPendingOllamaModelCleanup ??
    ((name: string, releasedModels?: readonly string[]) => {
      const local = require("../../inference/ollama/proxy") as {
        clearPendingOllamaModelCleanup(sandboxName: string, models?: readonly string[]): void;
      };
      local.clearPendingOllamaModelCleanup(name, releasedModels);
    });
  const loadPersistedOllamaHost =
    deps.loadPersistedOllamaHost ??
    (require("../../inference/local") as typeof import("../../inference/local"))
      .loadPersistedOllamaHost;
  const withOllamaModelOwnershipLock =
    deps.withOllamaModelOwnershipLock ??
    (<T>(operation: () => T): T => {
      const proxy = require("../../inference/ollama/proxy") as {
        withOllamaModelOwnershipLock<T>(operation: () => T): T;
      };
      return proxy.withOllamaModelOwnershipLock(operation);
    });
  const ollamaModelRefsMatch =
    deps.ollamaModelRefsMatch ??
    ((left: string, right: string) => {
      const proxy = require("../../inference/ollama/proxy") as {
        ollamaModelRefsMatch(leftModel: string, rightModel: string): boolean;
      };
      return proxy.ollamaModelRefsMatch(left, right);
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
  const stopGooglechatWebhookTunnel =
    deps.stopGooglechatWebhookTunnel ??
    ((name: string) => {
      const lifecycle =
        require("../../messaging/channels/googlechat/tunnel/lifecycle") as typeof import("../../messaging/channels/googlechat/tunnel/lifecycle");
      const services = require("../../tunnel/services") as Parameters<
        typeof lifecycle.stopGooglechatWebhookTunnel
      >[1]["services"];
      const webhookProxy =
        require("../../messaging/channels/googlechat/tunnel/proxy") as Parameters<
          typeof lifecycle.stopGooglechatWebhookTunnel
        >[1]["webhookProxy"];
      return lifecycle.stopGooglechatWebhookTunnel(name, { services, webhookProxy });
    });
  const googlechatWebhookTunnelPidDir =
    deps.googlechatWebhookTunnelPidDir ??
    ((servicePidDir: string) => {
      const lifecycle =
        require("../../messaging/channels/googlechat/tunnel/lifecycle") as typeof import("../../messaging/channels/googlechat/tunnel/lifecycle");
      return lifecycle.googlechatWebhookTunnelPidDir(servicePidDir);
    });

  const googlechatServicesPidDir = googlechatWebhookTunnelPidDir(servicesPidDir);
  try {
    stopGooglechatWebhookTunnel(validatedSandboxName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  ${YW}⚠${R} Failed to stop Google Chat webhook tunnel: ${message}`);
    console.warn(
      `  ${YW}⚠${R} Keeping ${googlechatServicesPidDir} so a repeated destroy can stop the` +
        " orphaned cloudflared and webhook-proxy processes recorded there.",
    );
    throw new Error(
      "Refusing to finish sandbox cleanup while its public Google Chat webhook endpoint may still be running. Retry destroy after fixing the tunnel-stop failure.",
      { cause: error },
    );
  }

  let ollamaCleanup: OllamaUnloadResult | void = undefined;
  if (stopHostServices) {
    // `stopAll()` owns the host-wide unload when this sandbox has an Ollama
    // route or retained cleanup work. Don't probe an unrelated daemon for a
    // sandbox with no Ollama ownership, and don't double-call cleanup here.
    try {
      ollamaCleanup = withOllamaModelOwnershipLock(() => {
        const sandbox = getSandbox(validatedSandboxName);
        const pending = loadPendingOllamaModelCleanup(validatedSandboxName);
        const selectedHost = loadPersistedOllamaHost();
        const cleanupOllamaModels = Boolean(
          (sandbox && isLocalOllamaRouteOwner(sandbox, selectedHost)) || pending.length > 0,
        );
        return stopAll({
          sandboxName: validatedSandboxName,
          cleanupOllamaModels,
          unloadOllamaModels: () => unloadOllamaModels(),
        });
      });
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      throw new Error(
        `Host-service cleanup failed after sandbox '${validatedSandboxName}' was deleted: ${detail || "unknown error"}. ` +
          `The local registry and cleanup state for '${validatedSandboxName}' were retained for recovery; ` +
          `restore the reported dependency, then retry \`nemoclaw ${validatedSandboxName} destroy\`.`,
        { cause: error },
      );
    }
  } else {
    // No global stop, so `stopAll()` did not run; explicitly free Ollama
    // models for this sandbox if its provider used Ollama. Without this
    // branch a single-sandbox destroy would leave models loaded on the GPU.
    withOllamaModelOwnershipLock(() => {
      const sb = getSandbox(validatedSandboxName);
      const selectedHost = loadPersistedOllamaHost();
      const peers = listSandboxes().sandboxes.filter(
        (candidate) =>
          candidate.name !== validatedSandboxName &&
          isLocalOllamaRouteOwner(candidate, selectedHost),
      );
      const pending = loadPendingOllamaModelCleanup(validatedSandboxName);
      const currentModel = String(sb?.model ?? "").trim();
      const candidates = [
        ...pending,
        ...(sb && isLocalOllamaRouteOwner(sb, selectedHost) && currentModel ? [currentModel] : []),
      ].filter(
        (model, index, models) =>
          models.findIndex((candidate) => ollamaModelRefsMatch(candidate, model)) === index &&
          !peers.some(
            (candidate) => candidate.model && ollamaModelRefsMatch(model, candidate.model),
          ),
      );
      if (candidates.length === 0) return;
      ollamaCleanup = unloadOllamaModels(candidates);
      if (!ollamaCleanup || ollamaCleanup.ok) {
        clearPendingOllamaModelCleanup(validatedSandboxName, candidates);
      }
    });
  }
  if (ollamaCleanup && !ollamaCleanup.ok) {
    const recoveryAction =
      ollamaCleanup.outcome === "discovery-failed"
        ? `restore access to ${ollamaCleanup.endpoint}`
        : ollamaCleanup.outcome === "still-resident"
          ? `stop the recorded model at ${ollamaCleanup.endpoint}`
          : `allow the model unload request at ${ollamaCleanup.endpoint}`;
    throw new Error(
      `Ollama model cleanup failed at ${ollamaCleanup.endpoint} (${ollamaCleanup.outcome}: ${ollamaCleanup.message ?? "no detail"}). ` +
        `The sandbox registry and saved route were retained; ${recoveryAction}, then retry destroy.`,
    );
  }

  try {
    rmSync(servicesPidDir, {
      recursive: true,
      force: true,
    });
  } catch {
    // PID directory may not exist — ignore.
  }
  try {
    rmSync(googlechatServicesPidDir, {
      recursive: true,
      force: true,
    });
  } catch {
    // Dedicated Google Chat service directory may not exist — ignore.
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
 * Remove only a provider-owned per-sandbox workload image. Shared managed
 * cohorts and ambiguous ownership are never deleted.
 * Must be called before registry.removeSandbox() since the imageTag is stored there.
 */
export function removeSandboxImage(
  sandboxName: string,
  deps: RemoveSandboxImageDeps = {},
): RuntimeProviderWorkloadCleanupResult {
  const getSandbox = deps.getSandbox ?? registry.getSandbox;
  const sb = getSandbox(sandboxName);
  if (!sb) return { status: "skipped", reason: "no-owned-image" };
  const providerId = normalizeRuntimeProviderIdentity(sb.openshellDriver);
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  let result: RuntimeProviderWorkloadCleanupResult;
  try {
    const authority = requireSandboxDestructiveCleanupAuthority(
      sandboxName,
      sb,
      deps.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
    );
    result = authority.provider.cleanup.removeOwnedWorkload({ sandbox: sb, sandboxName });
  } catch (error) {
    const detail = redactDestroyError(error);
    warn(
      `  ${YW}⚠${R} Runtime provider '${providerId}' could not prove workload cleanup ` +
        `authority: ${detail} Local ownership state was preserved. Run '${CLI_NAME} ` +
        `${sandboxName} doctor --json'; restore trusted ownership metadata or resolve the ` +
        "runtime conflict, then retry. Do not rewrite a receipt to match a mutable name.",
    );
    return { status: "skipped", reason: "authority-unproven" };
  }
  if (result.status === "removed") {
    log(`  Removed ${result.engineDisplayName} image ${result.reference}`);
  } else if (result.status === "failed") {
    warn(
      `  ${YW}⚠${R} Failed to remove ${result.engineDisplayName} image ${result.reference}; ` +
        `run '${CLI_NAME} gc' to clean up.`,
    );
  } else if (result.reason === "authority-unproven") {
    warn(
      `  ${YW}⚠${R} Runtime provider '${providerId}' did not prove ownership of the ` +
        `recorded workload image. Local ownership state was preserved. Run '${CLI_NAME} ` +
        `${sandboxName} doctor --json'; restore trusted ownership metadata or resolve the ` +
        "runtime conflict, then retry. Do not rewrite a receipt to match a mutable name.",
    );
  }
  return result;
}

export function removeSandboxRegistryEntryOutcome(
  sandboxName: string,
  deps: RemoveSandboxRegistryEntryDeps = {},
): RemoveSandboxRegistryEntryOutcome {
  const removeImage = deps.removeImage ?? removeSandboxImage;
  const removeSandbox = deps.removeSandbox ?? registry.removeSandbox;
  const imageResult = removeImage(sandboxName);
  if (imageResult?.status === "skipped" && imageResult.reason === "authority-unproven") {
    return { status: "blocked", reason: "authority-unproven", removed: false };
  }
  return removeSandbox(sandboxName)
    ? { status: "complete", removed: true }
    : { status: "not-found", removed: false };
}

export function removeSandboxRegistryEntry(
  sandboxName: string,
  deps: RemoveSandboxRegistryEntryDeps = {},
): boolean {
  return removeSandboxRegistryEntryOutcome(sandboxName, deps).removed;
}

export function removeSandboxRegistryEntryWithReceipt(
  sandboxName: string,
  deps: RemoveSandboxRegistryEntryWithReceiptDeps = {},
): registry.SandboxRemovalReceipt | null {
  const removeImage = deps.removeImage ?? removeSandboxImage;
  const removeSandboxWithReceipt =
    deps.removeSandboxWithReceipt ?? registry.removeSandboxWithReceipt;
  const imageResult = removeImage(sandboxName);
  if (imageResult?.status === "skipped" && imageResult.reason === "authority-unproven") {
    return null;
  }
  return removeSandboxWithReceipt(sandboxName);
}

function defaultDestroyWarn(message: string): void {
  console.warn(`  ${YW}⚠${R} ${message}`);
}

export async function revokeDestroyedSandboxHttpsPinRoute(
  gatewayName: string,
  routeId: string,
  deps: {
    listSandboxes?: typeof registry.listSandboxes;
    revokeRoute?: typeof revokeHttpsPinRuntimeAdapterRoute;
    warn?: (message: string) => void;
    withGatewayRouteMutationLock?: typeof withGatewayRouteMutationLock;
  } = {},
): Promise<void> {
  const listSandboxes = deps.listSandboxes ?? registry.listSandboxes;
  const revokeRoute = deps.revokeRoute ?? revokeHttpsPinRuntimeAdapterRoute;
  const warn = deps.warn ?? defaultDestroyWarn;
  const withRouteMutationLock = deps.withGatewayRouteMutationLock ?? withGatewayRouteMutationLock;
  try {
    await withRouteMutationLock(gatewayName, async () => {
      // The peer scan and DELETE are one critical section with inference-set's
      // route PUT + registry commit. Otherwise a peer can register the route,
      // pause before its registry write, and have destroy revoke its live route.
      const stillReferenced = listSandboxes().sandboxes.some(
        (entry) => parseHttpsPinRouteId(entry.endpointUrl) === routeId,
      );
      if (stillReferenced) return;
      const revoked = await revokeRoute(routeId);
      if (!revoked) throw new Error("the adapter did not confirm route revocation");
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(
      `Sandbox deletion succeeded, but its superseded HTTPS Pin Runtime route '${routeId}' ` +
        `could not be revoked: ${detail}. Uninstall NemoClaw after all sandboxes are removed ` +
        `to stop the adapter and purge its in-memory credentials.`,
    );
  }
}

export type { WipeSandboxStateDeps };
// Re-export so existing callers (tests, downstream code) keep working after
// the wipe was extracted out of the destroy monolith (#5455 PRA-2).
export { wipeSandboxState };

class SandboxDestroyExitRequest extends Error {
  constructor(readonly exitCode: number) {
    super(`Sandbox destroy requested exit ${String(exitCode)}`);
    this.name = "SandboxDestroyExitRequest";
  }
}

function requestSandboxDestroyExit(exitCode: number): never {
  throw new SandboxDestroyExitRequest(exitCode);
}

export async function destroySandbox(
  sandboxName: string,
  options: string[] | DestroySandboxOptions = {},
): Promise<void> {
  try {
    return await withMcpLifecycleLock(sandboxName, () => {
      const removedImmutabilityMigration = enforceRemovedImmutabilityMigrationBoundary(
        sandboxName,
        { allowStateRecord: true },
      );
      assertSandboxDestroyCommandAvailable(sandboxName);
      return destroySandboxUnlocked(
        sandboxName,
        options,
        removedImmutabilityMigration.stateRecord !== null,
      );
    });
  } catch (error) {
    if (error instanceof SandboxDestroyExitRequest) process.exit(error.exitCode);
    throw error;
  }
}

async function destroySandboxUnlocked(
  sandboxName: string,
  options: string[] | DestroySandboxOptions = {},
  retireRemovedImmutabilityState = false,
): Promise<void> {
  const normalized = normalizeDestroySandboxOptions(options);
  if (!(await confirmSandboxDestroy(sandboxName, normalized))) return;
  const destroySession = onboardSession.loadSession();
  const registeredSandbox = registry.getSandbox(sandboxName);
  const retainedRecoveryRecords = onboardSession.listRetainedSandboxRecoveryRecords();
  const retainedRecoveryAuthority = selectRetainedSandboxRecoveryAuthority(
    sandboxName,
    registeredSandbox,
    retainedRecoveryRecords,
  );
  if (
    !retainedRecoveryAuthority &&
    retainedRecoveryRecords.some((record) => record.sandboxName === sandboxName)
  ) {
    console.error(
      `  Refusing to destroy retained sandbox '${sandboxName}': NemoClaw could not select exactly one recovery record from the current immutable registry and Docker identities. No sandbox resources were removed. Resolve the identity conflict, then rerun '${CLI_NAME} ${sandboxName} destroy'.`,
    );
    requestSandboxDestroyExit(1);
  }
  const retainedSandboxIdentityFingerprint =
    retainedRecoveryAuthority?.sandboxIdentityFingerprint ?? undefined;
  let portableContainerAuthority: ReturnType<typeof preparePortableDemoSandboxDestroyAuthority>;
  try {
    portableContainerAuthority = preparePortableDemoSandboxDestroyAuthority(sandboxName, () => {
      const current = registry.getSandbox(sandboxName);
      return current
        ? {
            agent: current.agent,
            lifecycleGeneration: current.lifecycleGeneration,
            openshellDriver: current.openshellDriver,
          }
        : null;
    });
  } catch (error) {
    throw new Error(
      `Refusing to destroy sandbox '${sandboxName}': NemoClaw could not validate Portable lifecycle authority before the Docker preflight: ${redactDestroyError(error)}. NemoClaw removed no sandbox resources.`,
    );
  }

  const inspectContainerIdentity = () => {
    const registeredSandbox = registry.getSandbox(sandboxName);
    return assertUnambiguousDestroyContainerIdentity(sandboxName, {
      cliName: CLI_NAME,
      providerId: registeredSandbox
        ? normalizeRuntimeProviderIdentity(registeredSandbox.openshellDriver)
        : normalizeRuntimeProviderIdentity(null),
      redact: redactDestroyError,
      sandbox: registeredSandbox,
      ...(retainedSandboxIdentityFingerprint
        ? { retainedSandboxIdentityFingerprint }
        : {}),
    });
  };
  const initialIdentity = portableContainerAuthority ? null : inspectContainerIdentity();
  if (initialIdentity === false) {
    requestSandboxDestroyExit(1);
  }
  const initialContainerIdentities = initialIdentity?.identities;

  let preparedManagedLlamaCppCleanup: ReturnType<
    typeof prepareManagedLlamaCppRuntimeCleanupForSandbox
  > = null;
  if (
    !registeredSandbox ||
    (registeredSandbox.provider === "llama-cpp-local" &&
      !registeredSandbox.hostLocalInferenceProvenance)
  ) {
    /**
     * SOURCE_OF_TRUTH
     * Invalid state: the sandbox registry row is absent after a partial destroy,
     * but private managed llama.cpp owner state still requires exact cleanup.
     * Source boundary: destroy qualifies that private owner, journal, and Docker
     * operation before crossing the OpenShell sandbox-delete boundary.
     * Source-fix constraint: destroy cannot reconstruct the missing registry row
     * or safely select a Docker daemon after deletion, so it may use only the
     * retained private authority and must fail closed when qualification fails.
     * Regression proof: destroy-flow.test.ts proves registry-absent preparation
     * and completion without post-delete authority discovery.
     * Removal condition: remove this recovery path when sandbox registry
     * retirement and private managed-runtime retirement are one durable action.
     */
    try {
      // Fresh Docker qualification reads ambient DOCKER_CONTEXT, DOCKER_HOST,
      // or Docker's persisted currentContext. Pin that selection before
      // OpenShell sandbox deletion so legacy cleanup cannot
      // switch daemons. A missing registry row still permits exact owner-state
      // recovery for a prior partial destroy.
      preparedManagedLlamaCppCleanup = prepareManagedLlamaCppRuntimeCleanupForSandbox(sandboxName, {
        ...(typeof registeredSandbox?.gatewayPort === "number"
          ? { gatewayPort: registeredSandbox.gatewayPort }
          : {}),
      });
    } catch (error) {
      console.error(
        `  Refusing to destroy sandbox '${sandboxName}': Managed llama.cpp cleanup preflight failed: ${redactDestroyError(error)}`,
      );
      console.error(
        `  The sandbox was not deleted. Resolve the reported cleanup preflight failure and retry destroy.`,
      );
      requestSandboxDestroyExit(1);
    }
  }
  const abortPreparedCleanupOnError = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (error) {
      preparedManagedLlamaCppCleanup?.abort();
      throw error;
    }
  };
  let destroyPreflight: ReturnType<typeof prepareSandboxDestroy>;
  destroyPreflight = abortPreparedCleanupOnError(() =>
    prepareSandboxDestroy(sandboxName, {
      retainedRecoveryGatewayName: retainedRecoveryAuthority?.gatewayName,
    }),
  );
  const { cleanupGatewayName, runOpenshell, sandbox, sandboxConfirmedAbsent } = destroyPreflight;
  if (retainedRecoveryAuthority && !sandboxConfirmedAbsent) {
    console.error(
      `  Refusing to automatically delete retained sandbox '${sandboxName}': OpenShell still reports it present, but its delete command accepts only the mutable sandbox name. NemoClaw cannot bind that deletion to the retained immutable identity. No sandbox resources were removed. Ask an OpenShell administrator to resolve create-attempt label '${retainedRecoveryAuthority.createAttemptNonce}' to the exact sandbox and use an identity-bound removal procedure. After OpenShell confirms the retained sandbox is absent, rerun '${CLI_NAME} ${sandboxName} destroy --yes' to reconcile its verified Docker containers and recovery record.`,
    );
    preparedManagedLlamaCppCleanup?.abort();
    requestSandboxDestroyExit(1);
  }
  // Recheck identity after pre-delete qualification and recoverable journal
  // publication reconciliation, before any sandbox runtime mutation.
  if (portableContainerAuthority) {
    try {
      abortPreparedCleanupOnError(() => portableContainerAuthority.revalidate());
    } catch (error) {
      console.error(
        `  Refusing to destroy sandbox '${sandboxName}': NemoClaw could not revalidate Portable container identity during preflight: ${redactDestroyError(error)}. NemoClaw removed no sandbox resources.`,
      );
      requestSandboxDestroyExit(1);
    }
  } else {
    const preMutationIdentity = abortPreparedCleanupOnError(inspectContainerIdentity);
    if (
      preMutationIdentity === false ||
      !isSameDestroyContainerIdentityProof(initialIdentity!, preMutationIdentity)
    ) {
      if (preMutationIdentity !== false) {
        console.error(
          `  Refusing to destroy sandbox '${sandboxName}': Container identity changed during preflight. No sandbox resources were removed.`,
        );
      }
      preparedManagedLlamaCppCleanup?.abort();
      requestSandboxDestroyExit(1);
    }
  }
  const priorHttpsPinRouteId = abortPreparedCleanupOnError(() =>
    parseHttpsPinRouteId(sandbox?.endpointUrl),
  );
  let destructiveResult: Awaited<ReturnType<typeof executeSandboxDestroy>>;
  try {
    destructiveResult = await executeSandboxDestroy({
      force: normalized.force === true,
      getSandbox: registry.getSandbox,
      listSandboxes: registry.listSandboxes,
      runOpenshell,
      sandbox,
      sandboxConfirmedAbsent,
      sandboxName,
      expectedContainerIdentities: initialContainerIdentities,
      ...(retainedSandboxIdentityFingerprint
        ? { expectedContainerIdentityFingerprint: retainedSandboxIdentityFingerprint }
        : {}),
      ...(initialIdentity?.providerIdentity
        ? { expectedRuntimeProviderIdentity: initialIdentity.providerIdentity }
        : {}),
      ...(portableContainerAuthority ? { portableContainerAuthority } : {}),
      verifyForwardPortsReleased: () => teardownSandboxDashboardForward(sandboxName),
      stopInferenceResources: () => stopSandboxInferenceResources(sandboxName, sandbox),
    });
  } catch (error) {
    preparedManagedLlamaCppCleanup?.abort();
    throw error;
  }
  if (!destructiveResult.ok) {
    if (destructiveResult.hostLocalInferenceCleanupFailure) {
      console.error(
        `  Sandbox '${sandboxName}' is gone, but its exact host-local inference cleanup failed: ${destructiveResult.hostLocalInferenceCleanupFailure}`,
      );
      console.error(
        `  Local ownership state was preserved. Re-run '${CLI_NAME} ${sandboxName} destroy --yes' to reconcile only the recorded provider runtime.`,
      );
    }
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
    if (destructiveResult.timedOut) {
      console.error(
        `  NemoClaw preserved the local sandbox record because OpenShell did not confirm the remote operation.`,
      );
      console.error(
        `  Run '${CLI_NAME} ${sandboxName} status' to check or start the recorded gateway, then retry destroy; --force cannot discard the record after a timeout.`,
      );
    } else if (destructiveResult.gatewayUnreachable) {
      if (destructiveResult.hostLocalInferenceOwnershipRequiresGateway) {
        console.error(
          `  The OpenShell gateway is unreachable. Local state was preserved because it contains the exact host-local inference ownership required to retire the managed runtime.`,
        );
        console.error(
          `  Start the gateway (run '${CLI_NAME} ${sandboxName} status'), then retry destroy; --force cannot safely discard host-local inference ownership.`,
        );
      } else if (destructiveResult.mcpOwnershipRequiresGateway) {
        console.error(
          `  The OpenShell gateway is unreachable. Local state was preserved because it contains MCP ownership required for exact provider cleanup.`,
        );
        console.error(
          `  Start the gateway (run '${CLI_NAME} ${sandboxName} status'), then retry destroy; --force cannot safely discard MCP ownership.`,
        );
      } else if (destructiveResult.portableLifecycleOwnershipRequiresGateway) {
        console.error(
          `  The OpenShell gateway is unreachable. NemoClaw preserved the sandbox registry record and schema-4 Portable receipt because OpenShell sandbox deletion and absence of the exact Podman container are unconfirmed.`,
        );
        console.error(
          `  Start the gateway by running '${CLI_NAME} ${sandboxName} status'. Retry destroy. --force cannot discard this ownership state until NemoClaw confirms both results.`,
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
    preparedManagedLlamaCppCleanup?.abort();
    requestSandboxDestroyExit(destructiveResult.exitCode);
  }
  const {
    detachOutcome,
    deleteResult,
    alreadyGone,
    forcedLocalCleanup,
    deleteOutput,
    commonLlamaCppAuthorityRetired,
  } = destructiveResult;

  /**
   * SOURCE_OF_TRUTH
   * Invalid state: the OpenShell gateway is unreachable while a local sandbox
   * record still exists, so a normal destroy cannot confirm remote deletion.
   * Source boundary: destroySandbox -> executeSandboxDestroy -> `openshell
   * sandbox delete`; only an explicit --force and no retained MCP or host-local
   * inference ownership may select forcedLocalCleanup.
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
  if (!deleteSucceededOrAlreadyGone) {
    preparedManagedLlamaCppCleanup?.abort();
  }
  if (deleteSucceededOrAlreadyGone && sandbox) {
    const stateVolumeCleanupResults = abortPreparedCleanupOnError(() =>
      removeManagedAgentStateVolumes(
        {
          agentName: sandbox.agent,
          runtimeProviderId: normalizeRuntimeProviderIdentity(sandbox.openshellDriver),
          sandboxName,
          workloadKind: sandbox.workload?.kind ?? "",
        },
        {
          runtimeProviders: CURRENT_RUNTIME_PROVIDER_BUNDLES,
        },
      ),
    );
    const failedStateVolumeCleanup = stateVolumeCleanupResults.find(
      (result) => result.status === "failed",
    );
    if (failedStateVolumeCleanup?.status === "failed") {
      console.error(
        `  Sandbox '${sandboxName}' is gone, but its managed agent state volume '${failedStateVolumeCleanup.volumeName}' could not be removed: ${redactDestroyError(failedStateVolumeCleanup.detail)}`,
      );
      console.error("  The sandbox registry entry was preserved so exact cleanup can be retried.");
      preparedManagedLlamaCppCleanup?.abort();
      requestSandboxDestroyExit(1);
    }
    for (const stateVolumeCleanup of stateVolumeCleanupResults) {
      if (stateVolumeCleanup.status === "not-owned") {
        console.warn(
          `  ${YW}⚠${R} Left managed state volume '${stateVolumeCleanup.volumeName}' untouched because ${stateVolumeCleanup.detail}.`,
        );
      } else if (stateVolumeCleanup.status === "removed") {
        console.log(`  Removed managed agent state volume for '${sandboxName}'.`);
      }
    }
  }
  abortPreparedCleanupOnError(() => {
    const shouldStopHostServices = shouldStopHostServicesAfterDestroy({
      deleteSucceededOrAlreadyGone,
      registeredSandboxCount: registry.listSandboxes().sandboxes.length,
      sandboxStillRegistered: !!registry.getSandbox(sandboxName),
    });
    cleanupSandboxServices(sandboxName, {
      stopHostServices: shouldStopHostServices,
    });
  });
  if (deleteSucceededOrAlreadyGone && commonLlamaCppAuthorityRetired === true) {
    preparedManagedLlamaCppCleanup?.abort();
  } else if (deleteSucceededOrAlreadyGone) {
    // A null pre-delete result proves that no matching legacy owner state was
    // present. Never discover and qualify newly appeared state only after the
    // sandbox boundary; a later destroy retry must preflight that state first.
    const managedLlamaCppCleanup = preparedManagedLlamaCppCleanup?.cleanup();
    if (managedLlamaCppCleanup && !managedLlamaCppCleanup.ok) {
      console.error(
        `  Managed llama.cpp cleanup failed for '${sandboxName}': ${managedLlamaCppCleanup.reason}`,
      );
      console.error("  The sandbox registry entry was preserved so exact cleanup can be retried.");
      requestSandboxDestroyExit(1);
    }
  }
  // The sandbox's gateway was captured before the registry entry is removed —
  // post-removal lookups return null and would collapse the cleanup target
  // back to the default gateway.
  /**
   * SOURCE_OF_TRUTH
   * Invalid state: the live sandbox is confirmed deleted or already absent,
   * but its durable provider identity or workload receipt cannot prove image
   * cleanup authority, so the registry row and onboarding session are retained.
   * Source boundary: the persisted `openshellDriver` and `workload` receipt are
   * validated only by the selected provider's `cleanup.removeOwnedWorkload`.
   * Source-fix constraint: this is a residual guard for a raw writer or TOCTOU
   * change after pre-delete authority validation. Destroy cannot synthesize
   * provider ownership after remote deletion; guessing could remove a shared
   * image or another provider's workload, so the operator must restore trusted
   * ownership metadata or resolve the runtime conflict and retry.
   * Regression proof: destroy-flow.test.ts proves both blocked retention and
   * that a repaired matching receipt permits registry and session retirement;
   * test/platform/images/image-cleanup.test.ts proves the lower-level fail-closed contract.
   * Removal condition: remove this recovery boundary only when the provider or
   * registry owns authenticated reconciliation that can safely complete cleanup
   * without retaining the local ownership row.
   */
  if (deleteSucceededOrAlreadyGone && retireRemovedImmutabilityState) {
    retireRemovedImmutabilityStateRecord(sandboxName, "sandbox-destroyed");
  }
  const removalOutcome = removeSandboxRegistryEntryOutcome(sandboxName);
  const removed = removalOutcome.removed;
  if (removalOutcome.status === "blocked") {
    const providerId = normalizeRuntimeProviderIdentity(
      (registry.getSandbox(sandboxName) ?? sandbox)?.openshellDriver,
    );
    console.warn(
      `  ${YW}⚠${R} Sandbox '${sandboxName}' cleanup is incomplete for runtime provider ` +
        `'${providerId}' because workload ownership authority could not be proven.`,
    );
    console.warn(
      `  ${YW}⚠${R} The local registry and session were preserved. Run '${CLI_NAME} ` +
        `${sandboxName} doctor --json'; restore trusted ownership metadata or resolve the ` +
        `runtime conflict, then re-run '${CLI_NAME} ${sandboxName} destroy --yes'. Do not ` +
        "rewrite a receipt to match a mutable name.",
    );
    emitProviderDetachResidualHint(sandboxName, detachOutcome.failures, (message) =>
      console.warn(`  ${YW}⚠${R}${message}`),
    );
    requestSandboxDestroyExit(1);
  }
  if (removed) {
    try {
      retirePortableLifecycleAuthority(sandboxName);
    } catch (error) {
      console.warn(
        `  ${YW}⚠${R} Failed to retire portable lifecycle authority for '${sandboxName}': ${redactDestroyError(error)}`,
      );
    }
    const localInference = require("../../inference/local") as {
      clearPersistedOllamaHostIfUnused(
        routes: readonly { provider?: string | null; endpointUrl?: string | null }[],
      ): boolean;
    };
    if (sandbox && isLocalOllamaRouteOwner(sandbox)) {
      try {
        await withOllamaModelOwnershipTransaction(() => {
          const selectedHost = loadPersistedOllamaHost();
          if (!isLocalOllamaRouteOwner(sandbox, selectedHost)) return;
          const remainingSandboxes = registry.listSandboxes().sandboxes;
          localInference.clearPersistedOllamaHostIfUnused(remainingSandboxes);
        });
      } catch (error) {
        console.warn(
          `  ${YW}⚠${R} Failed to retire the final local Ollama route receipt: ${redactDestroyError(error)}`,
        );
      }
    }
  }
  if (deleteSucceededOrAlreadyGone && removed && priorHttpsPinRouteId) {
    await revokeDestroyedSandboxHttpsPinRoute(cleanupGatewayName, priorHttpsPinRouteId);
  }
  let routedSessionCleanupHandled = false;
  if (deleteSucceededOrAlreadyGone && removed) {
    try {
      // The gateway route lock nests the current-user router-port lock inside
      // stopModelRouterForDestroyedSandbox. Routed onboarding takes the same
      // lock order and holds both through registry publication, including
      // when the competing sandbox belongs to another gateway.
      routedSessionCleanupHandled = await withGatewayRouteMutationLock(cleanupGatewayName, () =>
        stopModelRouterForDestroyedSandbox(sandbox, {
          acquireOnboardLock: onboardSession.acquireOnboardLock,
          compareAndSwapSession: onboardSession.compareAndSwapSession,
          expectedSession: destroySession,
          loadSession: onboardSession.loadSession,
          releaseOnboardLock: onboardSession.releaseOnboardLock,
          warn: defaultDestroyWarn,
        }),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      defaultDestroyWarn(
        `Sandbox deletion succeeded, but the Model Router teardown did not complete: ${detail}. ` +
          `Inspect the listener before the next Model Router onboarding and stop only a process ` +
          `that still owns the matching port and model-router command line.`,
      );
    }
  }
  const retainedRecoveryOwnsDestroySession = retainedRecoveryAuthority
    ? onboardSession.retainedSandboxRecoveryMatchesSession(
        retainedRecoveryAuthority,
        destroySession,
      )
    : false;
  if (
    !retainedRecoveryOwnsDestroySession &&
    !routedSessionCleanupHandled &&
    destroySession?.sandboxName === sandboxName
  ) {
    const cleanupResult = onboardSession.compareAndSwapSession(
      (current) =>
        current.sessionId === destroySession.sessionId &&
        current.updatedAt === destroySession.updatedAt &&
        current.sandboxName === destroySession.sandboxName &&
        current.endpointUrl === destroySession.endpointUrl &&
        current.routerPid === destroySession.routerPid &&
        current.routerCredentialHash === destroySession.routerCredentialHash,
      (current) => {
        current.sandboxName = null;
        return current;
      },
      "nemoclaw destroy sandbox session cleanup",
    );
    if (cleanupResult === "busy") {
      defaultDestroyWarn(
        "Another onboarding run owns the session lock. Keeping its replacement session unchanged.",
      );
    }
  }
  if (deleteSucceededOrAlreadyGone && retainedRecoveryAuthority) {
    let recoveryResolved: boolean;
    try {
      recoveryResolved = onboardSession.resolveRetainedSandboxRecovery(retainedRecoveryAuthority);
    } catch (error) {
      console.error(
        `  Sandbox '${sandboxName}' resources are gone, but NemoClaw could not clear its retained recovery record: ${redactDestroyError(error)}`,
      );
      console.error(`  Re-run '${CLI_NAME} ${sandboxName} destroy --yes' to finish local cleanup.`);
      requestSandboxDestroyExit(1);
    }
    if (!recoveryResolved) {
      console.error(
        `  Sandbox '${sandboxName}' resources are gone, but its retained recovery authority was no longer current, so local recovery cleanup was not confirmed.`,
      );
      console.error(
        `  NemoClaw preserved any current recovery state. Resolve the recovery record conflict, then re-run '${CLI_NAME} ${sandboxName} destroy --yes'.`,
      );
      requestSandboxDestroyExit(1);
    }
  }
  if (
    shouldCleanupGatewayAfterConfirmedFinalDestroy({
      deleteSucceededOrAlreadyGone,
      removedRegistryEntry: removed,
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
