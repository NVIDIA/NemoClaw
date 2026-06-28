// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

import { runOpenshellProviderCommand } from "../../actions/global";
import { stripAnsi } from "../../adapters/openshell/client";
import { OPENSHELL_REQUIRED_MCP_GATEWAY_CAPABILITIES } from "../../adapters/openshell/runtime-capabilities";
import { waitUntil } from "../../core/wait";
import { shellQuote } from "../../runner";
import type { McpBridgeEntry } from "../../state/registry";
import { McpBridgeError, type ParsedEnvReference } from "./mcp-bridge-contracts";
import { commandOutput, type OpenShellCommandResult } from "./mcp-bridge-output";
import {
  assertAuthenticatedBridgeEntry,
  normalizeMcpServerUrl,
  resolveCredentialEnv,
  uniqueEnvNames,
  validateMcpCredentialEnvName,
  validateMcpServerUrlResolvedTarget,
} from "./mcp-bridge-validation";
import { executeSandboxExecCommand } from "./process-recovery";

export type McpProviderInspection = {
  exists: boolean | null;
  id: string | null;
  resourceVersion: number | null;
  type: string | null;
  credentialKeys: string[] | null;
  error?: string;
};

export type McpProviderAttachment = {
  name: string;
  providerPresent: boolean;
  providerId: string | null;
  providerResourceVersion: number | null;
  credentialKeys: string[];
  boundProviderId: string | null;
  boundCredentialKeys: string[];
};

export type McpProviderAttachmentInspection = {
  attachments: McpProviderAttachment[] | null;
  error?: string;
};

const MCP_PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function assertMcpGatewayCapability(): void {
  const gateway = runOpenshellProviderCommand(["status", "--output", "json"], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  }) as OpenShellCommandResult;
  let gatewayCapabilities: string[] = [];
  if (gateway.status === 0) {
    try {
      const parsed: unknown = JSON.parse(stripAnsi(commandOutput(gateway)));
      const capabilities =
        parsed && typeof parsed === "object"
          ? (parsed as { capabilities?: unknown }).capabilities
          : undefined;
      if (Array.isArray(capabilities) && capabilities.every((item) => typeof item === "string")) {
        gatewayCapabilities = capabilities;
      }
    } catch {
      // Old CLIs and human output fail closed below.
    }
  }
  if (
    !OPENSHELL_REQUIRED_MCP_GATEWAY_CAPABILITIES.every((capability) =>
      gatewayCapabilities.includes(capability),
    )
  ) {
    throw new McpBridgeError(
      `The selected OpenShell gateway does not attest the complete authenticated MCP policy, provider-CAS, durable-reservation, and scoped-binding contract. Upgrade/restart OpenShell before enabling authenticated MCP.`,
    );
  }
}

export function assertMcpTransportRuntimeCapability(sandboxName: string): void {
  assertMcpGatewayCapability();
  const markerChecks = OPENSHELL_REQUIRED_MCP_GATEWAY_CAPABILITIES.map(
    (capability) => `grep -aF -m 1 -- ${shellQuote(capability)} /proc/1/exe >/dev/null 2>&1`,
  );
  const result = executeSandboxExecCommand(
    sandboxName,
    ["[ -r /proc/1/exe ] || exit 1", ...markerChecks].join("\n"),
  );
  if (!result || result.status !== 0) {
    throw new McpBridgeError(
      `Sandbox '${sandboxName}' is missing OpenShell's TLS-required, Host-bound MCP credential replacement or policy-authorized lifecycle capability. Upgrade OpenShell and rebuild the sandbox before enabling authenticated MCP.`,
    );
  }
}

