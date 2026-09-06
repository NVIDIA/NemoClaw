// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  detectOpenShellStateRpcPreflightIssue,
  printOpenShellStateRpcIssue,
} from "../../adapters/openshell/gateway-drift";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import { CLI_NAME } from "../../cli/branding";
import {
  checkGatewayRouteCompatibility,
  formatGatewayRouteConflict,
  type GatewayInferenceRoute,
  isAdvisoryGatewayRouteConflict,
} from "../../inference/gateway-route-compatibility";
import { normalizeInferenceSelection } from "../../inference/selection";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import { requireRuntimeProviderBundleForSandbox } from "../../onboard/runtime-provider/access";
import { assertHermesPortableCommandUnavailable } from "../../onboard/experimental/portable-agent-lifecycle";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../../onboard/runtime-provider/current";
import {
  type ManagedWorkloadRebuildHandoff,
  managedWorkloadRebuildHandoffMatchesEntry,
} from "../../onboard/workload/rebuild";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import { withLock } from "../../state/registry/lock";
import { load, save } from "../../state/registry/persistence";
import type { SandboxEntry, SandboxRegistry } from "../../state/registry/types";
import type { RebuildBail } from "./rebuild-credential-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildVersionCheck } from "./rebuild-preflight-confirmation";
import { printRebuildPreflightFailure } from "./rebuild-preflight-error";
import { getRebuildCredentialEnvFromRegistry } from "./rebuild-resume-preflight";

export interface RebuildRoutePreflightReceipt {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly route: GatewayInferenceRoute;
  readonly migratedSandboxNames: readonly string[];
}

export type RebuildRoutePreflightResult =
  | { ok: true; receipt: RebuildRoutePreflightReceipt }
  | { ok: false; message: string };

interface RebuildRouteRegistryDependencies {
  withLock<T>(fn: () => T): T;
  load(): SandboxRegistry;
  save(data: SandboxRegistry): void;
}

const defaultRouteDependencies: RebuildRouteRegistryDependencies = {
  withLock,
  load,
  save,
};

export function assertSandboxRebuildCommandAvailable(sandboxName: string): void {
  assertHermesPortableCommandUnavailable(sandboxName, "sandbox:rebuild");
}

function normalizedRoute(entry: Partial<SandboxEntry>): GatewayInferenceRoute {
  const route = normalizeInferenceSelection(entry);
  return {
    provider: route.provider,
    model: route.model,
    endpointUrl: route.endpointUrl,
    preferredInferenceApi: route.preferredInferenceApi,
    credentialEnv: route.credentialEnv,
  };
}

function missingCredentialIdentity(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function sameRoute(left: GatewayInferenceRoute, right: GatewayInferenceRoute): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.endpointUrl === right.endpointUrl &&
    left.preferredInferenceApi === right.preferredInferenceApi &&
    left.credentialEnv === right.credentialEnv
  );
}

function hardRouteConflict(
  gatewayName: string,
  sandboxName: string,
  route: GatewayInferenceRoute,
  sandboxes: readonly SandboxEntry[],
): string | null {
  if (!route.provider || !route.model) {
    return "Prepared rebuild inference route is missing its provider or model.";
  }
  const compatibility = checkGatewayRouteCompatibility({
    gatewayName,
    sandboxName,
    route,
    sandboxes,
  });
  if (compatibility.ok || isAdvisoryGatewayRouteConflict(compatibility)) return null;
  return formatGatewayRouteConflict(compatibility);
}

/**
 * Persist the target route and canonical credential identities for compatible
 * legacy peers in one registry transaction. The ordinary compatibility guard
 * remains literal and fail-closed; only this rebuild migration may fill a
 * missing identity from the provider's canonical configuration.
 */
