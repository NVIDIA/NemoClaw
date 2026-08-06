// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isObjectRecord } from "../../core/json-types";
import { GATEWAY_PORT } from "../../core/ports";
import { getCuaRuntimeReadinessDigest } from "../../cua/contract";
import {
  createCuaReconciliationState,
  parseCuaReconciliationState,
  requireCuaReconciliation,
} from "../../cua/reconciliation";
import {
  parseCuaRuntimeReadiness,
  parseCuaSecurityAttestation,
  parseCuaTargetAttachment,
  parseCuaTaskResult,
} from "../../cua/schema";
import { readConfigFile, writeConfigFile } from "../config-io";
import { normalizeExtraProviders } from "../extra-providers";
import { normalizeSandboxMcpState, serializeSandboxMcpStateForDisk } from "../registry-mcp";
import {
  cloneSandboxMessagingState,
  serializeSandboxMessagingStateForDisk,
} from "../registry-messaging";
import {
  normalizeBaselineExclusions,
  normalizeBaselineExclusionTransition,
  parseSandboxRegistryEntries,
  retainedDefaultSandbox,
} from "../registry-normalization";
import * as reversibleRemoval from "../registry-reversible-removal";
import { nemoclawStateRoot } from "../state-root";
import type { SandboxEntry, SandboxRegistry } from "./types";
import { cloneSandboxWorkloadReceipt } from "./workload";

function cloneSandboxWorkloadReceiptOrThrow(
  value: SandboxEntry["workload"],
  operation: "load" | "save",
): SandboxEntry["workload"] {
  const workload = cloneSandboxWorkloadReceipt(value);
  if (value !== undefined && workload === undefined) {
    throw new Error(`Cannot ${operation} a sandbox entry with an invalid workload receipt`);
  }
  return workload;
}

export const REGISTRY_FILE = path.join(
  nemoclawStateRoot(process.env.HOME || "/tmp", GATEWAY_PORT),
  "sandboxes.json",
);
export function load(): SandboxRegistry {
  return normalizeRegistry(
    readConfigFile<unknown>(REGISTRY_FILE, { sandboxes: {}, defaultSandbox: null }),
  );
}

export function save(data: SandboxRegistry): void {
  writeConfigFile(REGISTRY_FILE, serializeRegistryForDisk(data));
}

function normalizeRegistry(value: unknown): SandboxRegistry {
  const data = isObjectRecord(value) ? value : {};
  const extraProviders = normalizeExtraProviders(data.extraProviders);
  const sandboxes = Object.fromEntries(
    parseSandboxRegistryEntries(data.sandboxes).map(([name, entry]) => [
      name,
      normalizeSandboxEntryForRuntime(entry),
    ]),
  );
  const base: SandboxRegistry = {
    // Preserve a stale string pointer at read time so diagnostics can explain
    // which sandbox disappeared. Mutation paths repair it before persistence.
    defaultSandbox: typeof data.defaultSandbox === "string" ? data.defaultSandbox : null,
    defaultSelectionRevision: reversibleRemoval.normalizeDefaultSelectionRevision(
      data.defaultSelectionRevision,
    ),
    sandboxes,
  };
  if (extraProviders) base.extraProviders = extraProviders;
  return base;
}

function serializeRegistryForDisk(data: SandboxRegistry): SandboxRegistry {
  const extraProviders = normalizeExtraProviders(data.extraProviders);
  const sandboxes = Object.fromEntries(
    Object.entries(data.sandboxes).map(([name, entry]) => [
      name,
      serializeSandboxEntryForDisk(entry),
    ]),
  );
  const defaultSandbox = retainedDefaultSandbox(data.defaultSandbox, sandboxes);
  const currentDefaultSelectionRevision = reversibleRemoval.normalizeDefaultSelectionRevision(
    data.defaultSelectionRevision,
  );
  const base: SandboxRegistry = {
    defaultSandbox,
    defaultSelectionRevision:
      defaultSandbox === data.defaultSandbox
        ? currentDefaultSelectionRevision
        : reversibleRemoval.incrementDefaultSelectionRevision(currentDefaultSelectionRevision),
    sandboxes,
  };
  if (extraProviders) base.extraProviders = extraProviders;
  return base;
}

type NormalizedCuaFields = Pick<
  SandboxEntry,
  | "cuaRuntimeReadiness"
  | "cuaTarget"
  | "cuaSecurityAttestation"
  | "cuaTaskResults"
  | "cuaReconciliation"
>;

const CUA_REGISTRY_RECOVERY_ATTEMPT_ID = "00000000-0000-4000-8000-000000000000";

