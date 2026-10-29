// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import path from "node:path";

import { listInferenceRouteOwnersAcrossGatewayRoots } from "../../state/registry/cross-port";
import type { SandboxEntry } from "../../state/registry";
import { parseLiveSandboxEntries } from "../../runtime-recovery";
import {
  isLocalOllamaRouteOwner,
  readLocalAdapterJsonFile,
  removeLocalAdapterFile,
  resolveSharedLocalAdapterStateRoot,
  type OllamaHostRoute,
  writeLocalAdapterJsonFile,
} from "../local-adapter-lifecycle";
import { ollamaModelRefsMatch } from "./model-discovery";

export { isLocalOllamaRouteOwner } from "../local-adapter-lifecycle";
export type { OllamaHostRoute, OllamaRouteHolder } from "../local-adapter-lifecycle";

const PENDING_CLEANUP_DIRECTORY = "ollama-pending-model-cleanup";
const SAFE_SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SANDBOX_IDENTITY_FINGERPRINT = /^[a-f0-9]{64}$/u;

type PendingCleanupOwner = {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly gatewayPort: number;
  readonly lifecycleGeneration: string;
  readonly lifecycleLiveIdentityFingerprint: string;
};

/** Durable identity required to read or mutate pending cleanup receipts. */
export type OllamaModelCleanupOwner = Pick<
  SandboxEntry,
  | "name"
  | "gatewayName"
  | "gatewayPort"
  | "lifecycleGeneration"
  | "lifecycleLiveIdentityFingerprint"
>;

/** The registry fields an Ollama GPU-release decision reads. */
export type OllamaModelHolder = Pick<
  SandboxEntry,
  | "name"
  | "provider"
  | "model"
  | "endpointUrl"
  | "gatewayName"
  | "gatewayPort"
  | "lifecycleGeneration"
  | "lifecycleLiveIdentityFingerprint"
>;

function pendingCleanupOwner(owner: OllamaModelCleanupOwner): PendingCleanupOwner | null {
  if (!owner || typeof owner.name !== "string" || !SAFE_SANDBOX_NAME.test(owner.name)) {
    throw new Error(`Invalid sandbox name for pending Ollama cleanup: ${String(owner?.name)}`);
  }
  const gatewayName = typeof owner.gatewayName === "string" ? owner.gatewayName.trim() : "";
  const gatewayPort = owner.gatewayPort;
  const lifecycleGeneration =
    typeof owner.lifecycleGeneration === "string" ? owner.lifecycleGeneration.trim() : "";
  const lifecycleLiveIdentityFingerprint =
    typeof owner.lifecycleLiveIdentityFingerprint === "string"
      ? owner.lifecycleLiveIdentityFingerprint.trim()
      : "";
  if (
    !gatewayName ||
    !Number.isInteger(gatewayPort) ||
    gatewayPort === null ||
    gatewayPort === undefined ||
    gatewayPort < 1 ||
    gatewayPort > 65_535 ||
    !lifecycleGeneration ||
    lifecycleGeneration.length > 256 ||
    !lifecycleLiveIdentityFingerprint ||
    !SANDBOX_IDENTITY_FINGERPRINT.test(lifecycleLiveIdentityFingerprint)
  ) {
    return null;
  }
  return {
    sandboxName: owner.name,
    gatewayName,
    gatewayPort,
    lifecycleGeneration,
    lifecycleLiveIdentityFingerprint,
  };
}

function pendingCleanupPath(owner: PendingCleanupOwner, stateRoot: string): string {
  const identity = createHash("sha256").update(JSON.stringify(owner)).digest("hex");
  return path.join(stateRoot, PENDING_CLEANUP_DIRECTORY, `${identity}.json`);
}

function legacyPendingCleanupPath(sandboxName: string, stateRoot: string): string {
  return path.join(stateRoot, PENDING_CLEANUP_DIRECTORY, `${sandboxName}.json`);
}

function validPendingModel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    !/[\u0000\r\n]/u.test(value)
  );
}