export function commitRebuildRoutePreflight(
  input: {
    sandboxName: string;
    gatewayName: string;
    targetUpdate: Partial<Omit<SandboxEntry, "name">>;
  },
  dependencies: RebuildRouteRegistryDependencies = defaultRouteDependencies,
): RebuildRoutePreflightResult {
  return dependencies.withLock(() => {
    const sandboxRegistry = dependencies.load();
    const currentTarget = sandboxRegistry.sandboxes[input.sandboxName];
    if (!currentTarget) {
      return {
        ok: false,
        message: "Sandbox registry entry disappeared during rebuild route preflight.",
      };
    }
    let targetGatewayName: string;
    try {
      targetGatewayName = resolveSandboxGatewayName(currentTarget);
    } catch {
      return {
        ok: false,
        message: "Sandbox gateway binding changed during rebuild route preflight.",
      };
    }
    if (targetGatewayName !== input.gatewayName) {
      return {
        ok: false,
        message: "Sandbox gateway binding changed during rebuild route preflight.",
      };
    }

    const target = { ...currentTarget, ...input.targetUpdate };
    const targetRoute = normalizedRoute(target);
    const migratedSandboxNames: string[] = [];
    for (const peer of Object.values(sandboxRegistry.sandboxes)) {
      if (
        peer.name === input.sandboxName ||
        peer.provider !== targetRoute.provider ||
        !missingCredentialIdentity(peer.credentialEnv)
      ) {
        continue;
      }
      let peerGatewayName: string;
      try {
        peerGatewayName = resolveSandboxGatewayName(peer);
      } catch {
        continue;
      }
      if (peerGatewayName !== input.gatewayName) continue;
      const credentialEnv = getRebuildCredentialEnvFromRegistry(peer.provider, peer.credentialEnv);
      if (!credentialEnv) continue;
      peer.credentialEnv = credentialEnv;
      migratedSandboxNames.push(peer.name);
    }

    const projectedSandboxes = Object.values(sandboxRegistry.sandboxes).map((entry) =>
      entry.name === input.sandboxName ? target : entry,
    );
    const conflict = hardRouteConflict(
      input.gatewayName,
      input.sandboxName,
      targetRoute,
      projectedSandboxes,
    );
    if (conflict) return { ok: false, message: conflict };

    Object.assign(currentTarget, input.targetUpdate);
    dependencies.save(sandboxRegistry);
    return {
      ok: true,
      receipt: {
        sandboxName: input.sandboxName,
        gatewayName: input.gatewayName,
        route: targetRoute,
        migratedSandboxNames: migratedSandboxNames.sort(),
      },
    };
  });
}

/**
 * Re-read the complete shared-gateway route at the synchronous delete edge.
 * A target-route change or peer hard conflict in that snapshot invalidates the
 * earlier preflight receipt.
 */
export function revalidateRebuildRouteBeforeDelete(
  receipt: RebuildRoutePreflightReceipt,
  dependencies: Pick<RebuildRouteRegistryDependencies, "load"> = defaultRouteDependencies,
): RebuildRoutePreflightResult {
  // Registry writes install complete files atomically. A read lock would end before
  // the external delete, so this guard uses a fresh fail-closed snapshot.
  const sandboxRegistry = dependencies.load();
  const target = sandboxRegistry.sandboxes[receipt.sandboxName];
  if (!target) {
    return {
      ok: false,
      message: "Sandbox registry entry disappeared before sandbox deletion.",
    };
  }
  let gatewayName: string;
  try {
    gatewayName = resolveSandboxGatewayName(target);
  } catch {
    return {
      ok: false,
      message: "Sandbox gateway binding changed before sandbox deletion.",
    };
  }
  if (gatewayName !== receipt.gatewayName) {
    return {
      ok: false,
      message: "Sandbox gateway binding changed before sandbox deletion.",
    };
  }
  const currentRoute = normalizedRoute(target);
  if (!sameRoute(currentRoute, receipt.route)) {
    return {
      ok: false,
      message: "Sandbox inference route changed before sandbox deletion.",
    };
  }
  const conflict = hardRouteConflict(
    receipt.gatewayName,
    receipt.sandboxName,
    currentRoute,
    Object.values(sandboxRegistry.sandboxes),
  );
  return conflict ? { ok: false, message: conflict } : { ok: true, receipt };
}

/** Re-read the complete provider-bound managed workload authority at a mutation edge. */
export function revalidateManagedWorkloadRebuildBeforeDelete(
  sandboxName: string,
  handoff: ManagedWorkloadRebuildHandoff | undefined,
): Extract<RebuildRoutePreflightResult, { ok: false }> | null {
  if (!handoff) return null;
  const current = registry.getSandbox(sandboxName);
  try {
    const provider = current
      ? requireRuntimeProviderBundleForSandbox(current, CURRENT_RUNTIME_PROVIDER_BUNDLES)
      : null;
    if (provider && managedWorkloadRebuildHandoffMatchesEntry(handoff, current, provider)) {
      return null;
    }
  } catch {
    // Convert every provider or durable-authority parse failure into one
    // fail-closed mutation-edge result below.
  }
  return {
    ok: false,
    message: "Managed workload authority changed before sandbox deletion.",
  };
}

export function checkRebuildGatewaySchemaPreflight(
  sandboxName: string,
  sb: RebuildSandboxEntry,
  bail: RebuildBail,
  runtimeSelection?: OpenShellRuntimeSelection,
): boolean {
  const gatewayName = resolveSandboxGatewayName(sb);
  if (runtimeSelection && runtimeSelection.gatewayName !== gatewayName) {
    return bail(
      `Rebuild gateway schema target '${gatewayName}' does not match the frozen OpenShell target '${runtimeSelection.gatewayName}'.`,
    );
  }
  const issue = detectOpenShellStateRpcPreflightIssue({
    gatewayName,
    ...(runtimeSelection ? { runtimeSelection } : {}),
  });
  if (issue) {
    printOpenShellStateRpcIssue(issue, {
      action: `rebuilding sandbox '${sandboxName}'`,
      command: `${CLI_NAME} ${sandboxName} rebuild`,
    });
    printRebuildPreflightFailure(
      "OpenShell gateway schema is incompatible with this rebuild.",
      "Follow the gateway recovery guidance above, then rerun rebuild.",
      "OpenShell gateway schema mismatch.",
      bail,
    );
    return false;
  }
  return true;
}

