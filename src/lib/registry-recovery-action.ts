// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenshell } from "./adapters/openshell/resolve";
import { captureOpenshell } from "./adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./adapters/openshell/timeouts";
import {
  getNamedGatewayLifecycleState,
  recoverNamedGatewayRuntime,
} from "./gateway-runtime-action";
import { resolveGatewayPortFromName } from "./onboard/gateway-binding";
import { validateName } from "./runner";
import { parseLiveSandboxNames } from "./runtime-recovery";
import * as onboardSession from "./state/onboard-session";
import type { SandboxEntry } from "./state/registry";
import * as registry from "./state/registry";

type Session = ReturnType<typeof onboardSession.loadSession>;

type RecoveredSandboxMetadata = Partial<
  Pick<SandboxEntry, "model" | "provider" | "gpuEnabled" | "policies" | "nimContainer" | "agent">
> & {
  policyPresets?: string[] | null;
};

function buildRecoveredSandboxEntry(
  name: string,
  metadata: RecoveredSandboxMetadata = {},
): SandboxEntry {
  const entry: SandboxEntry = {
    name,
    model: metadata.model || null,
    provider: metadata.provider || null,
    gpuEnabled: metadata.gpuEnabled === true,
    policies: Array.isArray(metadata.policies)
      ? metadata.policies
      : Array.isArray(metadata.policyPresets)
        ? metadata.policyPresets
        : [],
    nimContainer: metadata.nimContainer || null,
  };
  // Only assert `agent` when recovery actually knows it. Object.assign in
  // updateSandbox would otherwise overwrite a persisted agent (e.g. "hermes")
  // with null whenever the recovery seed has no source of truth — the live
  // OpenShell gateway does not surface NemoClaw's agent type, and a session
  // sandbox seed never set this field, so the existing entry must win.
  if (metadata.agent !== undefined && metadata.agent !== null) {
    entry.agent = metadata.agent;
  }
  return entry;
}

function upsertRecoveredSandbox(name: string, metadata: RecoveredSandboxMetadata = {}) {
  let validName;
  try {
    validName = validateName(name, "sandbox name");
  } catch {
    return false;
  }

  const entry = buildRecoveredSandboxEntry(validName, metadata);
  if (registry.getSandbox(validName)) {
    registry.updateSandbox(validName, entry);
    return false;
  }
  registry.registerSandbox(entry);
  return true;
}

function shouldRecoverRegistryEntries(
  current: { sandboxes: Array<{ name: string }>; defaultSandbox?: string | null },
  session: Session | null,
  requestedSandboxName: string | null,
) {
  const sessionSandboxName = session?.sandboxName ?? null;
  const hasSessionSandbox = Boolean(sessionSandboxName);
  const missingSessionSandbox =
    hasSessionSandbox && !current.sandboxes.some((sandbox) => sandbox.name === sessionSandboxName);
  const missingRequestedSandbox =
    Boolean(requestedSandboxName) &&
    !current.sandboxes.some((sandbox) => sandbox.name === requestedSandboxName);
  const hasRecoverySeed =
    current.sandboxes.length > 0 || hasSessionSandbox || Boolean(requestedSandboxName);
  return {
    missingRequestedSandbox,
    // #5714: an empty local registry must always attempt recovery, even with
    // no session/requested-name seed. The reporter's `nemoclaw list` printed
    // "No sandboxes registered" while the live gateway/container were healthy
    // and `nemoclaw <name> status` reported Ready. Probing the live gateway
    // (bounded, read-only when unseeded — see recoverRegistryEntries) lets the
    // documented discovery command rediscover a sandbox the local registry lost.
    shouldRecover:
      current.sandboxes.length === 0 ||
      (hasRecoverySeed && (missingRequestedSandbox || missingSessionSandbox)),
  };
}

/**
 * #2753: a session that records sandboxName but never completed the sandbox
 * step is a phantom from an interrupted onboard. Going forward, the onboard
 * fix prevents such writes; this guard catches stale on-disk sessions that
 * pre-date the fix so `nemoclaw list` does not resurrect them.
 */