export function parseMcpProviderMetadata(output: string): Omit<McpProviderInspection, "exists"> {
  const clean = stripAnsi(output).replace(/\r/g, "");
  const idMatch = clean.match(/^\s*Id:\s*(\S.*?)\s*$/m);
  const resourceVersionMatch = clean.match(/^\s*Resource version:\s*(\d+)\s*$/m);
  const typeMatch = clean.match(/^\s*Type:\s*(\S.*?)\s*$/m);
  const credentialMatch = clean.match(/^\s*Credential keys:\s*(.*?)\s*$/m);
  const rawId = idMatch?.[1]?.trim();
  const parsedResourceVersion = resourceVersionMatch
    ? Number.parseInt(resourceVersionMatch[1] ?? "", 10)
    : null;
  const rawKeys = credentialMatch?.[1]?.trim();
  return {
    id: rawId && MCP_PROVIDER_ID_RE.test(rawId) ? rawId : null,
    resourceVersion:
      parsedResourceVersion !== null && Number.isSafeInteger(parsedResourceVersion)
        ? parsedResourceVersion
        : null,
    type: typeMatch?.[1]?.trim() || null,
    credentialKeys:
      rawKeys === undefined
        ? null
        : rawKeys === "<none>" || rawKeys === ""
          ? []
          : rawKeys.split(",").map((key) => key.trim()),
  };
}

export function inspectMcpProvider(providerName: string | undefined): McpProviderInspection {
  if (!providerName) {
    return {
      exists: false,
      id: null,
      resourceVersion: null,
      type: null,
      credentialKeys: null,
    };
  }
  const result = runOpenshellProviderCommand(["provider", "get", providerName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  }) as OpenShellCommandResult;
  if (result.status !== 0) {
    const output = commandOutput(result);
    if (/not\s+found|NotFound|does\s+not\s+exist|unknown\s+provider/i.test(output)) {
      return {
        exists: false,
        id: null,
        resourceVersion: null,
        type: null,
        credentialKeys: null,
      };
    }
    return {
      exists: null,
      id: null,
      resourceVersion: null,
      type: null,
      credentialKeys: null,
      error: output || `Could not inspect OpenShell provider '${providerName}'.`,
    };
  }
  return {
    exists: true,
    ...parseMcpProviderMetadata(commandOutput(result)),
  };
}

