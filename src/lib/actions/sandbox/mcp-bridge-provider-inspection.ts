// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import {
  createCliOpenShellProviderAdapter,
  type RunProviderCommand,
} from "../../adapters/openshell/provider-adapter-cli";
import {
  type OpenShellRuntimeSelection,
  runOpenshellProviderCommand,
} from "../../adapters/openshell/provider-command";
import { selectedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";
import { OPENSHELL_DEFAULT_WORKSPACE } from "../../adapters/openshell/sandbox-ssh-host";
import { getDockerDriverGatewayLocalTlsDir } from "../../onboard/docker-driver-gateway-local-tls";
import { resolveGatewayStateDirForPort } from "../../onboard/gateway/state-dir";
import { resolveGatewayCredentialMutationAuthority } from "../../onboard/gateway-teardown-authority";
import {
  evaluateGatewayAttachmentConfiguration,
  isExternallySupervised,
  type GatewayOwner,
} from "../../onboard/gateway-ownership";
import { replayTrustedPrivateEndpoint } from "../../security/trusted-private-endpoint";
import { listExtraProviders, type McpBridgeEntry, type SandboxEntry } from "../../state/registry";
import { getPersistedSandboxTargetGateway } from "./gateway-target";
import { McpBridgeError } from "./mcp-bridge-contracts";
import type { McpBridgeTargetValidation } from "./mcp-bridge-url-validation";
import {
  assertAuthenticatedBridgeEntry,
  normalizeMcpServerUrl,
  preflightMcpServerUrlResolvedTarget,
} from "./mcp-bridge-validation";

export const MCP_BRIDGE_PROVIDER_TYPE = "nemoclaw-mcp-v1";

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

export type McpProviderInspectionRuntimeSelection = OpenShellRuntimeSelection;

const GATEWAY_CLIENT_TLS_FILES = ["ca.crt", "client/tls.crt", "client/tls.key"] as const;

export function createMcpProviderAdapterBoundary(
  runtimeSelection: OpenShellRuntimeSelection,
  adapter?: OpenShellProviderAdapter,
): Readonly<{
  adapter: OpenShellProviderAdapter;
  target: ReturnType<typeof selectedOpenShellGateway>;
}> {
  return {
    adapter:
      adapter ??
      createCliOpenShellProviderAdapter({
        run: ((args, options) =>
          runOpenshellProviderCommand(args, {
            ...options,
            runtimeSelection,
          })) as RunProviderCommand,
      }),
    // The command runner owns the exact gateway, workspace, and TLS
    // selection, so the CLI adapter must not add a second selector.
    target: selectedOpenShellGateway(),
  };
}

function readableGatewayClientTlsDir(localTlsDir: string, required: boolean): string | undefined {
  const observations = GATEWAY_CLIENT_TLS_FILES.map((relativePath) => {
    const filePath = path.join(localTlsDir, relativePath);
    try {
      if (!fs.statSync(filePath).isFile()) throw new Error("not a file");
      fs.accessSync(filePath, fs.constants.R_OK);
      return { filePath, readable: true };
    } catch {
      return { filePath, readable: false };
    }
  });
  if (observations.every(({ readable }) => readable)) return localTlsDir;
  if (!required && observations.every(({ filePath }) => !fs.existsSync(filePath))) {
    return undefined;
  }
  const unreadable = observations.find(({ readable }) => !readable)?.filePath ?? localTlsDir;
  throw new McpBridgeError(`OpenShell gateway TLS file is missing or unreadable: ${unreadable}`, 1);
}

function providerRuntimeLocalTlsDir(
  owner: GatewayOwner,
  selectedInProcess: boolean,
): string | undefined {
  if (isExternallySupervised(owner)) {
    const configuration = evaluateGatewayAttachmentConfiguration(owner, owner.gatewayPort);
    if (!configuration.ok) throw new McpBridgeError(configuration.message, 1);
    if (!owner.endpoint || new URL(owner.endpoint).protocol !== "https:") return undefined;
    if (!owner.stateDir) {
      throw new McpBridgeError(
        "Externally supervised HTTPS gateway requires a state directory.",
        1,
      );
    }
    return readableGatewayClientTlsDir(path.join(owner.stateDir, "tls"), true);
  }

  const configuredStateDir = selectedInProcess
    ? process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR
    : undefined;
  const stateDir = resolveGatewayStateDirForPort({
    configured: configuredStateDir,
    home: process.env.HOME || os.homedir(),
    port: owner.gatewayPort,
  });
  return readableGatewayClientTlsDir(getDockerDriverGatewayLocalTlsDir(stateDir), false);
}

export function getMcpProviderInspectionRuntimeSelection(
  sandbox: SandboxEntry,
): McpProviderInspectionRuntimeSelection {
  const providerRuntimeGateway = getPersistedSandboxTargetGateway(sandbox);
  const { gatewayName, gatewayPort } = providerRuntimeGateway;
  const owner = resolveGatewayCredentialMutationAuthority({ gatewayName, gatewayPort });
  const localTlsDir = providerRuntimeLocalTlsDir(owner, providerRuntimeGateway.selectedInProcess);
  return {
    gatewayName,
    ...(localTlsDir ? { localTlsDir } : {}),
    workspace: OPENSHELL_DEFAULT_WORKSPACE,
  };
}

export async function inspectMcpProvider(
  providerName: string | undefined,
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
  providerAdapter?: OpenShellProviderAdapter,
): Promise<McpProviderInspection> {
  if (!providerName) {
    return {
      exists: false,
      id: null,
      resourceVersion: null,
      type: null,
      credentialKeys: null,
    };
  }
  if (!runtimeSelection) {
    throw new McpBridgeError("MCP provider inspection requires an OpenShell runtime target.");
  }
  const { adapter, target } = createMcpProviderAdapterBoundary(runtimeSelection, providerAdapter);
  const result = await adapter.getProvider({ providerName, target });
  if (!result.ok) {
    if (result.error.kind === "command" && result.error.reason === "not_found") {
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
      error: result.error.message,
    };
  }
  return {
    exists: true,
    id: result.value.revision?.id ?? null,
    resourceVersion: result.value.revision?.resourceVersion ?? null,
    type: result.value.type,
    credentialKeys: [...result.value.credentialKeys],
  };
}

export async function inspectMcpProviderAttachments(
  sandboxName: string,
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
  providerAdapter?: OpenShellProviderAdapter,
): Promise<McpProviderAttachmentInspection> {
  if (!runtimeSelection) {
    return {
      attachments: null,
      error: "MCP provider inspection requires an OpenShell runtime target.",
    };
  }
  const { adapter, target } = createMcpProviderAdapterBoundary(runtimeSelection, providerAdapter);
  const result = await adapter.listProviderAttachments({ sandboxName, target });
  if (!result.ok) return { attachments: null, error: result.error.message };
  try {
    const attachments = await Promise.all(
      result.value.names.map(async (name) => {
        const provider = await inspectMcpProvider(name, runtimeSelection, adapter);
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
      }),
    );
    return { attachments };
  } catch (error) {
    return {
      attachments: null,
      error: `OpenShell returned invalid provider attachment metadata: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function assertNoAttachedProviderCredentialCollisions(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries) assertAuthenticatedBridgeEntry(entry);
  const inspection = await inspectMcpProviderAttachments(sandboxName, runtimeSelection);
  if (!inspection.attachments) {
    throw new McpBridgeError(
      inspection.error ?? `Could not inspect providers attached to sandbox '${sandboxName}'.`,
    );
  }
  for (const entry of entries) {
    const credentialKey = entry.env[0];
    const collision = inspection.attachments.find(
      (attachment) =>
        attachment.credentialKeys.includes(credentialKey) &&
        !(attachment.name === entry.providerName && attachment.providerId === entry.providerId),
    );
    if (collision) {
      throw new McpBridgeError(
        `Credential key '${credentialKey}' is already supplied by attached provider '${collision.name}' with ID '${collision.providerId ?? "missing"}'. Refusing to continue managed MCP while this sandbox receives that key from another provider.`,
      );
    }
  }
}

export async function assertNoRegisteredProviderCredentialCollisions(
  entries: readonly McpBridgeEntry[],
  deps: {
    listExtraProviders?: () => string[];
    inspectProvider?: (providerName: string) => Promise<McpProviderInspection>;
    runtimeSelection?: McpProviderInspectionRuntimeSelection;
  } = {},
): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries) assertAuthenticatedBridgeEntry(entry);
  const queryExtraProviders = deps.listExtraProviders ?? listExtraProviders;
  const inspectProvider =
    deps.inspectProvider ??
    ((providerName: string) => inspectMcpProvider(providerName, deps.runtimeSelection));
  for (const providerName of queryExtraProviders()) {
    const provider = await inspectProvider(providerName);
    if (provider.exists === false) continue;
    if (provider.exists !== true || !provider.id || !provider.credentialKeys) {
      throw new McpBridgeError(
        provider.error ??
          `Could not inspect registered provider '${providerName}' before managed MCP reconciliation.`,
      );
    }
    for (const entry of entries) {
      const credentialKey = entry.env[0];
      if (
        provider.credentialKeys.includes(credentialKey) &&
        !(providerName === entry.providerName && provider.id === entry.providerId)
      ) {
        throw new McpBridgeError(
          `Credential key '${credentialKey}' is already supplied by registered provider '${providerName}' with ID '${provider.id}'. Refusing to continue managed MCP because this provider will attach during sandbox rebuild.`,
        );
      }
    }
  }
}

export async function assertNoProviderCredentialCollisions(
  sandboxName: string,
  entries: readonly McpBridgeEntry[],
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): Promise<void> {
  await assertNoAttachedProviderCredentialCollisions(sandboxName, entries, runtimeSelection);
  await assertNoRegisteredProviderCredentialCollisions(entries, { runtimeSelection });
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
    inspection.type === MCP_BRIDGE_PROVIDER_TYPE &&
    expectedCredential !== undefined &&
    inspection.credentialKeys?.length === 1 &&
    inspection.credentialKeys[0] === expectedCredential
  );
}

export function providerMatchesManagedCredential(
  inspection: McpProviderInspection,
  expectedCredential: string | undefined,
  expectedProviderId: string | undefined,
  options: { allowLegacyGeneric?: boolean } = {},
): boolean {
  if (providerMatchesCredential(inspection, expectedCredential, expectedProviderId)) return true;
  return (
    options.allowLegacyGeneric === true &&
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
  if (
    providerMatchesManagedCredential(inspection, expectedCredential, expectedProviderId, {
      allowLegacyGeneric: true,
    })
  ) {
    return `Provider type 'generic' predates the OpenShell 0.0.106 endpoint-binding contract. Remove this MCP server, then add it again with '${expectedCredential ?? "<missing>"}' exported.`;
  }
  const type = inspection.type ?? "unparseable";
  const keys = inspection.credentialKeys?.join(", ") || "none or unparseable";
  return `Expected ${MCP_BRIDGE_PROVIDER_TYPE} provider with only credential key '${expectedCredential ?? "<missing>"}', found type '${type}' with keys '${keys}'.`;
}

export async function assertMcpProviderRecoverable(
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): Promise<McpProviderInspection> {
  assertAuthenticatedBridgeEntry(entry);
  if (!entry.providerId) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no stable OpenShell provider ID. Refusing to adopt or mutate same-name provider '${entry.providerName}'; remove the legacy bridge with --force and recreate it after independently cleaning the provider.`,
    );
  }
  const expectedCredential = entry.env[0];
  const inspection = await inspectMcpProvider(entry.providerName, runtimeSelection);
  if (inspection.exists === null) {
    throw new McpBridgeError(
      inspection.error ?? `Could not inspect OpenShell provider '${entry.providerName}'.`,
    );
  }
  if (inspection.exists) {
    if (
      inspection.type === "generic" &&
      providerMatchesManagedCredential(inspection, expectedCredential, entry.providerId, {
        allowLegacyGeneric: true,
      })
    ) {
      throw new McpBridgeError(
        `OpenShell provider '${entry.providerName}' uses the legacy generic profile, which OpenShell 0.0.106 cannot bind to an MCP endpoint. Run mcp remove for '${entry.server}', then add it again with '${expectedCredential}' exported.`,
      );
    }
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
): Promise<Map<string, McpBridgeTargetValidation>> {
  for (const entry of entries) assertAuthenticatedBridgeEntry(entry);
  const results = await Promise.all(
    entries.map(async (entry) => {
      const trustedPrivateHosts = entry.trustedPrivateHost ? [entry.trustedPrivateHost] : undefined;
      const normalized = normalizeMcpServerUrl(entry.url, { trustedPrivateHosts });
      if (normalized !== entry.url) {
        throw new McpBridgeError(
          `MCP server '${entry.server}' has a non-canonical stored URL. Remove it with --force and add it again before lifecycle operations.`,
        );
      }
      if (entry.trustedPrivateHost) {
        if (new URL(normalized).hostname.toLowerCase() !== entry.trustedPrivateHost) {
          throw new McpBridgeError(
            `MCP server '${entry.server}' has trusted-private intent for a host that does not match its stored URL. Remove it with --force and add it again.`,
            2,
          );
        }
        const recordedPins = entry.allowedIps ?? [];
        let replay;
        try {
          replay = replayTrustedPrivateEndpoint(entry.trustedPrivateHost, recordedPins, {
            requireAllPrivate: true,
          });
        } catch (error) {
          throw new McpBridgeError(
            `MCP server '${entry.server}' has invalid durable trusted-private intent: ${error instanceof Error ? error.message : String(error)}. Remove it with --force and add it again.`,
            2,
          );
        }
        if (
          replay.host !== entry.trustedPrivateHost ||
          recordedPins.length === 0 ||
          replay.addresses.length !== recordedPins.length ||
          replay.addresses.some((address, index) => address !== recordedPins[index])
        ) {
          throw new McpBridgeError(
            `MCP server '${entry.server}' has non-canonical trusted-private address pins. Remove it with --force and add it again.`,
            2,
          );
        }
        const target: McpBridgeTargetValidation = {
          addresses: [...replay.addresses],
          trustedPrivateCapability: replay.trustedPrivateCapability,
          trustedPrivateHost: replay.host,
        };
        return [entry.server, target] as const;
      }
      const target = await preflightMcpServerUrlResolvedTarget(new URL(normalized));
      return [entry.server, target] as const;
    }),
  );
  return new Map(results);
}

export async function providerAttached(
  sandboxName: string,
  providerName: string | undefined,
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): Promise<boolean | null> {
  if (!providerName) return null;
  const inspection = await inspectMcpProviderAttachments(sandboxName, runtimeSelection);
  if (!inspection.attachments) return null;
  return inspection.attachments.some((attachment) => attachment.name === providerName);
}