function isSessionSandboxConfirmed(session: Session | null): boolean {
  if (!session?.sandboxName) return false;
  return session.steps?.sandbox?.status === "complete";
}

function seedRecoveryMetadata(
  current: { sandboxes: SandboxEntry[] },
  session: Session | null,
  requestedSandboxName: string | null,
) {
  const metadataByName = new Map<string, RecoveredSandboxMetadata>(
    current.sandboxes.map((sandbox: SandboxEntry) => [sandbox.name, sandbox]),
  );
  let recoveredFromSession = false;

  if (!isSessionSandboxConfirmed(session) || !session?.sandboxName) {
    return { metadataByName, recoveredFromSession };
  }

  metadataByName.set(
    session.sandboxName,
    buildRecoveredSandboxEntry(session.sandboxName, {
      model: session.model || null,
      provider: session.provider || null,
      nimContainer: session.nimContainer || null,
      policyPresets: session.policyPresets || null,
      agent: session.agent || null,
    }),
  );
  const sessionSandboxMissing = !current.sandboxes.some(
    (sandbox: { name: string }) => sandbox.name === session.sandboxName,
  );
  const shouldRecoverSessionSandbox =
    current.sandboxes.length === 0 ||
    sessionSandboxMissing ||
    requestedSandboxName === session.sandboxName;
  if (shouldRecoverSessionSandbox) {
    recoveredFromSession = upsertRecoveredSandbox(
      session.sandboxName,
      metadataByName.get(session.sandboxName),
    );
  }
  return { metadataByName, recoveredFromSession };
}

function canInspectLiveGatewayReadOnly(): boolean {
  // #5714: unseeded `nemoclaw list` recovery must never mutate gateway state
  // (no select/start). Probes are non-fatal so a hung gateway falls back to the
  // empty registry instead of exiting the process.
  const lifecycle = getNamedGatewayLifecycleState(undefined, { ignoreProbeErrors: true });
  // The target NemoClaw gateway is healthy — trust its sandbox list.
  if (lifecycle.state === "healthy_named") {
    return true;
  }
  // A different gateway is active. `openshell sandbox list` is scoped to the
  // active gateway, so only trust it when that gateway is still NemoClaw-managed
  // (the bare `nemoclaw` or a per-port `nemoclaw-<port>` from a non-default
  // NEMOCLAW_GATEWAY_PORT). Never list a foreign OpenShell gateway's sandboxes
  // as recovered NemoClaw entries.
  if (lifecycle.state === "connected_other") {
    return resolveGatewayPortFromName(lifecycle.activeGateway ?? "") !== null;
  }
  return false;
}

async function canInspectLiveGatewayViaRecovery(): Promise<boolean> {
  const recovery = await recoverNamedGatewayRuntime();
  return (
    recovery.recovered ||
    recovery.before?.state === "healthy_named" ||
    recovery.after?.state === "healthy_named"
  );
}

interface LiveGatewayRecovery {
  recoveredFromGateway: number;
  /**
   * #5714: live sandboxes surfaced for display only (unseeded `list` recovery)
   * that were NOT persisted to the on-disk registry. Empty for the seeded path.
   */
  ephemeralSandboxes: SandboxEntry[];
}

