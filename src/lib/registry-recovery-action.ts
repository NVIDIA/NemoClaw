// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveOpenshell } from "./adapters/openshell/resolve";
import { captureOpenshell } from "./adapters/openshell/runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./adapters/openshell/timeouts";
import {
  getNamedGatewayLifecycleState,
  recoverNamedGatewayRuntime,
} from "./gateway-runtime-action";
import { validateName } from "./runner";
import { parseLiveSandboxEntries } from "./runtime-recovery";
import * as onboardSession from "./state/onboard-session";
import type { SandboxEntry } from "./state/registry";
import * as registry from "./state/registry";

/**
 * #5714: a sandbox surfaced display-only by unseeded `nemoclaw list` recovery.
 * These transient markers (`recoveredFromGateway`, `livePhase`) are deliberately
 * NOT part of the durable {@link SandboxEntry} persistence contract — they live
 * only on the in-memory list result so they can never be written to
 * sandboxes.json — and let the renderer show the live phase while marking
 * agent/GPU unknown (the gateway list is not a trusted source for those).
 */
export type RecoveredSandboxEntry = SandboxEntry & {
  recoveredFromGateway: true;
  livePhase: string | null;
};

type Session = ReturnType<typeof onboardSession.loadSession>;

type RecoveredSandboxMetadata = Partial<
  Pick<SandboxEntry, "model" | "provider" | "gpuEnabled" | "policies" | "nimContainer" | "agent">
> & {
  policyPresets?: string[] | null;
};

/**
 * Build a minimal-safe registry entry for a recovered sandbox from whatever
 * metadata is known, asserting `agent` only when the seed actually provides it
 * so recovery never clobbers a persisted agent or invents one.
 */
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

/**
 * Persist a recovered sandbox into the registry, registering a new entry or
 * merging into an existing one. Returns true only when a new entry was created.
 * Invalid sandbox names are skipped (returns false).
 */
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

/**
 * Decide whether registry recovery should run and whether the requested
 * sandbox is missing from the on-disk registry. Recovery is attempted whenever
 * the registry is empty (the #5714 unseeded `list` case) or a seed (session or
 * requested name) points at a sandbox the registry does not yet contain.
 */
function shouldRecoverRegistryEntries(
  current: { sandboxes: Array<{ name: string }>; defaultSandbox?: string | null },
  session: Session | null,
  requestedSandboxName: string | null,
) {
  const sessionSandboxName = session?.sandboxName ?? null;
  // #5714/PRA-5: only a *confirmed* session sandbox counts here. An incomplete
  // (phantom) onboard session must not make `missingSessionSandbox` true, or it
  // would flip `shouldRecover` on and drive the mutating seeded gateway recovery
  // (select/start) during a plain `nemoclaw list` even when the registry already
  // has entries. Applied consistently with the `hasRecoverySeed` check in
  // recoverRegistryEntries.
  const hasSessionSandbox = isSessionSandboxConfirmed(session) && Boolean(sessionSandboxName);
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

/**
 * Build the name→metadata seed map used to enrich gateway-recovered entries,
 * and recover a confirmed onboard-session sandbox into the registry when it is
 * missing. Returns the seed map and whether a session sandbox was recovered.
 */
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

/**
 * Decide whether the unseeded (#5714) `nemoclaw list` recovery may read the
 * live `openshell sandbox list` without mutating gateway state. Returns true
 * only when OpenShell is connected to a NemoClaw-managed gateway (the bare
 * `nemoclaw` or a per-port `nemoclaw-<port>`), never a foreign gateway.
 */
function canInspectLiveGatewayReadOnly(): boolean {
  // #5714: unseeded `nemoclaw list` recovery must never mutate gateway state
  // (no select/start). Require `healthy_named` — the active gateway IS the
  // NemoClaw gateway this process resolves/targets. We deliberately do NOT
  // recover from a `connected_other` gateway (a different active gateway,
  // whether a NemoClaw per-port gateway or a foreign one): `openshell sandbox
  // list` may be scoped to the active gateway, and a follow-up `nemoclaw <name>
  // status` resolves the same target gateway as this `list` — so recovering
  // only from `healthy_named` keeps `list` and follow-up commands consistent
  // and never advertises a sandbox the next command cannot act on. Probes are
  // non-fatal so a hung gateway falls back to the empty registry instead of
  // exiting the process.
  const lifecycle = getNamedGatewayLifecycleState(undefined, { ignoreProbeErrors: true });
  return lifecycle.state === "healthy_named";
}

/**
 * Decide whether the seeded recovery path may read the live sandbox list,
 * actively recovering the named NemoClaw gateway (select/start) first when
 * needed. Used when an existing entry, onboard session, or requested name
 * signals a specific sandbox the user expects to exist.
 */
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
  ephemeralSandboxes: RecoveredSandboxEntry[];
}