function createCuaRegistryRecoveryGate(): NonNullable<SandboxEntry["cuaReconciliation"]> {
  // Persisted CUA fields are an untrusted recovery boundary. A malformed
  // parent must still leave a durable deny gate, but none of its identities
  // are safe to copy into that gate until their complete record has parsed.
  return createCuaReconciliationState({
    trigger: "registry-recovery",
    attemptId: CUA_REGISTRY_RECOVERY_ATTEMPT_ID,
  });
}

function hasPersistedCuaDependentAuthority(entry: SandboxEntry): boolean {
  return (
    entry.cuaTarget !== undefined ||
    entry.cuaSecurityAttestation !== undefined ||
    entry.cuaTaskResults !== undefined
  );
}

function normalizeCuaReconciliationForRuntime(
  entry: SandboxEntry,
): SandboxEntry["cuaReconciliation"] {
  if (entry.cuaReconciliation === undefined) return undefined;
  try {
    const parsed = parseCuaReconciliationState(entry.cuaReconciliation);
    return parsed.phase === "pending" ? requireCuaReconciliation(parsed) : parsed;
  } catch {
    // A malformed journal must never turn an uncertain external effect back
    // into ordinary lifecycle authority. Preserve a closed recovery gate while
    // dropping every untrusted field from the malformed record.
    return createCuaRegistryRecoveryGate();
  }
}

/**
 * Treat CUA rows as one optional authority chain. Legacy or malformed CUA
 * fields must not make unrelated sandbox commands unable to load the registry,
 * while a broken parent record must never leave its derived authority usable.
 */
function normalizeCuaFieldsForRuntime(entry: SandboxEntry): NormalizedCuaFields {
  let cuaReconciliation = normalizeCuaReconciliationForRuntime(entry);
  const normalized: NormalizedCuaFields = {};
  const requireRegistryRecovery = (): void => {
    cuaReconciliation = createCuaRegistryRecoveryGate();
    normalized.cuaReconciliation = cuaReconciliation;
    delete normalized.cuaSecurityAttestation;
    delete normalized.cuaTaskResults;
  };
  if (cuaReconciliation) normalized.cuaReconciliation = cuaReconciliation;

  let cuaTarget: SandboxEntry["cuaTarget"];
  if (entry.cuaTarget !== undefined) {
    try {
      cuaTarget = parseCuaTargetAttachment(entry.cuaTarget);
    } catch {
      requireRegistryRecovery();
    }
  }

  if (entry.cuaRuntimeReadiness === undefined) {
    if (hasPersistedCuaDependentAuthority(entry)) requireRegistryRecovery();
    if (cuaTarget) normalized.cuaTarget = cuaTarget;
    return normalized;
  }

  try {
    normalized.cuaRuntimeReadiness = parseCuaRuntimeReadiness(entry.cuaRuntimeReadiness);
  } catch {
    if (hasPersistedCuaDependentAuthority(entry)) requireRegistryRecovery();
    if (cuaTarget) normalized.cuaTarget = cuaTarget;
    return normalized;
  }

  if (entry.cuaTarget === undefined) {
    if (entry.cuaSecurityAttestation !== undefined || entry.cuaTaskResults !== undefined) {
      requireRegistryRecovery();
    }
    return normalized;
  }
  if (!cuaTarget) return normalized;
  normalized.cuaTarget = cuaTarget;
  if (
    cuaTarget.runtimeReadinessDigest !==
    getCuaRuntimeReadinessDigest(normalized.cuaRuntimeReadiness)
  ) {
    requireRegistryRecovery();
    return normalized;
  }
  if (cuaReconciliation) return normalized;
  if (!cuaTarget.target || entry.cuaSecurityAttestation === undefined) {
    if (entry.cuaSecurityAttestation !== undefined || entry.cuaTaskResults !== undefined) {
      requireRegistryRecovery();
    }
    return normalized;
  }

  try {
    normalized.cuaSecurityAttestation = parseCuaSecurityAttestation(entry.cuaSecurityAttestation);
  } catch {
    requireRegistryRecovery();
    return normalized;
  }
  if (entry.cuaTaskResults === undefined) return normalized;

  try {
    if (!Array.isArray(entry.cuaTaskResults)) {
      requireRegistryRecovery();
      return normalized;
    }
    normalized.cuaTaskResults = entry.cuaTaskResults.slice(-16).map(parseCuaTaskResult);
  } catch {
    requireRegistryRecovery();
  }
  return normalized;
}