async function recoverRegistryFromLiveGateway(
  metadataByName: Map<string, RecoveredSandboxMetadata>,
  { readOnly = false }: { readOnly?: boolean } = {},
): Promise<LiveGatewayRecovery> {
  if (!resolveOpenshell()) {
    return { recoveredFromGateway: 0, ephemeralSandboxes: [] };
  }
  const canInspectLiveGateway = readOnly
    ? canInspectLiveGatewayReadOnly()
    : await canInspectLiveGatewayViaRecovery();
  if (!canInspectLiveGateway) {
    return { recoveredFromGateway: 0, ephemeralSandboxes: [] };
  }

  let recoveredFromGateway = 0;
  const ephemeralSandboxes: SandboxEntry[] = [];
  const liveList = captureOpenshell(["sandbox", "list"], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  // Only trust the output of a clean `sandbox list`. On a non-zero/failed probe
  // (timeout, transport error) OpenShell may print free-form text whose first
  // token parseLiveSandboxNames would otherwise mistake for a sandbox name.
  if (liveList.status !== 0) {
    return { recoveredFromGateway: 0, ephemeralSandboxes: [] };
  }
  const liveNames = Array.from<string>(parseLiveSandboxNames(liveList.output));
  for (const name of liveNames) {
    const metadata = metadataByName.get(name) || undefined;
    if (readOnly) {
      // Unseeded recovery: surface the live sandbox for THIS `list` only and do
      // not persist it. `openshell sandbox list` exposes only NAME/CREATED/PHASE
      // — not the agent or gateway binding — so a persisted entry would default
      // `agent` to "openclaw" everywhere downstream (state dirs, connect,
      // rebuild, doctor), permanently misclassifying a Deep Agents/Hermes
      // sandbox after registry loss. Display-only recovery fixes the
      // discoverability mismatch without writing unsafe durable metadata;
      // follow-up named commands reconcile the real agent via the gateway.
      let validName: string;
      try {
        validName = validateName(name, "sandbox name");
      } catch {
        continue;
      }
      ephemeralSandboxes.push({
        ...buildRecoveredSandboxEntry(validName, metadata),
        recoveredFromGateway: true,
      });
      recoveredFromGateway += 1;
      continue;
    }
    if (upsertRecoveredSandbox(name, metadata)) {
      recoveredFromGateway += 1;
    }
  }
  return { recoveredFromGateway, ephemeralSandboxes };
}

function applyRecoveredDefault(
  currentDefaultSandbox: string | null,
  requestedSandboxName: string | null,
  session: Session | null,
) {
  const recovered = registry.listSandboxes();
  const preferredDefault =
    requestedSandboxName || (!currentDefaultSandbox ? session?.sandboxName || null : null);
  if (
    preferredDefault &&
    recovered.sandboxes.some((sandbox: { name: string }) => sandbox.name === preferredDefault)
  ) {
    registry.setDefault(preferredDefault);
  }
  return registry.listSandboxes();
}

export async function recoverRegistryEntries({
  requestedSandboxName = null,
}: {
  requestedSandboxName?: string | null;
} = {}) {
  const current = registry.listSandboxes();
  const session = onboardSession.loadSession();
  const recoveryCheck = shouldRecoverRegistryEntries(current, session, requestedSandboxName);
  if (!recoveryCheck.shouldRecover) {
    return { ...current, recoveredFromSession: false, recoveredFromGateway: 0 };
  }

  const seeded = seedRecoveryMetadata(current, session, requestedSandboxName);
  // A seed is any signal that the user expects a specific sandbox to exist:
  // existing registry entries, a recorded onboard session, or an explicit
  // requested name. With a seed we allow active gateway recovery (which may
  // select/start the named gateway). Without one — the #5714 empty-registry
  // `list` case — restrict recovery to a read-only inspection of any connected
  // gateway so plain `nemoclaw list` never mutates gateway state as a side
  // effect of listing.
  const hasRecoverySeed =
    current.sandboxes.length > 0 || Boolean(session?.sandboxName) || Boolean(requestedSandboxName);
  const gateway = await recoverRegistryFromLiveGateway(seeded.metadataByName, {
    readOnly: !hasRecoverySeed,
  });
  const recovered = applyRecoveredDefault(current.defaultSandbox, requestedSandboxName, session);
  // Merge display-only (ephemeral) live-gateway sandboxes that were not
  // persisted (#5714 unseeded recovery), skipping any that a concurrent path
  // may already have registered.
  const persistedNames = new Set(recovered.sandboxes.map((sandbox) => sandbox.name));
  const sandboxes = [
    ...recovered.sandboxes,
    ...gateway.ephemeralSandboxes.filter((sandbox) => !persistedNames.has(sandbox.name)),
  ];
  return {
    ...recovered,
    sandboxes,
    recoveredFromSession: seeded.recoveredFromSession,
    recoveredFromGateway: gateway.recoveredFromGateway,
  };
}
