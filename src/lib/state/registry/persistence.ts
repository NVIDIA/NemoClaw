// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isObjectRecord } from "../../core/json-types";
import { GATEWAY_PORT } from "../../core/ports";
import { isCuaQualificationEnabled } from "../../cua/feature";
import { parseCuaRuntimeReadiness } from "../../cua/schema";
import { parseServingProfileProvenance } from "../../inference/serving/profile-provenance";
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
  normalizeCustomPolicyEntries,
  parseSandboxRegistryEntries,
  retainedDefaultSandbox,
} from "../registry-normalization";
import * as reversibleRemoval from "../registry-reversible-removal";
import { nemoclawStateRoot } from "../state-root";
import type { SandboxEntry, SandboxRegistry } from "./types";
import { cloneSandboxWorkloadReceipt } from "./workload";

const OPAQUE_CUA_RUNTIME_READINESS = Symbol("opaqueCuaRuntimeReadiness");

type RegistryWithOpaqueCuaState = SandboxRegistry & {
  [OPAQUE_CUA_RUNTIME_READINESS]?: Map<string, unknown>;
};

function opaqueCuaRuntimeReadiness(data: SandboxRegistry): Map<string, unknown> | undefined {
  return (data as RegistryWithOpaqueCuaState)[OPAQUE_CUA_RUNTIME_READINESS];
}

/** True when deep-off persistence is carrying an unread CUA record for this row. */
export function hasOpaqueCuaRuntimeReadiness(data: SandboxRegistry, name: string): boolean {
  return opaqueCuaRuntimeReadiness(data)?.has(name) === true;
}

/** Revoke a deep-off opaque CUA record before an authority-changing write. */
export function discardOpaqueCuaRuntimeReadiness(data: SandboxRegistry, name: string): void {
  opaqueCuaRuntimeReadiness(data)?.delete(name);
}

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

function cloneServingProfileProvenanceOrThrow(
  value: SandboxEntry["servingProfileProvenance"],
  operation: "load" | "save",
): SandboxEntry["servingProfileProvenance"] {
  const provenance = parseServingProfileProvenance(value);
  if (value !== undefined && !provenance) {
    throw new Error(`Cannot ${operation} a sandbox entry with invalid serving profile provenance`);
  }
  return provenance ?? undefined;
}