function pendingRecordMatchesOwner(
  record: Record<string, unknown> | null,
  owner: PendingCleanupOwner,
): record is Record<string, unknown> & { models: unknown[] } {
  const recordedOwner = record?.owner;
  return (
    record?.schemaVersion === 2 &&
    record.sandboxName === owner.sandboxName &&
    typeof recordedOwner === "object" &&
    recordedOwner !== null &&
    !Array.isArray(recordedOwner) &&
    (recordedOwner as PendingCleanupOwner).sandboxName === owner.sandboxName &&
    (recordedOwner as PendingCleanupOwner).gatewayName === owner.gatewayName &&
    (recordedOwner as PendingCleanupOwner).gatewayPort === owner.gatewayPort &&
    (recordedOwner as PendingCleanupOwner).lifecycleGeneration === owner.lifecycleGeneration &&
    (recordedOwner as PendingCleanupOwner).lifecycleLiveIdentityFingerprint ===
      owner.lifecycleLiveIdentityFingerprint &&
    Array.isArray(record.models)
  );
}

export function loadPendingOllamaModelCleanup(
  owner: OllamaModelCleanupOwner,
  stateRoot: string = resolveSharedLocalAdapterStateRoot(),
): readonly string[] {
  const identity = pendingCleanupOwner(owner);
  const legacyRecord = readLocalAdapterJsonFile(legacyPendingCleanupPath(owner.name, stateRoot));
  const legacyModels =
    legacyRecord?.schemaVersion === 1 &&
    legacyRecord.sandboxName === owner.name &&
    Array.isArray(legacyRecord.models)
      ? legacyRecord.models.filter(validPendingModel)
      : [];
  if (legacyModels.length > 0) {
    console.warn(
      `  Warning: legacy pending Ollama cleanup for '${owner.name}' lists ${legacyModels.join(", ")} but has no gateway/lifecycle identity. NemoClaw left it untouched because these model names do not establish ownership.`,
    );
  }
  if (!identity) return [];
  const record = readLocalAdapterJsonFile(pendingCleanupPath(identity, stateRoot));
  return pendingRecordMatchesOwner(record, identity) ? record.models.filter(validPendingModel) : [];
}

export function persistPendingOllamaModelCleanup(
  owner: OllamaModelCleanupOwner,
  models: readonly string[],
  stateRoot: string = resolveSharedLocalAdapterStateRoot(),
): void {
  const identity = pendingCleanupOwner(owner);
  if (!identity) {
    throw new Error(
      "Cannot persist pending Ollama cleanup without complete sandbox ownership identity",
    );
  }
  const receiptPath = pendingCleanupPath(identity, stateRoot);
  const record = readLocalAdapterJsonFile(receiptPath);
  if (record && !pendingRecordMatchesOwner(record, identity)) {
    throw new Error(
      "Refusing to replace a pending Ollama cleanup receipt with a different owner identity",
    );
  }
  const pending = pendingRecordMatchesOwner(record, identity)
    ? [...record.models.filter(validPendingModel)]
    : [];
  for (const model of models) {
    const normalized = model.trim();
    if (!validPendingModel(normalized)) continue;
    if (!pending.some((existing) => ollamaModelRefsMatch(existing, normalized))) {
      pending.push(normalized);
    }
  }
  if (pending.length === 0) return;
  writeLocalAdapterJsonFile(receiptPath, {
    schemaVersion: 2,
    sandboxName: identity.sandboxName,
    owner: identity,
    models: pending,
  });
}

export function clearPendingOllamaModelCleanup(
  owner: OllamaModelCleanupOwner,
  releasedModels?: readonly string[],
  stateRoot: string = resolveSharedLocalAdapterStateRoot(),
): void {
  const identity = pendingCleanupOwner(owner);
  if (!identity) return;
  const receiptPath = pendingCleanupPath(identity, stateRoot);
  const record = readLocalAdapterJsonFile(receiptPath);
  if (!pendingRecordMatchesOwner(record, identity)) return;
  if (!releasedModels) {
    removeLocalAdapterFile(receiptPath);
    return;
  }
  const remaining = record.models
    .filter(validPendingModel)
    .filter(
      (pending) => !releasedModels.some((released) => ollamaModelRefsMatch(pending, released)),
    );
  if (remaining.length === 0) {
    removeLocalAdapterFile(receiptPath);
    return;
  }
  writeLocalAdapterJsonFile(receiptPath, {
    schemaVersion: 2,
    sandboxName: identity.sandboxName,
    owner: identity,
    models: remaining,
  });
}

export type OllamaModelRoute = Pick<SandboxEntry, "provider" | "model" | "endpointUrl">;

export type OllamaActiveOwnershipDiscovery =
  | {
      readonly ok: true;
      /** Names for logs and legacy callers; ownership decisions prefer the rows below. */
      readonly activeSandboxNames: ReadonlySet<string>;
      /** Live peer rows retain gateway identity when names collide across roots. */
      readonly activePeers?: ReadonlySet<OllamaModelHolder>;
      readonly gatewayChecks: readonly {
        readonly activeSandboxes: readonly string[];
        readonly gateway: string;
      }[];
    }
  | { readonly ok: false; readonly message: string };