export async function runRebuildGatewayIntentPreflight<T>(options: {
  checkGatewaySchema: () => boolean;
  confirmIntent: () => Promise<T | null>;
}): Promise<T | null> {
  if (!options.checkGatewaySchema()) return null;
  return options.confirmIntent();
}

export function getRebuildSandboxEntryOrBail(
  sandboxName: string,
  bail: RebuildBail,
): RebuildSandboxEntry | null {
  const sb = registry.getSandbox(sandboxName) as RebuildSandboxEntry | null;
  if (!sb) {
    printRebuildPreflightFailure(
      `sandbox '${sandboxName}' not found in registry.`,
      "Verify the sandbox name and rerun rebuild.",
      `Sandbox '${sandboxName}' not found in registry.`,
      bail,
    );
    return null;
  }
  return sb;
}

/** Block rebuild before any live-state probe or cleanup can bypass retained recovery. */
export function blockRebuildOnRetainedSandboxRecovery(
  sandboxName: string,
  bail: RebuildBail,
): boolean {
  const retainedRecovery = onboardSession
    .listRetainedSandboxRecoveryRecords()
    .find((record) => record.sandboxName === sandboxName);
  if (!retainedRecovery) return false;

  console.error(
    `  Rebuild cannot use retained sandbox '${sandboxName}' while recovery record '${retainedRecovery.recordId}' is unresolved. No sandbox or Docker resources were removed.`,
  );
  console.error(
    `  Run '${CLI_NAME} ${sandboxName} destroy --yes'. If OpenShell still reports the sandbox present, follow destroy's create-attempt label guidance for identity-bound administrator removal.`,
  );
  bail(`Retained sandbox recovery blocks rebuild for '${sandboxName}'.`, 1);
  return true;
}
export function isSingleAgentRebuildSupported(
  sb: registry.SandboxEntry & { agents?: unknown[] },
  bail: RebuildBail,
): boolean {
  if (sb.agents && sb.agents.length > 1) {
    printRebuildPreflightFailure(
      "multi-agent sandbox rebuild is not yet supported.",
      `Back up state manually and recreate with \`${CLI_NAME} onboard\`.`,
      "Multi-agent sandbox rebuild is not yet supported.",
      bail,
    );
    return false;
  }
  return true;
}

export function acquireRebuildOnboardLock(
  sandboxName: string,
  bail: RebuildBail,
): (() => void) | null {
  const lock = onboardSession.acquireOnboardLock(
    `${CLI_NAME} ${sandboxName} rebuild --authoritative-resume`,
  );
  if (!lock.acquired) {
    const pidDetail = lock.holderPid ? ` Lock holder PID: ${lock.holderPid}.` : "";
    const remediation = lock.stale
      ? "Wait briefly, then rerun rebuild so verified stale-lock cleanup can finish."
      : `Wait for the other run to finish, then rerun rebuild.${pidDetail}`;
    printRebuildPreflightFailure(
      `another ${CLI_NAME} onboarding run is already in progress.`,
      remediation,
      "Could not acquire onboard lock before rebuild",
      bail,
    );
    return null;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    onboardSession.releaseOnboardLock();
  };
  process.once("exit", release);
  return release;
}

/**
 * Derive the only registry transition rebuild itself can cause before locking.
 * Keep the pre-confirmation entry intact except for a successful live probe's
 * agent-version cache write, so every concurrent recreate/config change still
 * fails the exact locked-entry comparison below.
 */
export function expectedRebuildEntryAfterVersionCheck(
  confirmedEntry: RebuildSandboxEntry,
  confirmedEntrySnapshot: string,
  versionCheck: RebuildVersionCheck,
): RebuildSandboxEntry {
  if (versionCheck.detectionMethod !== "ssh-exec" || versionCheck.sandboxVersion === null) {
    return confirmedEntry;
  }
  const expectedEntry = JSON.parse(confirmedEntrySnapshot) as RebuildSandboxEntry;
  expectedEntry.agentVersion = versionCheck.sandboxVersion;
  return expectedEntry;
}

export function assertRebuildEntryUnchanged(
  sandboxName: string,
  confirmedEntrySnapshot: string,
  bail: RebuildBail,
): void {
  const lockedEntry = registry.getSandbox(sandboxName);
  if (lockedEntry && JSON.stringify(lockedEntry) === confirmedEntrySnapshot) return;
  printRebuildPreflightFailure(
    "the sandbox configuration changed while rebuild confirmation was pending.",
    "Review the current sandbox state and rerun rebuild.",
    "Sandbox configuration changed before rebuild lock acquisition",
    bail,
  );
}
