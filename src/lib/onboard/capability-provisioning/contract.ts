// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const CAPABILITY_MANIFEST_SCHEMA_VERSION = 1 as const;
export const CAPABILITY_CATALOG_SCHEMA_VERSION = 1 as const;
export const CAPABILITY_BOM_SCHEMA_VERSION = 1 as const;

export const CAPABILITY_AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
export const CAPABILITY_PLATFORMS = ["linux/amd64", "linux/arm64", "windows/x64"] as const;
export const CAPABILITY_KINDS = ["runtime", "skill", "tool"] as const;

export type CapabilityAgent = (typeof CAPABILITY_AGENTS)[number];
export type CapabilityPlatform = (typeof CAPABILITY_PLATFORMS)[number];
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export interface CapabilityManifestV1 {
  readonly schemaVersion: typeof CAPABILITY_MANIFEST_SCHEMA_VERSION;
  readonly agent: CapabilityAgent;
  readonly capabilities: readonly {
    readonly id: string;
    readonly version: string | null;
  }[];
}

export interface CapabilityCatalogArtifactV1 {
  readonly platform: CapabilityPlatform;
  readonly reference: `oci://${string}@sha256:${string}`;
  readonly installPrefix: `/opt/nemoclaw/capabilities/${string}`;
  readonly pathEntries: readonly string[];
}

export interface CapabilityCatalogEntryV1 {
  readonly id: string;
  readonly displayName: string;
  readonly kind: CapabilityKind;
  readonly version: string;
  readonly agents: readonly CapabilityAgent[];
  readonly requires: readonly string[];
  readonly policyPresets: readonly string[];
  readonly artifacts: readonly CapabilityCatalogArtifactV1[];
}

export interface CapabilityCatalogV1 {
  readonly schemaVersion: typeof CAPABILITY_CATALOG_SCHEMA_VERSION;
  readonly capabilities: readonly CapabilityCatalogEntryV1[];
}

export interface CapabilityBillOfMaterialsItemV1 {
  readonly id: string;
  readonly displayName: string;
  readonly kind: CapabilityKind;
  readonly version: string;
  readonly requested: boolean;
  readonly requires: readonly string[];
  readonly policyPresets: readonly string[];
  readonly artifact: CapabilityCatalogArtifactV1;
}

export interface CapabilityBillOfMaterialsV1 {
  readonly schemaVersion: typeof CAPABILITY_BOM_SCHEMA_VERSION;
  readonly agent: CapabilityAgent;
  readonly platform: CapabilityPlatform;
  readonly capabilities: readonly CapabilityBillOfMaterialsItemV1[];
  readonly fingerprint: `sha256:${string}`;
}

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const OCI_REFERENCE_PATTERN =
  /^oci:\/\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/[a-z0-9]+(?:[._\/-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/u;
const INSTALL_PREFIX_PATTERN =
  /^\/opt\/nemoclaw\/capabilities\/([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)$/u;
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/+@-]+$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_MANIFEST_CAPABILITIES = 128;
const MAX_CATALOG_CAPABILITIES = 512;
const MAX_ENTRY_LIST_ITEMS = 128;
const MAX_STRING_BYTES = 512;

export class CapabilityProvisioningContractError extends Error {
  constructor(message: string) {
    super(`Invalid capability provisioning contract: ${message}`);
    this.name = "CapabilityProvisioningContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CapabilityProvisioningContractError(`${field} must be an object`);
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new CapabilityProvisioningContractError(
      `${field} must contain exactly: ${wanted.join(", ")}`,
    );
  }
}

function requireString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new CapabilityProvisioningContractError(`${field} must be a bounded printable string`);
  }
  return value;
}

function requirePattern(value: unknown, pattern: RegExp, field: string): string {
  const text = requireString(value, field);
  if (!pattern.test(text)) {
    throw new CapabilityProvisioningContractError(`${field} has an unsupported format`);
  }
  return text;
}

function requireLiteral<T extends string | number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) {
    throw new CapabilityProvisioningContractError(`${field} must be ${JSON.stringify(expected)}`);
  }
  return expected;
}

function requireLiteralFrom<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new CapabilityProvisioningContractError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function requireArray(value: unknown, field: string, limit: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new CapabilityProvisioningContractError(
      `${field} must be an array with at most ${limit} items`,
    );
  }
  return value;
}