export function inspectMcpProviderAttachments(
  sandboxName: string,
): McpProviderAttachmentInspection {
  const result = runOpenshellProviderCommand(
    ["sandbox", "provider", "list", sandboxName, "--json"],
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
  ) as OpenShellCommandResult;
  const output = commandOutput(result);
  if (result.status !== 0) {
    return { attachments: null, error: output || "provider attachment inspection failed" };
  }
  try {
    const parsed: unknown = JSON.parse(stripAnsi(output));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { attachments?: unknown }).attachments)
    ) {
      throw new Error("missing attachments array");
    }
    const attachments = (parsed as { attachments: unknown[] }).attachments.map((value) => {
      if (!value || typeof value !== "object") throw new Error("invalid attachment record");
      const record = value as Record<string, unknown>;
      const stringArray = (field: string): string[] => {
        const raw = record[field];
        if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
          throw new Error(`invalid ${field}`);
        }
        return raw as string[];
      };
      if (typeof record.name !== "string" || typeof record.provider_present !== "boolean") {
        throw new Error("invalid attachment identity");
      }
      const providerResourceVersion = record.provider_resource_version;
      if (
        typeof providerResourceVersion !== "number" ||
        !Number.isSafeInteger(providerResourceVersion) ||
        providerResourceVersion < 0
      ) {
        throw new Error("invalid provider_resource_version");
      }
      return {
        name: record.name,
        providerPresent: record.provider_present,
        providerId:
          typeof record.provider_id === "string" && record.provider_id ? record.provider_id : null,
        providerResourceVersion: providerResourceVersion > 0 ? providerResourceVersion : null,
        credentialKeys: stringArray("credential_keys"),
        boundProviderId:
          typeof record.bound_provider_id === "string" && record.bound_provider_id
            ? record.bound_provider_id
            : null,
        boundCredentialKeys: stringArray("bound_credential_keys"),
      };
    });
    return { attachments };
  } catch (error) {
    return {
      attachments: null,
      error: `OpenShell returned invalid provider attachment metadata: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function exactAttachment(
  sandboxName: string,
  entry: McpBridgeEntry,
): { inspection: McpProviderAttachmentInspection; attachment?: McpProviderAttachment } {
  const inspection = inspectMcpProviderAttachments(sandboxName);
  return {
    inspection,
    attachment: inspection.attachments?.find(
      (attachment) => attachment.name === entry.providerName,
    ),
  };
}

function attachmentIsExactlyBound(
  attachment: McpProviderAttachment | undefined,
  entry: McpBridgeEntry,
): boolean {
  return (
    !!attachment &&
    attachment.providerPresent &&
    attachment.providerId === entry.providerId &&
    attachment.boundProviderId === entry.providerId &&
    entry.env.length === 1 &&
    attachment.boundCredentialKeys.length === 1 &&
    attachment.boundCredentialKeys[0] === entry.env[0]
  );
}

export function assertNoAttachedProviderCredentialCollision(
  sandboxName: string,
  entry: McpBridgeEntry,
): void {
  const inspection = inspectMcpProviderAttachments(sandboxName);
  if (!inspection.attachments) {
    throw new McpBridgeError(
      inspection.error ?? `Could not inspect providers attached to sandbox '${sandboxName}'.`,
    );
  }
  const credentialKey = entry.env[0];
  const collision = inspection.attachments.find(
    (attachment) =>
      attachment.credentialKeys.includes(credentialKey) &&
      !(attachment.name === entry.providerName && attachment.providerId === entry.providerId),
  );
  if (collision) {
    throw new McpBridgeError(
      `Credential key '${credentialKey}' is already supplied by attached provider '${collision.name}' with ID '${collision.providerId ?? "missing"}'. Refusing to reserve the key for MCP before exact provider activation.`,
    );
  }
}

export function providerMatchesCredential(
  inspection: McpProviderInspection,
  expectedCredential: string | undefined,
  expectedProviderId: string | undefined,
): boolean {
  return (
    inspection.exists === true &&
    expectedProviderId !== undefined &&
    inspection.id === expectedProviderId &&
    inspection.resourceVersion !== null &&
    inspection.type === "generic" &&
    expectedCredential !== undefined &&
    inspection.credentialKeys?.length === 1 &&
    inspection.credentialKeys[0] === expectedCredential
  );
}

export function providerShapeDetail(
  inspection: McpProviderInspection,
  expectedCredential: string | undefined,
  expectedProviderId?: string,
): string | undefined {
  if (inspection.exists === null) return inspection.error ?? "provider inspection failed";
  const id = inspection.id ?? "unparseable";
  if (!expectedProviderId) {
    return inspection.exists
      ? `The registry entry has no stable OpenShell provider ID; live provider ID is '${id}'.`
      : "The registry entry has no stable OpenShell provider ID.";
  }
  if (!inspection.exists) return undefined;
  if (providerMatchesCredential(inspection, expectedCredential, expectedProviderId)) {
    return undefined;
  }
  if (inspection.id !== expectedProviderId) {
    return `Expected stable provider ID '${expectedProviderId}', found '${id}'.`;
  }
  if (inspection.resourceVersion === null) {
    return "OpenShell provider metadata did not include a valid resource version.";
  }
  const type = inspection.type ?? "unparseable";
  const keys = inspection.credentialKeys?.join(", ") || "none or unparseable";
  return `Expected generic provider with only credential key '${expectedCredential ?? "<missing>"}', found type '${type}' with keys '${keys}'.`;
}

export function assertMcpProviderRecoverable(entry: McpBridgeEntry): McpProviderInspection {
  assertAuthenticatedBridgeEntry(entry);
  if (!entry.providerId) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no stable OpenShell provider ID. Refusing to adopt or mutate same-name provider '${entry.providerName}'; remove the legacy bridge with --force and recreate it after independently cleaning the provider.`,
    );
  }
  const expectedCredential = entry.env[0];
  const inspection = inspectMcpProvider(entry.providerName);
  if (inspection.exists === null) {
    throw new McpBridgeError(
      inspection.error ?? `Could not inspect OpenShell provider '${entry.providerName}'.`,
    );
  }
  if (inspection.exists) {
    if (!providerMatchesCredential(inspection, expectedCredential, entry.providerId)) {
      throw new McpBridgeError(
        `OpenShell provider '${entry.providerName}' no longer exactly matches MCP server '${entry.server}'. ${providerShapeDetail(inspection, expectedCredential, entry.providerId)}`,
      );
    }
    return inspection;
  }
  if (!process.env[expectedCredential]) {
    throw new McpBridgeError(
      `OpenShell provider '${entry.providerName}' is missing. Export host environment variable '${expectedCredential}' before retrying so the authenticated MCP provider can be recreated.`,
    );
  }
  return inspection;
}

