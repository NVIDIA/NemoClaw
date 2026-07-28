// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { isObjectRecord } from "../../core/json-types";
import { GATEWAY_PORT } from "../../core/ports";
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
  const mcp = normalizeSandboxMcpState(entry.mcp);
  const baselineExclusions = normalizeBaselineExclusions(entry.baselineExclusions);
  const baselineExclusionTransition = normalizeBaselineExclusionTransition(
    entry.baselineExclusionTransition,
  );
  const {
    messaging: _messaging,
    mcp: _mcp,
    baselineExclusions: _baselineExclusions,
    baselineExclusionTransition: _baselineExclusionTransition,
    ...rest
  } = entry;
  return {
    ...rest,
    ...(messaging ? { messaging } : {}),
    ...(mcp ? { mcp } : {}),
    ...(baselineExclusions ? { baselineExclusions } : {}),
    ...(baselineExclusionTransition ? { baselineExclusionTransition } : {}),
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
  const mcp = serializeSandboxMcpStateForDisk(durable.mcp);
  const baselineExclusions = normalizeBaselineExclusions(durable.baselineExclusions);
  const baselineExclusionTransition = normalizeBaselineExclusionTransition(
    durable.baselineExclusionTransition,
  );
  const {
    messaging: _messaging,
    mcp: _mcp,
    baselineExclusions: _baselineExclusions,
    baselineExclusionTransition: _baselineExclusionTransition,
    ...rest
  } = durable;
  return {
    ...rest,
    ...(rest.dashboardPort === 0 ? { dashboardPort: null } : {}),
    ...(messaging ? { messaging } : {}),
    ...(mcp ? { mcp } : {}),
    ...(baselineExclusions ? { baselineExclusions } : {}),
    ...(baselineExclusionTransition ? { baselineExclusionTransition } : {}),
  };
}