function normalizeCuaRuntimeReadiness(
  value: SandboxEntry["cuaRuntimeReadiness"],
): SandboxEntry["cuaRuntimeReadiness"] {
  if (value === undefined) return undefined;
  try {
    return parseCuaRuntimeReadiness(value);
  } catch {
    // A legacy or malformed optional CUA record must fail closed without
    // making unrelated sandbox rows or commands unloadable.
    return undefined;
  }
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
  const cuaQualificationEnabled = isCuaQualificationEnabled();
  const opaqueReadiness = new Map<string, unknown>();
  const sandboxes = Object.fromEntries(
    parseSandboxRegistryEntries(data.sandboxes).map(([name, entry]) => {
      if (
        !cuaQualificationEnabled &&
        Object.prototype.hasOwnProperty.call(entry, "cuaRuntimeReadiness")
      ) {
        // Preserve the raw JSON value only as private persistence metadata. It
        // is neither parsed nor returned to runtime callers while CUA is off.
        opaqueReadiness.set(name, entry.cuaRuntimeReadiness);
      }
      return [name, normalizeSandboxEntryForRuntime(entry, cuaQualificationEnabled)];
    }),
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
  if (opaqueReadiness.size > 0) {
    // Enumerable symbols survive the registry's immutable object spreads, but
    // JSON serialization and public entry iteration cannot expose this map.
    (base as RegistryWithOpaqueCuaState)[OPAQUE_CUA_RUNTIME_READINESS] = opaqueReadiness;
  }
  return base;
}

function serializeRegistryForDisk(data: SandboxRegistry): SandboxRegistry {
  const extraProviders = normalizeExtraProviders(data.extraProviders);
  const cuaQualificationEnabled = isCuaQualificationEnabled();
  const opaqueReadiness = opaqueCuaRuntimeReadiness(data);
  const sandboxes = Object.fromEntries(
    Object.entries(data.sandboxes).map(([name, entry]) => {
      const serialized = serializeSandboxEntryForDisk(entry, cuaQualificationEnabled);
      if (!cuaQualificationEnabled && opaqueReadiness?.has(name)) {
        serialized.cuaRuntimeReadiness = opaqueReadiness.get(name) as
          | SandboxEntry["cuaRuntimeReadiness"]
          | undefined;
      }
      return [name, serialized];
    }),
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

function normalizeSandboxEntryForRuntime(
  entry: SandboxEntry,
  cuaQualificationEnabled: boolean,
): SandboxEntry {
  const messaging = cloneSandboxMessagingState(entry.messaging);
  const workload = cloneSandboxWorkloadReceiptOrThrow(entry.workload, "load");
  const servingProfileProvenance = cloneServingProfileProvenanceOrThrow(
    entry.servingProfileProvenance,
    "load",
  );
  const mcp = normalizeSandboxMcpState(entry.mcp);
  const baselineExclusions = normalizeBaselineExclusions(entry.baselineExclusions);
  const baselineExclusionTransition = normalizeBaselineExclusionTransition(
    entry.baselineExclusionTransition,
  );
  const customPolicies = normalizeCustomPolicyEntries(entry.customPolicies);
  const cuaRuntimeReadiness = cuaQualificationEnabled
    ? normalizeCuaRuntimeReadiness(entry.cuaRuntimeReadiness)
    : undefined;
  const {
    messaging: _messaging,
    workload: _workload,
    servingProfileProvenance: _servingProfileProvenance,
    mcp: _mcp,
    baselineExclusions: _baselineExclusions,
    baselineExclusionTransition: _baselineExclusionTransition,
    customPolicies: _customPolicies,
    cuaRuntimeReadiness: _cuaRuntimeReadiness,
    ...rest
  } = entry;
  return {
    ...rest,
    ...(workload ? { workload } : {}),
    ...(servingProfileProvenance ? { servingProfileProvenance } : {}),
    ...(messaging ? { messaging } : {}),
    ...(mcp ? { mcp } : {}),
    ...(baselineExclusions ? { baselineExclusions } : {}),
    ...(baselineExclusionTransition ? { baselineExclusionTransition } : {}),
    ...(customPolicies ? { customPolicies } : {}),
    ...(cuaRuntimeReadiness ? { cuaRuntimeReadiness } : {}),
  };
}

/**
 * Prepare a sandbox entry for persistence: canonicalize a no-dashboard port to
 * null, normalize messaging state, and drop transient #5714 display-only
 * markers plus legacy provider credential hashes that must never reach
 * sandboxes.json.
 */
function serializeSandboxEntryForDisk(
  entry: SandboxEntry,
  cuaQualificationEnabled: boolean,
): SandboxEntry {
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
  const servingProfileProvenance = cloneServingProfileProvenanceOrThrow(
    durable.servingProfileProvenance,
    "save",
  );
  const mcp = serializeSandboxMcpStateForDisk(durable.mcp);
  const baselineExclusions = normalizeBaselineExclusions(durable.baselineExclusions);
  const baselineExclusionTransition = normalizeBaselineExclusionTransition(
    durable.baselineExclusionTransition,
  );
  const customPolicies = normalizeCustomPolicyEntries(durable.customPolicies);
  const cuaRuntimeReadiness = cuaQualificationEnabled
    ? normalizeCuaRuntimeReadiness(durable.cuaRuntimeReadiness)
    : undefined;
  const {
    messaging: _messaging,
    workload: _workload,
    servingProfileProvenance: _servingProfileProvenance,
    mcp: _mcp,
    baselineExclusions: _baselineExclusions,
    baselineExclusionTransition: _baselineExclusionTransition,
    customPolicies: _customPolicies,
    cuaRuntimeReadiness: _cuaRuntimeReadiness,
    ...rest
  } = durable;
  return {
    ...rest,
    ...(rest.dashboardPort === 0 ? { dashboardPort: null } : {}),
    ...(workload ? { workload } : {}),
    ...(servingProfileProvenance ? { servingProfileProvenance } : {}),
    ...(messaging ? { messaging } : {}),
    ...(mcp ? { mcp } : {}),
    ...(baselineExclusions ? { baselineExclusions } : {}),
    ...(baselineExclusionTransition ? { baselineExclusionTransition } : {}),
    ...(customPolicies ? { customPolicies } : {}),
    ...(cuaRuntimeReadiness ? { cuaRuntimeReadiness } : {}),
  };
}