function requireUniqueStrings(
  value: unknown,
  field: string,
  pattern: RegExp = IDENTIFIER_PATTERN,
): readonly string[] {
  const result = requireArray(value, field, MAX_ENTRY_LIST_ITEMS).map((item, index) =>
    requirePattern(item, pattern, `${field}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    throw new CapabilityProvisioningContractError(`${field} must not contain duplicates`);
  }
  return result;
}

function parseArtifact(value: unknown, field: string): CapabilityCatalogArtifactV1 {
  const artifact = requireRecord(value, field);
  requireExactKeys(artifact, ["installPrefix", "pathEntries", "platform", "reference"], field);
  const platform = requireLiteralFrom(artifact.platform, CAPABILITY_PLATFORMS, `${field}.platform`);
  const reference = requirePattern(
    artifact.reference,
    OCI_REFERENCE_PATTERN,
    `${field}.reference`,
  ) as CapabilityCatalogArtifactV1["reference"];
  const installPrefix = requirePattern(
    artifact.installPrefix,
    INSTALL_PREFIX_PATTERN,
    `${field}.installPrefix`,
  ) as CapabilityCatalogArtifactV1["installPrefix"];
  const pathEntries = requireUniqueStrings(
    artifact.pathEntries,
    `${field}.pathEntries`,
    RELATIVE_PATH_PATTERN,
  );
  return { platform, reference, installPrefix, pathEntries };
}

export function parseCapabilityManifestV1(value: unknown): CapabilityManifestV1 {
  const manifest = requireRecord(value, "manifest");
  requireExactKeys(manifest, ["agent", "capabilities", "schemaVersion"], "manifest");
  requireLiteral(
    manifest.schemaVersion,
    CAPABILITY_MANIFEST_SCHEMA_VERSION,
    "manifest.schemaVersion",
  );
  const agent = requireLiteralFrom(manifest.agent, CAPABILITY_AGENTS, "manifest.agent");
  const capabilities = requireArray(
    manifest.capabilities,
    "manifest.capabilities",
    MAX_MANIFEST_CAPABILITIES,
  ).map((value, index) => {
    const request = requireRecord(value, `manifest.capabilities[${index}]`);
    requireExactKeys(request, ["id", "version"], `manifest.capabilities[${index}]`);
    return {
      id: requirePattern(request.id, IDENTIFIER_PATTERN, `manifest.capabilities[${index}].id`),
      version:
        request.version === null
          ? null
          : requirePattern(
              request.version,
              VERSION_PATTERN,
              `manifest.capabilities[${index}].version`,
            ),
    };
  });
  if (new Set(capabilities.map(({ id }) => id)).size !== capabilities.length) {
    throw new CapabilityProvisioningContractError(
      "manifest.capabilities must not contain duplicates",
    );
  }
  return { schemaVersion: CAPABILITY_MANIFEST_SCHEMA_VERSION, agent, capabilities };
}

export function parseCapabilityCatalogV1(value: unknown): CapabilityCatalogV1 {
  const catalog = requireRecord(value, "catalog");
  requireExactKeys(catalog, ["capabilities", "schemaVersion"], "catalog");
  requireLiteral(catalog.schemaVersion, CAPABILITY_CATALOG_SCHEMA_VERSION, "catalog.schemaVersion");
  const capabilities = requireArray(
    catalog.capabilities,
    "catalog.capabilities",
    MAX_CATALOG_CAPABILITIES,
  ).map((value, index): CapabilityCatalogEntryV1 => {
    const field = `catalog.capabilities[${index}]`;
    const entry = requireRecord(value, field);
    requireExactKeys(
      entry,
      ["agents", "artifacts", "displayName", "id", "kind", "policyPresets", "requires", "version"],
      field,
    );
    const id = requirePattern(entry.id, IDENTIFIER_PATTERN, `${field}.id`);
    const agents = requireArray(entry.agents, `${field}.agents`, CAPABILITY_AGENTS.length).map(
      (agent, agentIndex) =>
        requireLiteralFrom(agent, CAPABILITY_AGENTS, `${field}.agents[${agentIndex}]`),
    );
    if (agents.length === 0 || new Set(agents).size !== agents.length) {
      throw new CapabilityProvisioningContractError(`${field}.agents must be nonempty and unique`);
    }
    const artifacts = requireArray(
      entry.artifacts,
      `${field}.artifacts`,
      CAPABILITY_PLATFORMS.length,
    ).map((artifact, artifactIndex) =>
      parseArtifact(artifact, `${field}.artifacts[${artifactIndex}]`),
    );
    if (
      artifacts.length === 0 ||
      new Set(artifacts.map(({ platform }) => platform)).size !== artifacts.length
    ) {
      throw new CapabilityProvisioningContractError(
        `${field}.artifacts must be nonempty with unique platforms`,
      );
    }
    if (artifacts.some(({ installPrefix }) => installPrefix.split("/").at(-1) !== id)) {
      throw new CapabilityProvisioningContractError(
        `${field}.artifacts install prefixes must end with the capability id`,
      );
    }
    const requires = requireUniqueStrings(entry.requires, `${field}.requires`);
    if (requires.includes(id)) {
      throw new CapabilityProvisioningContractError(`${field}.requires must not reference itself`);
    }
    return {
      id,
      displayName: requireString(entry.displayName, `${field}.displayName`),
      kind: requireLiteralFrom(entry.kind, CAPABILITY_KINDS, `${field}.kind`),
      version: requirePattern(entry.version, VERSION_PATTERN, `${field}.version`),
      agents,
      requires,
      policyPresets: requireUniqueStrings(entry.policyPresets, `${field}.policyPresets`),
      artifacts,
    };
  });
  if (new Set(capabilities.map(({ id }) => id)).size !== capabilities.length) {
    throw new CapabilityProvisioningContractError("catalog.capabilities must have unique ids");
  }
  const ids = new Set(capabilities.map(({ id }) => id));
  for (const entry of capabilities) {
    for (const dependency of entry.requires) {
      if (!ids.has(dependency)) {
        throw new CapabilityProvisioningContractError(
          `catalog capability '${entry.id}' requires unknown capability '${dependency}'`,
        );
      }
    }
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const entries = new Map(capabilities.map((entry) => [entry.id, entry]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new CapabilityProvisioningContractError(
        `catalog capability dependency cycle includes '${id}'`,
      );
    }
    visiting.add(id);
    for (const dependency of entries.get(id)?.requires ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  return { schemaVersion: CAPABILITY_CATALOG_SCHEMA_VERSION, capabilities };
}

export function capabilityBomFingerprint(
  value: Omit<CapabilityBillOfMaterialsV1, "fingerprint">,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}