export async function preflightMcpEntryTargets(
  entries: readonly McpBridgeEntry[],
): Promise<Map<string, string[] | undefined>> {
  for (const entry of entries) assertAuthenticatedBridgeEntry(entry);
  const results = await Promise.all(
    entries.map(async (entry) => {
      const normalized = normalizeMcpServerUrl(entry.url);
      if (normalized !== entry.url) {
        throw new McpBridgeError(
          `MCP server '${entry.server}' has a non-canonical stored URL. Remove it with --force and add it again before lifecycle operations.`,
        );
      }
      const addresses = await validateMcpServerUrlResolvedTarget(new URL(normalized));
      return [entry.server, addresses] as const;
    }),
  );
  return new Map(results);
}

export function buildMcpBridgeProviderArgs(
  action: "create" | "update",
  providerName: string,
  env: readonly ParsedEnvReference[],
  envValues: Record<string, string>,
  expectedProviderId?: string,
  expectedProviderResourceVersion?: number,
): string[] {
  const args =
    action === "create"
      ? ["provider", "create", "--name", providerName, "--type", "generic", "--output", "json"]
      : ["provider", "update", providerName];
  if (action === "update") {
    if (!expectedProviderId || !expectedProviderResourceVersion) {
      throw new McpBridgeError(
        `OpenShell provider '${providerName}' update requires an exact provider ID and resource version.`,
      );
    }
    args.push(
      "--expected-id",
      expectedProviderId,
      "--expected-resource-version",
      String(expectedProviderResourceVersion),
    );
  }
  for (const entry of env) {
    validateMcpCredentialEnvName(entry.name);
    const value = envValues[entry.name];
    if (value !== undefined && value !== "") {
      args.push("--credential", entry.name);
    }
  }
  return args;
}

function parseCreatedProviderIdentity(output: string): {
  id: string;
  resourceVersion: number;
} | null {
  try {
    const parsed: unknown = JSON.parse(stripAnsi(output));
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      !MCP_PROVIDER_ID_RE.test(record.id) ||
      typeof record.resource_version !== "number" ||
      !Number.isSafeInteger(record.resource_version) ||
      record.resource_version <= 0
    ) {
      return null;
    }
    return { id: record.id, resourceVersion: record.resource_version };
  } catch {
    return null;
  }
}

