// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CAPABILITY_BOM_SCHEMA_VERSION,
  CAPABILITY_PLATFORMS,
  type CapabilityBillOfMaterialsItemV1,
  type CapabilityBillOfMaterialsV1,
  type CapabilityCatalogEntryV1,
  type CapabilityPlatform,
  CapabilityProvisioningContractError,
  capabilityBomFingerprint,
  parseCapabilityCatalogV1,
  parseCapabilityManifestV1,
} from "./contract";

export interface ResolveCapabilityBillOfMaterialsInput {
  readonly manifest: unknown;
  readonly catalog: unknown;
  readonly platform: CapabilityPlatform;
}

export function resolveCapabilityBillOfMaterials({
  manifest: manifestInput,
  catalog: catalogInput,
  platform,
}: ResolveCapabilityBillOfMaterialsInput): CapabilityBillOfMaterialsV1 {
  if (!(CAPABILITY_PLATFORMS as readonly string[]).includes(platform)) {
    throw new CapabilityProvisioningContractError(
      `requested platform must be one of: ${CAPABILITY_PLATFORMS.join(", ")}`,
    );
  }
  const manifest = parseCapabilityManifestV1(manifestInput);
  const catalog = parseCapabilityCatalogV1(catalogInput);
  const entries = new Map(catalog.capabilities.map((entry) => [entry.id, entry]));
  const requested = new Set(manifest.capabilities.map(({ id }) => id));
  const resolving = new Set<string>();
  const resolved = new Map<string, CapabilityBillOfMaterialsItemV1>();

  const visit = (id: string): void => {
    if (resolved.has(id)) return;
    if (resolving.has(id)) {
      throw new CapabilityProvisioningContractError(
        `catalog capability dependency cycle includes '${id}'`,
      );
    }
    const entry = entries.get(id);
    if (entry === undefined) {
      throw new CapabilityProvisioningContractError(`manifest requests unknown capability '${id}'`);
    }
    const request = manifest.capabilities.find((candidate) => candidate.id === id);
    if (
      request?.version !== null &&
      request?.version !== undefined &&
      request.version !== entry.version
    ) {
      throw new CapabilityProvisioningContractError(
        `manifest capability '${id}' requires version '${request.version}', catalog provides '${entry.version}'`,
      );
    }
    if (!entry.agents.includes(manifest.agent)) {
      throw new CapabilityProvisioningContractError(
        `capability '${id}' does not support agent '${manifest.agent}'`,
      );
    }
    const artifact = entry.artifacts.find((candidate) => candidate.platform === platform);
    if (artifact === undefined) {
      throw new CapabilityProvisioningContractError(
        `capability '${id}' does not support platform '${platform}'`,
      );
    }
    resolving.add(id);
    for (const dependency of [...entry.requires].sort()) visit(dependency);
    resolving.delete(id);
    resolved.set(id, toBomItem(entry, artifact, requested.has(id)));
  };

  for (const request of [...manifest.capabilities].sort((left, right) =>
    compareCapabilityIds(left.id, right.id),
  )) {
    visit(request.id);
  }

  const capabilities = Object.freeze(
    [...resolved.values()].sort((left, right) => compareCapabilityIds(left.id, right.id)),
  );
  const unsigned = {
    schemaVersion: CAPABILITY_BOM_SCHEMA_VERSION,
    agent: manifest.agent,
    platform,
    capabilities,
  } as const;
  return Object.freeze({ ...unsigned, fingerprint: capabilityBomFingerprint(unsigned) });
}

function compareCapabilityIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function toBomItem(
  entry: CapabilityCatalogEntryV1,
  artifact: CapabilityCatalogEntryV1["artifacts"][number],
  requested: boolean,
): CapabilityBillOfMaterialsItemV1 {
  return Object.freeze({
    id: entry.id,
    displayName: entry.displayName,
    kind: entry.kind,
    version: entry.version,
    requested,
    requires: Object.freeze([...entry.requires].sort()),
    policyPresets: Object.freeze([...entry.policyPresets].sort()),
    artifact: Object.freeze({
      ...artifact,
      pathEntries: Object.freeze([...artifact.pathEntries]),
    }),
  });
}