/**
 * Inspect the live OpenShell gateway and recover its sandboxes. In `readOnly`
 * mode (unseeded #5714 `list`) recovered sandboxes are returned as display-only
 * `ephemeralSandboxes` and never persisted; otherwise they are upserted into
 * the on-disk registry. Returns the recovered count and any ephemeral entries.
 */
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
  const ephemeralSandboxes: RecoveredSandboxEntry[] = [];
  const liveList = captureOpenshell(["sandbox", "list"], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  // Only trust the output of a clean `sandbox list`. On a non-zero/failed probe
  // (timeout, transport error) OpenShell may print free-form text whose first
  // token parseLiveSandboxEntries would otherwise mistake for a sandbox name.
  if (liveList.status !== 0) {
    return { recoveredFromGateway: 0, ephemeralSandboxes: [] };
  }
  const liveEntries = parseLiveSandboxEntries(liveList.output);
  for (const { name, phase } of liveEntries) {
    const metadata = metadataByName.get(name) || undefined;
    if (readOnly) {
      // Unseeded recovery: surface the live sandbox for THIS `list` only and do
      // not persist it. `openshell sandbox list` exposes only NAME/CREATED/PHASE
      // — not the agent or gateway binding — so a persisted entry would default
      // `agent` to "openclaw" everywhere downstream (state dirs, connect,
      // rebuild, doctor), permanently misclassifying a Deep Agents/Hermes
      // sandbox after registry loss. We DO carry the trusted live PHASE so the
      // row can show e.g. Ready (#5714 acceptance), but agent stays unknown
      // because the gateway list is not an authoritative agent source; the
      // real agent is reconciled by a follow-up `nemoclaw <name> status`.
      let validName: string;
      try {
        validName = validateName(name, "sandbox name");
      } catch {
        continue;
      }
      ephemeralSandboxes.push({
        ...buildRecoveredSandboxEntry(validName, metadata),
        recoveredFromGateway: true,
        livePhase: phase,
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

/**
 * Set the registry default to the requested name (or the session sandbox when
 * no default exists) once it is present in the registry, then return the
 * refreshed registry listing.
 */
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

/**
 * Reconcile the local sandbox registry against the onboard session and the live
 * OpenShell gateway. With a seed (existing entry, session, or requested name)
 * it actively recovers and persists entries; for an empty registry with no seed
 * (#5714) it performs a bounded, read-only gateway inspection and returns the
 * live sandboxes as display-only entries without persisting them. Returns the
 * registry listing plus `recoveredFromSession`/`recoveredFromGateway` markers.
 */
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
  // existing registry entries, a *confirmed* onboard session, or an explicit
  // requested name. With a seed we allow active gateway recovery (which may
  // select/start the named gateway) and persist recovered entries. Without one
  // — the #5714 empty-registry `list` case — restrict recovery to a read-only
  // inspection of any connected gateway so plain `nemoclaw list` never mutates
  // gateway state or persists entries as a side effect of listing.
  //
  // An *incomplete* session (sandboxName recorded but the sandbox step never
  // completed) is a phantom from an interrupted onboard (#2753); it must NOT
  // count as a seed, otherwise an empty registry + phantom session would take
  // the mutating/persisting seeded path instead of the safe display-only one.
  const hasConfirmedSession = isSessionSandboxConfirmed(session) && Boolean(session?.sandboxName);
  const hasRecoverySeed =
    current.sandboxes.length > 0 || hasConfirmedSession || Boolean(requestedSandboxName);
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
