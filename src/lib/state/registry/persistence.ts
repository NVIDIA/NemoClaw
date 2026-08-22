// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isObjectRecord } from "../../core/json-types";
import { GATEWAY_PORT } from "../../core/ports";
import { parseServingProfileProvenance } from "../../inference/serving/profile-provenance";
import { readConfigFile, writeConfigFile } from "../config-io";
import { normalizeExtraProviders } from "../extra-providers";
import { normalizeSandboxMcpState, serializeSandboxMcpStateForDisk } from "../registry-mcp";
import {
  cloneSandboxMessagingState,
  serializeSandboxMessagingStateForDisk,
} from "../registry-messaging";
import {
  normalizeSandboxPolicyAttribution,
  parseSandboxRegistryEntries,
  retainedDefaultSandbox,
} from "../registry-normalization";
import * as reversibleRemoval from "../registry-reversible-removal";
import { nemoclawStateRoot } from "../state-root";
import {
  cloneSandboxHostLocalInferenceProvenance,
  cloneSandboxHostLocalInferenceReceipt,
  requireSandboxHostLocalInferenceProvenance,
} from "./host-local-inference";
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

function cloneHostLocalInferenceReceiptOrThrow(
  value: SandboxEntry["hostLocalInferenceReceipt"],
  operation: "load" | "save",
): SandboxEntry["hostLocalInferenceReceipt"] {
  const receipt = cloneSandboxHostLocalInferenceReceipt(value);
  if (value !== undefined && receipt === undefined) {
    throw new Error(
      `Cannot ${operation} a sandbox entry with an invalid host-local inference receipt`,
    );
  }
  return receipt;
}

function cloneHostLocalInferenceProvenanceOrThrow(
  value: SandboxEntry["hostLocalInferenceProvenance"],
  receipt: SandboxEntry["hostLocalInferenceReceipt"],
  operation: "load" | "save",
): SandboxEntry["hostLocalInferenceProvenance"] {
  if (value === undefined) return undefined;
  const provenance = cloneSandboxHostLocalInferenceProvenance(value);
  if (!provenance || typeof receipt !== "string") {
    throw new Error(
      `Cannot ${operation} a sandbox entry with invalid host-local inference provenance`,
    );
  }
  try {
    return requireSandboxHostLocalInferenceProvenance(provenance, receipt);
  } catch {
    throw new Error(
      `Cannot ${operation} a sandbox entry with invalid host-local inference provenance`,
    );
  }
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

function normalizeSandboxEntryForRuntime(entry: SandboxEntry): SandboxEntry {
  const messaging = cloneSandboxMessagingState(entry.messaging);
  const workload = cloneSandboxWorkloadReceiptOrThrow(entry.workload, "load");
  const hostLocalInferenceReceipt = cloneHostLocalInferenceReceiptOrThrow(
    entry.hostLocalInferenceReceipt,
    "load",
  );
  const hostLocalInferenceProvenance = cloneHostLocalInferenceProvenanceOrThrow(
    entry.hostLocalInferenceProvenance,
    hostLocalInferenceReceipt,
    "load",
  );
  const servingProfileProvenance = cloneServingProfileProvenanceOrThrow(
    entry.servingProfileProvenance,
    "load",
  );
  const mcp = normalizeSandboxMcpState(entry.mcp);
  const policyEntry = normalizeSandboxPolicyAttribution(entry);
  const {
    cuaRuntimeReadiness: _legacyCuaRuntimeReadiness,
    messaging: _messaging,
    workload: _workload,
    hostLocalInferenceReceipt: _hostLocalInferenceReceipt,
    hostLocalInferenceProvenance: _hostLocalInferenceProvenance,
    servingProfileProvenance: _servingProfileProvenance,
    mcp: _mcp,
    ...rest
  } = policyEntry as SandboxEntry & { cuaRuntimeReadiness?: unknown };
  return {
    ...rest,
    ...(workload ? { workload } : {}),
    ...(hostLocalInferenceReceipt !== undefined ? { hostLocalInferenceReceipt } : {}),
    ...(hostLocalInferenceProvenance ? { hostLocalInferenceProvenance } : {}),
    ...(servingProfileProvenance ? { servingProfileProvenance } : {}),
    ...(messaging ? { messaging } : {}),
    ...(mcp ? { mcp } : {}),
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
  const hostLocalInferenceReceipt = cloneHostLocalInferenceReceiptOrThrow(
    durable.hostLocalInferenceReceipt,
    "save",
  );
  const hostLocalInferenceProvenance = cloneHostLocalInferenceProvenanceOrThrow(
    durable.hostLocalInferenceProvenance,
    hostLocalInferenceReceipt,
    "save",
  );
  const servingProfileProvenance = cloneServingProfileProvenanceOrThrow(
    durable.servingProfileProvenance,
    "save",
  );
  const mcp = serializeSandboxMcpStateForDisk(durable.mcp);
  const policyEntry = normalizeSandboxPolicyAttribution(durable);
  const {
    cuaRuntimeReadiness: _legacyCuaRuntimeReadiness,
    messaging: _messaging,
    workload: _workload,
    hostLocalInferenceReceipt: _hostLocalInferenceReceipt,
    hostLocalInferenceProvenance: _hostLocalInferenceProvenance,
    servingProfileProvenance: _servingProfileProvenance,
    mcp: _mcp,
    ...rest
  } = policyEntry as SandboxEntry & { cuaRuntimeReadiness?: unknown };
  return {
    ...rest,
    ...(rest.dashboardPort === 0 ? { dashboardPort: null } : {}),
    ...(workload ? { workload } : {}),
    ...(hostLocalInferenceReceipt !== undefined ? { hostLocalInferenceReceipt } : {}),
    ...(hostLocalInferenceProvenance ? { hostLocalInferenceProvenance } : {}),
    ...(servingProfileProvenance ? { servingProfileProvenance } : {}),
    ...(messaging ? { messaging } : {}),
    ...(mcp ? { mcp } : {}),
  };
}