function normalizeSandboxEntryForRuntime(entry: SandboxEntry): SandboxEntry {
  const messaging = cloneSandboxMessagingState(entry.messaging);
  const workload = cloneSandboxWorkloadReceiptOrThrow(entry.workload, "load");
  const mcp = normalizeSandboxMcpState(entry.mcp);
  const baselineExclusions = normalizeBaselineExclusions(entry.baselineExclusions);
  const baselineExclusionTransition = normalizeBaselineExclusionTransition(
    entry.baselineExclusionTransition,
  );
  const cua = normalizeCuaFieldsForRuntime(entry);
  const {
    messaging: _messaging,
    workload: _workload,
    mcp: _mcp,
    baselineExclusions: _baselineExclusions,
    baselineExclusionTransition: _baselineExclusionTransition,
    cuaRuntimeReadiness: _cuaRuntimeReadiness,
    cuaTarget: _cuaTarget,
    cuaSecurityAttestation: _cuaSecurityAttestation,
    cuaTaskResults: _cuaTaskResults,
    cuaReconciliation: _cuaReconciliation,
    ...rest
  } = entry;
  return {
    ...rest,
    ...(workload ? { workload } : {}),
    ...(messaging ? { messaging } : {}),
    ...(mcp ? { mcp } : {}),
    ...(baselineExclusions ? { baselineExclusions } : {}),
    ...(baselineExclusionTransition ? { baselineExclusionTransition } : {}),
    ...cua,
  };
}

/**
 * Prepare a sandbox entry for persistence: canonicalize a no-dashboard port to
 * null, normalize messaging state, and drop transient #5714 display-only
 * markers plus legacy provider credential hashes that must never reach
 * sandboxes.json.
 */
function serializeSandboxEntryForDisk(entry: SandboxEntry): SandboxEntry {
  // Defensively drop non-durable recovery markers and legacy
  // providerCredentialHashes so they can never reach sandboxes.json even if a
  // caller force-passed them through updateSandbox().
  const {
    recoveredFromGateway: _recovered,
    livePhase: _phase,
    providerCredentialHashes: _legacyProviderCredentialHashes,
    ...durable
  } = entry as SandboxEntry & {
    recoveredFromGateway?: boolean;
    livePhase?: string | null;
    providerCredentialHashes?: unknown;
  };
  const messaging = serializeSandboxMessagingStateForDisk(durable.messaging);
  const workload = cloneSandboxWorkloadReceiptOrThrow(durable.workload, "save");
  const mcp = serializeSandboxMcpStateForDisk(durable.mcp);
  const baselineExclusions = normalizeBaselineExclusions(durable.baselineExclusions);
  const baselineExclusionTransition = normalizeBaselineExclusionTransition(
    durable.baselineExclusionTransition,
  );
  const cuaReconciliation =
    durable.cuaReconciliation === undefined
      ? undefined
      : parseCuaReconciliationState(durable.cuaReconciliation);
  const cuaRuntimeReadiness =
    durable.cuaRuntimeReadiness === undefined
      ? undefined
      : parseCuaRuntimeReadiness(durable.cuaRuntimeReadiness);
  const cuaTarget =
    durable.cuaTarget === undefined ? undefined : parseCuaTargetAttachment(durable.cuaTarget);
  const cuaSecurityAttestation =
    cuaReconciliation || durable.cuaSecurityAttestation === undefined
      ? undefined
      : parseCuaSecurityAttestation(durable.cuaSecurityAttestation);
  const cuaTaskResults =
    cuaReconciliation || durable.cuaTaskResults === undefined
      ? undefined
      : durable.cuaTaskResults.slice(-16).map(parseCuaTaskResult);
  const {
    messaging: _messaging,
    workload: _workload,
    mcp: _mcp,
    baselineExclusions: _baselineExclusions,
    baselineExclusionTransition: _baselineExclusionTransition,
    cuaRuntimeReadiness: _cuaRuntimeReadiness,
    cuaTarget: _cuaTarget,
    cuaSecurityAttestation: _cuaSecurityAttestation,
    cuaTaskResults: _cuaTaskResults,
    cuaReconciliation: _cuaReconciliation,
    ...rest
  } = durable;
  return {
    ...rest,
    ...(rest.dashboardPort === 0 ? { dashboardPort: null } : {}),
    ...(workload ? { workload } : {}),
    ...(messaging ? { messaging } : {}),
    ...(mcp ? { mcp } : {}),
    ...(baselineExclusions ? { baselineExclusions } : {}),
    ...(baselineExclusionTransition ? { baselineExclusionTransition } : {}),
    ...(cuaRuntimeReadiness ? { cuaRuntimeReadiness } : {}),
    ...(cuaTarget ? { cuaTarget } : {}),
    ...(cuaSecurityAttestation ? { cuaSecurityAttestation } : {}),
    ...(cuaTaskResults ? { cuaTaskResults } : {}),
    ...(cuaReconciliation ? { cuaReconciliation } : {}),
  };
}
