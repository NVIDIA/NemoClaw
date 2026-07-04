// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { runOpenshellProviderCommand } from "../../actions/global";
import { stripAnsi } from "../../adapters/openshell/client";
import type { McpBridgeEntry } from "../../state/registry";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { commandOutput, type OpenShellCommandResult } from "./mcp-bridge-output";
import {
  assertAuthenticatedBridgeEntry,
  normalizeMcpServerUrl,
  validateMcpServerUrlResolvedTarget,
} from "./mcp-bridge-validation";

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
  providerId: string | null;
  credentialKeys: string[];
};

export type McpProviderAttachmentInspection = {
  attachments: McpProviderAttachment[] | null;
  error?: string;
};

const MCP_PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

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

export function parseMcpProviderAttachmentNames(output: string): string[] {
  const clean = stripAnsi(output).replace(/\r/g, "").trim();
  if (/^No providers attached to sandbox\b/m.test(clean)) return [];
  const lines = clean
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const headerIndex = lines.findIndex((line) =>
    /^NAME\s+TYPE\s+CREDENTIAL_KEYS\s+CONFIG_KEYS$/.test(line),
  );
  if (headerIndex < 0) throw new Error("missing provider attachment table header");
  return lines.slice(headerIndex + 1).map((line) => {
    const match = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)$/);
    if (!match?.[1]) throw new Error("invalid provider attachment table row");
    return match[1];
  });
}

export function inspectMcpProviderAttachments(
  sandboxName: string,
): McpProviderAttachmentInspection {
  const result = runOpenshellProviderCommand(["sandbox", "provider", "list", sandboxName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  }) as OpenShellCommandResult;
  const output = commandOutput(result);
  if (result.status !== 0) {
    return { attachments: null, error: output || "provider attachment inspection failed" };
  }
  try {
    const clean = stripAnsi(output).replace(/\r/g, "").trim();
    if (/^No providers attached to sandbox\b/m.test(clean)) return { attachments: [] };
    const names = parseMcpProviderAttachmentNames(clean);
    const attachments = names.map((name) => {
      const provider = inspectMcpProvider(name);
      if (
        provider.exists !== true ||
        !provider.id ||
        !provider.resourceVersion ||
        !provider.type ||
        !provider.credentialKeys
      ) {
        throw new Error(
          provider.error ?? `attached provider '${name}' disappeared or has incomplete metadata`,
        );
      }
      return {
        name,
        providerId: provider.id,
        credentialKeys: provider.credentialKeys,
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
      `Credential key '${credentialKey}' is already supplied by attached provider '${collision.name}' with ID '${collision.providerId ?? "missing"}'. Refusing to reserve the key for MCP before provider activation.`,
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
): Promise<Map<string, string[]>> {
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

export function providerAttached(
  sandboxName: string,
  providerName: string | undefined,
): boolean | null {
  if (!providerName) return null;
  const inspection = inspectMcpProviderAttachments(sandboxName);
  if (!inspection.attachments) return null;
  return inspection.attachments.some((attachment) => attachment.name === providerName);
}