export function upsertMcpProvider(
  providerName: string,
  env: readonly ParsedEnvReference[],
  options: {
    allowExisting: boolean;
    expectedProviderId?: string;
  },
): {
  action: "created" | "updated" | "reused" | "none";
  inspection: McpProviderInspection;
} {
  const envNames = uniqueEnvNames(env);
  if (envNames.length === 0) {
    return {
      action: "none",
      inspection: {
        exists: false,
        id: null,
        resourceVersion: null,
        type: null,
        credentialKeys: null,
      },
    };
  }
  const envValues = resolveCredentialEnv(env);
  const inspection = inspectMcpProvider(providerName);
  if (inspection.exists === null) {
    throw new McpBridgeError(
      inspection.error ?? `Could not inspect OpenShell provider '${providerName}'.`,
    );
  }
  if (inspection.exists && !options.allowExisting) {
    throw new McpBridgeError(
      `OpenShell provider '${providerName}' already exists but is not owned by a registered MCP bridge. Remove or rename that provider before retrying.`,
    );
  }
  if (inspection.exists && !options.expectedProviderId) {
    throw new McpBridgeError(
      `OpenShell provider '${providerName}' already exists, but the incomplete MCP add has no stable provider ID and cannot safely adopt it. Remove that provider independently, then retry the original mcp add command.`,
    );
  }
  if (
    inspection.exists &&
    !providerMatchesCredential(inspection, envNames[0], options.expectedProviderId)
  ) {
    throw new McpBridgeError(
      `OpenShell provider '${providerName}' no longer exactly matches MCP server credential '${envNames[0]}'. ${providerShapeDetail(inspection, envNames[0], options.expectedProviderId)} Remove the stale provider and run mcp restart with the credential exported.`,
    );
  }
  if (Object.keys(envValues).length === 0) {
    if (inspection.exists) return { action: "reused", inspection };
    throw new McpBridgeError(
      `Host environment variable '${envNames[0]}' is required to create MCP provider '${providerName}'.`,
      1,
    );
  }
  const action = inspection.exists ? "update" : "create";
  // Close as much of the inspect-to-mutate window as the current name-based
  // OpenShell CLI permits. Create remains protected by gateway MustCreate;
  // update additionally requires the same immutable ID immediately before it.
  const beforeMutation = inspectMcpProvider(providerName);
  if (action === "create" && beforeMutation.exists !== false) {
    const detail =
      beforeMutation.exists === null
        ? (beforeMutation.error ?? "provider inspection failed")
        : "a same-name provider appeared after preflight";
    throw new McpBridgeError(
      `OpenShell provider '${providerName}' changed before create: ${detail}. Refusing to mutate it.`,
    );
  }
  if (
    action === "update" &&
    !providerMatchesCredential(beforeMutation, envNames[0], options.expectedProviderId)
  ) {
    throw new McpBridgeError(
      `OpenShell provider '${providerName}' changed before update. ${providerShapeDetail(beforeMutation, envNames[0], options.expectedProviderId)} Refusing to mutate it.`,
    );
  }
  const result = runOpenshellProviderCommand(
    buildMcpBridgeProviderArgs(
      action,
      providerName,
      env,
      envValues,
      options.expectedProviderId,
      beforeMutation.resourceVersion ?? undefined,
    ),
    {
      ignoreError: true,
      env: envValues,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ) as OpenShellCommandResult;
  if (result.status !== 0) {
    // A transport error can arrive after the gateway committed the update.
    // Converge only when a fresh read proves the same immutable provider and
    // exact credential shape at a newer CAS version.
    const converged = inspectMcpProvider(providerName);
    const updateCommitted =
      action === "update" &&
      providerMatchesCredential(converged, envNames[0], options.expectedProviderId) &&
      converged.resourceVersion !== null &&
      converged.resourceVersion > (beforeMutation.resourceVersion ?? 0);
    if (updateCommitted) {
      return { action: "updated", inspection: converged };
    }
    throw new McpBridgeError(
      commandOutput(result, envValues) || `Failed to ${action} MCP provider '${providerName}'.`,
    );
  }
  const createdIdentity =
    action === "create" ? parseCreatedProviderIdentity(commandOutput(result, envValues)) : null;
  if (action === "create" && !createdIdentity) {
    throw new McpBridgeError(
      `OpenShell did not return a machine-readable immutable identity for newly created provider '${providerName}'. Refusing to adopt any same-name object.`,
    );
  }
  const after = inspectMcpProvider(providerName);
  if (after.exists !== true || !after.id) {
    throw new McpBridgeError(
      after.error ??
        `OpenShell did not return a stable provider ID after ${action} for '${providerName}'. Refusing later MCP side effects.`,
    );
  }
  const expectedProviderId = action === "create" ? createdIdentity?.id : options.expectedProviderId;
  if (
    !after.resourceVersion ||
    !providerMatchesCredential(after, envNames[0], expectedProviderId) ||
    (action === "update" && after.resourceVersion <= (beforeMutation.resourceVersion ?? 0))
  ) {
    throw new McpBridgeError(
      `OpenShell provider '${providerName}' changed during ${action}. ${providerShapeDetail(after, envNames[0], expectedProviderId)} Refusing later MCP side effects.`,
    );
  }
  return { action: action === "create" ? "created" : "updated", inspection: after };
}

function inspectMcpProviderForMutation(
  entry: McpBridgeEntry,
  operation: "attach" | "detach" | "delete",
  options: { allowMissing?: boolean; bestEffort?: boolean } = {},
): McpProviderInspection | null {
  if (!entry.providerName) return null;
  try {
    assertAuthenticatedBridgeEntry(entry);
    if (!entry.providerId) {
      throw new McpBridgeError(
        `MCP server '${entry.server}' has no stable OpenShell provider ID. Refusing to ${operation} same-name provider '${entry.providerName}'.`,
      );
    }
    const inspection = inspectMcpProvider(entry.providerName);
    if (inspection.exists === false) {
      if (options.allowMissing) return inspection;
      throw new McpBridgeError(
        `OpenShell provider '${entry.providerName}' disappeared before ${operation}.`,
      );
    }
    if (!providerMatchesCredential(inspection, entry.env[0], entry.providerId)) {
      throw new McpBridgeError(
        `OpenShell provider '${entry.providerName}' changed before ${operation}. ${providerShapeDetail(inspection, entry.env[0], entry.providerId)} Refusing to mutate it.`,
      );
    }
    return inspection;
  } catch (error) {
    if (options.bestEffort) return null;
    throw error;
  }
}

export function attachProvider(sandboxName: string, entry: McpBridgeEntry): void {
  if (!entry.providerName) return;
  const inspection = inspectMcpProviderForMutation(entry, "attach");
  if (!inspection?.id || !inspection.resourceVersion) {
    throw new McpBridgeError(`OpenShell provider '${entry.providerName}' has incomplete metadata.`);
  }
  const result = runOpenshellProviderCommand(
    [
      "sandbox",
      "provider",
      "attach",
      sandboxName,
      entry.providerName,
      "--expected-provider-id",
      inspection.id,
      "--expected-provider-resource-version",
      String(inspection.resourceVersion),
      "--credential-key",
      entry.env[0] ?? "",
    ],
    { ignoreError: true, stdio: ["ignore", "pipe", "pipe"] },
  ) as OpenShellCommandResult;
  if (result.status !== 0) {
    const output = commandOutput(result);
    const afterError = exactAttachment(sandboxName, entry);
    if (attachmentIsExactlyBound(afterError.attachment, entry)) return;
    throw new McpBridgeError(
      output ||
        afterError.inspection.error ||
        `Failed to attach MCP provider '${entry.providerName}'.`,
    );
  }
  const after = exactAttachment(sandboxName, entry);
  if (!attachmentIsExactlyBound(after.attachment, entry)) {
    throw new McpBridgeError(
      after.inspection.error ??
        `OpenShell did not persist the exact provider ID and credential-key binding for '${entry.providerName}' after attach.`,
    );
  }
}

const MCP_CREDENTIAL_SNAPSHOT_PATH_RE = /^\/tmp\/nemoclaw-mcp-provider-sync-[0-9a-f-]{36}$/;

function validateMcpCredentialSnapshotPath(snapshotPath: string): void {
  if (!MCP_CREDENTIAL_SNAPSHOT_PATH_RE.test(snapshotPath)) {
    throw new McpBridgeError("Invalid MCP credential revision snapshot path.");
  }
}

function mcpCredentialPlaceholderValidatorShell(envName: string): string[] {
  validateMcpCredentialEnvName(envName);
  const canonical = `openshell:resolve:env:${envName}`;
  const revisionPrefix = "openshell:resolve:env:v";
  const revisionSuffix = `_${envName}`;
  return [
    `canonical=${shellQuote(canonical)}`,
    `prefix=${shellQuote(revisionPrefix)}`,
    `suffix=${shellQuote(revisionSuffix)}`,
    "valid_placeholder() {",
    '  candidate="$1"',
    '  [ "$candidate" = "$canonical" ] && return 0',
    '  versioned="${candidate#"$prefix"}"',
    '  [ "$versioned" != "$candidate" ] || return 1',
    '  revision="${versioned%"$suffix"}"',
    '  [ "$revision" != "$versioned" ] || return 1',
    '  [ "$versioned" = "$revision$suffix" ] || return 1',
    '  case "$revision" in ""|*[!0-9]*) return 1 ;; *) return 0 ;; esac',
    "}",
  ];
}

/**
 * Capture only a validated OpenShell placeholder in a descriptor opened with
 * noclobber. Raw environment values are never written or printed. The file is
 * used solely to compare the supervisor's provider revision across fresh execs.
 */
export function buildMcpCredentialRevisionSnapshotCommand(
  envName: string,
  snapshotPath: string,
): string {
  validateMcpCredentialSnapshotPath(snapshotPath);
  return [
    ...mcpCredentialPlaceholderValidatorShell(envName),
    `snapshot=${shellQuote(snapshotPath)}`,
    "umask 077",
    "set -C",
    'exec 3>"$snapshot" || exit 1',
    "set +C",
    `value="\${${envName}-}"`,
    'if [ -n "$value" ]; then',
    '  valid_placeholder "$value" || exit 1',
    '  printf "%s" "$value" >&3',
    "fi",
  ].join("\n");
}

export function buildMcpCredentialReadinessCommand(
  envName: string,
  previousRevisionSnapshotPath?: string,
): string {
  if (previousRevisionSnapshotPath) {
    validateMcpCredentialSnapshotPath(previousRevisionSnapshotPath);
  }
  return [
    ...mcpCredentialPlaceholderValidatorShell(envName),
    `value="\${${envName}-}"`,
    'valid_placeholder "$value" || exit 1',
    ...(previousRevisionSnapshotPath
      ? [
          `snapshot=${shellQuote(previousRevisionSnapshotPath)}`,
          '[ -f "$snapshot" ] && [ ! -L "$snapshot" ] || exit 1',
          'prior="$(cat -- "$snapshot")" || exit 1',
          '[ -z "$prior" ] || valid_placeholder "$prior" || exit 1',
          '[ -z "$prior" ] || [ "$value" != "$prior" ] || exit 1',
        ]
      : []),
  ].join("\n");
}

export function snapshotMcpCredentialRevision(sandboxName: string, entry: McpBridgeEntry): string {
  assertAuthenticatedBridgeEntry(entry);
  const snapshotPath = `/tmp/nemoclaw-mcp-provider-sync-${crypto.randomUUID()}`;
  const result = executeSandboxExecCommand(
    sandboxName,
    buildMcpCredentialRevisionSnapshotCommand(entry.env[0], snapshotPath),
  );
  if (!result || result.status !== 0) {
    throw new McpBridgeError(
      `Could not capture the current OpenShell credential revision for sandbox '${sandboxName}'.`,
    );
  }
  return snapshotPath;
}

export function removeMcpCredentialRevisionSnapshot(
  sandboxName: string,
  snapshotPath: string | undefined,
): void {
  if (!snapshotPath) return;
  validateMcpCredentialSnapshotPath(snapshotPath);
  executeSandboxExecCommand(sandboxName, `rm -f -- ${shellQuote(snapshotPath)}`);
}

export function waitForAttachedMcpCredential(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: { previousRevisionSnapshotPath?: string } = {},
): void {
  assertAuthenticatedBridgeEntry(entry);
  const envName = entry.env[0];
  const timeoutSeconds = Number.parseInt(
    process.env.NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS ?? "30",
    10,
  );
  const ready = waitUntil(
    () => {
      // Each exec is a fresh OpenShell process. A status-zero comparison proves
      // the supervisor has consumed the provider_env_revision without ever
      // printing either a placeholder or a credential value.
      const probe = executeSandboxExecCommand(
        sandboxName,
        buildMcpCredentialReadinessCommand(envName, options.previousRevisionSnapshotPath),
      );
      return probe?.status === 0;
    },
    Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 30,
    1_000,
  );
  if (!ready) {
    throw new McpBridgeError(
      `OpenShell did not synchronize the expected credential revision for placeholder '${envName}' into sandbox '${sandboxName}' after provider attachment or update.`,
    );
  }
}

export function buildMcpCredentialDetachedCommand(envName: string): string {
  validateMcpCredentialEnvName(envName);
  return `[ -z "\${${envName}+x}" ]`;
}

export function waitForDetachedMcpCredential(sandboxName: string, entry: McpBridgeEntry): void {
  assertAuthenticatedBridgeEntry(entry);
  const envName = entry.env[0];
  const timeoutSeconds = Number.parseInt(
    process.env.NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS ?? "30",
    10,
  );
  const revoked = waitUntil(
    () =>
      executeSandboxExecCommand(sandboxName, buildMcpCredentialDetachedCommand(envName))?.status ===
      0,
    Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 30,
    1_000,
  );
  if (!revoked) {
    throw new McpBridgeError(
      `OpenShell did not confirm credential '${envName}' was revoked from fresh execs in sandbox '${sandboxName}' after detach. Preserving MCP policy and ownership state.`,
    );
  }
}

export function providerDetachChangedState(status: number | null, output: string): boolean {
  return (
    status === 0 &&
    !/\bwas\s+not\s+attached\b|\balready\s+detached\b|\bNotAttached\b/i.test(stripAnsi(output))
  );
}

export type ProviderDetachOutcome = "detached" | "absent" | "unknown";

export function detachProvider(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: { bestEffort?: boolean } = {},
): ProviderDetachOutcome {
  if (!entry.providerName) return "absent";
  assertAuthenticatedBridgeEntry(entry);
  if (!entry.providerId) {
    if (options.bestEffort) return "unknown";
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no immutable provider ID for exact detach.`,
    );
  }
  const before = exactAttachment(sandboxName, entry);
  if (!before.inspection.attachments) {
    if (options.bestEffort) return "unknown";
    throw new McpBridgeError(
      before.inspection.error ?? `Could not inspect provider attachment '${entry.providerName}'.`,
    );
  }
  if (!before.attachment) return "absent";
  if (
    before.attachment.boundProviderId !== entry.providerId ||
    !before.attachment.boundCredentialKeys.includes(entry.env[0])
  ) {
    if (options.bestEffort) return "unknown";
    throw new McpBridgeError(
      `Provider attachment '${entry.providerName}' is not bound to MCP server '${entry.server}' and immutable provider ID '${entry.providerId}'.`,
    );
  }
  const expectedResourceVersion =
    before.attachment.providerId === entry.providerId && before.attachment.providerResourceVersion
      ? before.attachment.providerResourceVersion
      : 1;
  const result = runOpenshellProviderCommand(
    [
      "sandbox",
      "provider",
      "detach",
      sandboxName,
      entry.providerName,
      "--expected-provider-id",
      entry.providerId,
      "--expected-provider-resource-version",
      String(expectedResourceVersion),
    ],
    {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      suppressOutput: true,
    } as Record<string, unknown>,
  ) as OpenShellCommandResult;
  const output = commandOutput(result);
  const after = exactAttachment(sandboxName, entry);
  if (after.inspection.attachments && !after.attachment) {
    return providerDetachChangedState(result.status, output) ? "detached" : "absent";
  }
  if (options.bestEffort) return "unknown";
  throw new McpBridgeError(
    output ||
      after.inspection.error ||
      `OpenShell did not confirm removal of provider attachment and scoped credential binding '${entry.providerName}'.`,
  );
}

export function deleteProvider(
  entry: McpBridgeEntry,
  options: { allowMissing?: boolean; bestEffort?: boolean } = {},
): void {
  if (!entry.providerName) return;
  const inspection = inspectMcpProviderForMutation(entry, "delete", options);
  if (!inspection?.exists || !inspection.id || !inspection.resourceVersion) return;
  const result = runOpenshellProviderCommand(
    [
      "provider",
      "delete",
      entry.providerName,
      "--expected-id",
      inspection.id,
      "--expected-resource-version",
      String(inspection.resourceVersion),
    ],
    {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      suppressOutput: true,
    } as Record<string, unknown>,
  ) as OpenShellCommandResult;
  if (result.status !== 0) {
    const output = commandOutput(result);
    if (options.allowMissing && /not\s+found|NotFound/i.test(output)) return;
    if (options.bestEffort) return;
    throw new McpBridgeError(output || `Failed to delete MCP provider '${entry.providerName}'.`);
  }
}

export function providerAttached(
  sandboxName: string,
  providerName: string | undefined,
): boolean | null {
  if (!providerName) return null;
  const inspection = inspectMcpProviderAttachments(sandboxName);
  if (!inspection.attachments) return null;
  return inspection.attachments.some((attachment) => attachment.name === providerName);
}