export type OllamaActiveOwnershipDiscoveryFn = (
  peers: readonly OllamaModelHolder[],
  environment: NodeJS.ProcessEnv,
) => OllamaActiveOwnershipDiscovery;

export type OllamaOwnershipPhaseCapture = (
  gatewayName: string,
  environment: NodeJS.ProcessEnv,
) => { readonly output: string; readonly status: number | null };

export type OllamaOwnershipDiscoveryDeps = {
  readonly parseLiveSandboxEntries?: typeof parseLiveSandboxEntries;
  readonly resolvePersistedSandboxOwnershipGateway?: (sandbox: OllamaModelHolder) => string;
};

export type OllamaModelOwnershipDecision =
  | { readonly kind: "missing-model" }
  | {
      readonly kind: "exclusive";
      readonly model: string;
      readonly stalePeers: readonly string[];
    }
  | {
      readonly kind: "shared-active";
      readonly model: string;
      readonly activePeers: readonly string[];
      readonly stalePeers: readonly string[];
    };

/**
 * Decide whether this sandbox's Ollama model has another active owner.
 *
 * Registry rows can outlive stopped sandboxes and include incomplete
 * onboarding reservations. Live discovery must account for every requested
 * peer: a matching peer omitted from a successful gateway inventory makes
 * ownership inconclusive and must not authorize release. The names set remains
 * a legacy fallback for callers that do not provide gateway-aware peer rows.
 */
export function listOllamaModelOwnershipPeersAcrossGatewayRoots(): SandboxEntry[] {
  return listInferenceRouteOwnersAcrossGatewayRoots();
}

export function matchingOllamaModelPeers<T extends OllamaModelHolder>(
  sandbox: OllamaModelHolder,
  peers: readonly T[],
  selectedHost: OllamaHostRoute | null = null,
): T[] {
  const model = sandbox.model?.trim();
  if (!model) return [];
  return peers.filter((peer) => {
    const gatewayPortsKnown =
      peer.gatewayPort !== null &&
      peer.gatewayPort !== undefined &&
      sandbox.gatewayPort !== null &&
      sandbox.gatewayPort !== undefined;
    const gatewayNamesKnown =
      peer.gatewayName !== null &&
      peer.gatewayName !== undefined &&
      sandbox.gatewayName !== null &&
      sandbox.gatewayName !== undefined;
    const peerHasGatewayIdentity = peer.gatewayName != null || peer.gatewayPort != null;
    const sandboxHasGatewayIdentity = sandbox.gatewayName != null || sandbox.gatewayPort != null;
    const sameSandbox =
      peer.name === sandbox.name &&
      (gatewayPortsKnown
        ? peer.gatewayPort === sandbox.gatewayPort
        : gatewayNamesKnown
          ? peer.gatewayName === sandbox.gatewayName
          : !peerHasGatewayIdentity && !sandboxHasGatewayIdentity);
    return (
      !sameSandbox &&
      isLocalOllamaRouteOwner(peer, selectedHost) &&
      !!peer.model &&
      ollamaModelRefsMatch(peer.model, model)
    );
  });
}

export function decideOllamaModelOwnership(
  sandbox: OllamaModelHolder,
  peers: readonly OllamaModelHolder[],
  activeSandboxNames: ReadonlySet<string>,
  selectedHost: OllamaHostRoute | null = null,
  activePeers?: ReadonlySet<OllamaModelHolder>,
): OllamaModelOwnershipDecision {
  const model = sandbox.model?.trim();
  if (!model) return { kind: "missing-model" };

  const matchingPeers = matchingOllamaModelPeers(sandbox, peers, selectedHost);
  const isActive = (peer: OllamaModelHolder): boolean =>
    activePeers ? activePeers.has(peer) : activeSandboxNames.has(peer.name);
  const activePeerNames = matchingPeers
    .filter(isActive)
    .map((peer) => peer.name)
    .sort();
  const stalePeers = matchingPeers
    .filter((peer) => !isActive(peer))
    .map((peer) => peer.name)
    .sort();

  return activePeerNames.length > 0
    ? { kind: "shared-active", model, activePeers: activePeerNames, stalePeers }
    : { kind: "exclusive", model, stalePeers };
}

/**
 * Conservative compatibility helper for callers that do not probe live state.
 * Every matching registry peer remains protected on those paths.
 */
export function discoverOllamaModelOwnership(
  peers: readonly OllamaModelHolder[],
  environment: NodeJS.ProcessEnv,
  capturePhases: OllamaOwnershipPhaseCapture,
  deps: OllamaOwnershipDiscoveryDeps = {},
): OllamaActiveOwnershipDiscovery {
  const parseEntries = deps.parseLiveSandboxEntries ?? parseLiveSandboxEntries;
  if (peers.length === 0) {
    return { ok: true, activeSandboxNames: new Set(), activePeers: new Set(), gatewayChecks: [] };
  }
  const resolveGateway = deps.resolvePersistedSandboxOwnershipGateway;
  if (!resolveGateway) {
    return {
      ok: false,
      message: "could not resolve a sibling gateway: gateway binding resolver is unavailable",
    };
  }

  const peersByGateway = new Map<string, OllamaModelHolder[]>();
  try {
    for (const peer of peers) {
      const gateway = resolveGateway(peer);
      const gatewayPeers = peersByGateway.get(gateway) ?? [];
      gatewayPeers.push(peer);
      peersByGateway.set(gateway, gatewayPeers);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `could not resolve a sibling gateway: ${detail}` };
  }

  const activeSandboxNames = new Set<string>();
  const activePeers = new Set<OllamaModelHolder>();
  const gatewayChecks: Array<{ activeSandboxes: string[]; gateway: string }> = [];
  for (const [gateway, gatewayPeers] of peersByGateway) {
    let result;
    try {
      result = capturePhases(gateway, environment);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `OpenShell could not list gateway '${gateway}': ${detail}` };
    }
    if (result.status !== 0) {
      const detail = result.output.trim().replace(/\s+/g, " ").slice(0, 300);
      return {
        ok: false,
        message: `OpenShell could not list sandbox phases on gateway '${gateway}'${
          detail ? `: ${detail}` : ""
        }`,
      };
    }
    const phases = new Map(parseEntries(result.output).map((entry) => [entry.name, entry.phase]));
    const activeSandboxes: string[] = [];
    for (const peer of gatewayPeers) {
      const phase = phases.get(peer.name);
      if (phase === undefined) {
        return {
          ok: false,
          message: `OpenShell omitted sibling '${peer.name}' from the sandbox phase inventory on gateway '${gateway}'`,
        };
      }
      if (phase === "Stopped" || phase === "Error" || phase === "Failed" || phase === "Evicted") {
        continue;
      }
      if (phase === null || phase === "Unknown") {
        return {
          ok: false,
          message: `OpenShell returned no usable phase for sibling '${peer.name}' on gateway '${gateway}'`,
        };
      }
      activeSandboxNames.add(peer.name);
      activePeers.add(peer);
      activeSandboxes.push(peer.name);
    }
    gatewayChecks.push({ activeSandboxes, gateway });
  }
  return { ok: true, activeSandboxNames, activePeers, gatewayChecks };
}

/**
 * The Ollama model a re-onboard just superseded, or null when nothing is safe
 * to release (#9110).
 *
 * The decision is keyed on the model reference, never on the provider name. A
 * provider switch that keeps the same model can still be served by the same
 * host daemon — an operator may move an `ollama-local` sandbox onto a
 * `compatible-endpoint` route pointed back at `http://127.0.0.1:11434/v1`.
 * Releasing there would evict the model the new route was just proven against.
 * Comparing model refs is strictly conservative: it can only miss a release,
 * never evict a model the new route still uses.
 */
export function supersededOllamaModelWithActivePeers(
  previous: OllamaModelHolder | null,
  next: OllamaModelRoute,
  peers: readonly OllamaModelHolder[],
  activeSandboxNames: ReadonlySet<string>,
  selectedHost: OllamaHostRoute | null = null,
  activePeers?: ReadonlySet<OllamaModelHolder>,
): string | null {
  if (!previous || !isLocalOllamaRouteOwner(previous, selectedHost)) return null;
  const ownership = decideOllamaModelOwnership(
    previous,
    peers,
    activeSandboxNames,
    selectedHost,
    activePeers,
  );
  if (ownership.kind !== "exclusive") return null;
  const nextModel = next.model?.trim();
  if (!nextModel) return null;
  return isLocalOllamaRouteOwner(next, selectedHost) &&
    ollamaModelRefsMatch(ownership.model, nextModel)
    ? null
    : ownership.model;
}
