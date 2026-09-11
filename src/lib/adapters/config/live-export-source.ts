// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import { isDeepStrictEqual } from "node:util";
import { isValidNemoClawPort } from "../../config/model";

import { createProviders, type Provider } from "../openshell/providers";
import { createSandboxes, type Sandbox } from "../openshell/sandboxes";
import { createSandboxConfig } from "../openshell/sandbox-config";
import { captureSanitizedResolvedOpenshell } from "../openshell/sanitized-capture";
import { fingerprintOpenShellSandboxId } from "../openshell/sandbox-identity";
import { namedOpenShellGateway } from "../openshell/sandbox-observer";
import { EXPORT_REGISTRY_EVIDENCE_KEYS } from "../../domain/config/export-evidence";
import type {
  ExportSnapshotReadStage,
  ExportSnapshotReader,
  ObservedExportGateway,
  ObservedExportInference,
  ObservedExportWebSearchProvider,
  ObservedManagedVllmRuntime,
  ObservedExportEndpointEvidence,
  ObservedExportRegistry,
  ObservedExportSandboxIdentity,
  RawExportSnapshot,
} from "../../domain/config/export-evidence";
import { getLiveGatewayInference } from "../../inference/live";
import { VLLM_LOCAL_CREDENTIAL_ENV } from "../../inference/serving/vllm-credential-contract";
import { observeManagedVllmForExport } from "../../inference/serving/vllm-export-runtime";
import { createOllamaExportProbe } from "../../inference/ollama/proxy";
import { observeOllamaProxy } from "../../inference/ollama/proxy-observation";
import { normalizeInferenceSelection } from "../../inference/selection";
import { resolveGatewayName } from "../../onboard/gateway-binding/identity";
import {
  managedGatewayStateRootOwnershipFailure,
  resolveGatewayStateDirForPort,
} from "../../onboard/gateway/state-dir";
import { isSandboxPolicyCredentialFree } from "../../policy/sandbox-policy-validation";
import { getSandboxEntryInference } from "../../state/registry-entry-view";
import { load as loadRegistry } from "../../state/registry/persistence";
import type { SandboxEntry } from "../../state/registry/types";

const CAPTURE_MAX_BYTES = 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 30_000;

function registryEvidence(entry: Readonly<SandboxEntry>): ObservedExportRegistry {
  return {
    name: entry.name,
    ...Object.fromEntries(EXPORT_REGISTRY_EVIDENCE_KEYS.map((key) => [key, entry[key]])),
  } as ObservedExportRegistry;
}

function resolveGatewayBinding(entry: Readonly<SandboxEntry>): { name: string; port: number } {
  const port = entry.gatewayPort;
  if (!isValidNemoClawPort(port)) {
    throw new Error("The persisted gateway port is incomplete or invalid.");
  }
  const name = resolveGatewayName(port);
  if (entry.gatewayName !== name) {
    throw new Error("The persisted gateway name and port disagree.");
  }
  return { name, port };
}

function gatewayFor(entry: Readonly<SandboxEntry>): ObservedExportGateway {
  const { name, port } = resolveGatewayBinding(entry);
  const stateDir = resolveGatewayStateDirForPort({
    configured: process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
    home: os.homedir(),
    port,
  });
  const stateRootOwned =
    managedGatewayStateRootOwnershipFailure({ gatewayName: name, gatewayPort: port, stateDir }) ===
    null;
  return {
    name,
    port,
    management: stateRootOwned ? "nemoclaw" : "unknown",
    stateRootOwned,
  };
}

function sandboxIdentity(row: Sandbox): ObservedExportSandboxIdentity {
  const fingerprint = fingerprintOpenShellSandboxId(row.id);
  if (!fingerprint) throw new Error("OpenShell sandbox identity is invalid.");
  return {
    sandboxId: row.id,
    fingerprint,
    workspace: row.workspace,
    resourceVersion: row.resourceVersion,
    policyVersion: row.policyVersion,
    imageRef: row.image,
    providerNames: row.providers,
  };
}

function readInferenceRoute(entry: Readonly<SandboxEntry>, gatewayName: string) {
  const selected = getSandboxEntryInference(entry);
  const live = getLiveGatewayInference(
    (args, options) =>
      args.includes("-g") || args.includes("--gateway")
        ? captureSanitizedResolvedOpenshell(args, {
            ignoreError: true,
            includeStderr: true,
            includeStreams: true,
            maxBuffer: CAPTURE_MAX_BYTES,
            timeout: options?.timeout ?? CAPTURE_TIMEOUT_MS,
          })
        : { status: 1, output: "" },
    { gatewayName: gatewayName, timeout: CAPTURE_TIMEOUT_MS },
  );
  if (live.failure || !live.inference)
    throw new Error("The live gateway inference route could not be read.");
  if (
    selected.kind !== "configured" ||
    live.inference.provider !== selected.provider ||
    live.inference.model !== selected.model
  )
    throw new Error("The live gateway inference route does not match the registry.");
  return { provider: live.inference.provider, model: live.inference.model };
}

function providerContract(api: string | null | undefined) {
  if (api?.startsWith("anthropic")) {
    return { type: "anthropic", configKey: "ANTHROPIC_BASE_URL" } as const;
  }
  const type = api?.startsWith("openai") ? "openai" : null;
  return { type, configKey: "OPENAI_BASE_URL" } as const;
}

function providerIdentity(provider: Provider, gatewayName: string, managed: boolean) {
  return {
    gatewayName,
    workspace: provider.workspace,
    name: provider.name,
    id: provider.id,
    resourceVersion: provider.resourceVersion,
    ...(managed
      ? { profileWorkspace: provider.profileWorkspace, managedProfile: provider.managedProfile }
      : {}),
  };
}

function expectedCredentialKeys(credentialEnv: string | null, managed: boolean): string[] {
  if (managed) return [VLLM_LOCAL_CREDENTIAL_ENV];
  return credentialEnv === null ? [] : [credentialEnv];
}

function inferenceTopology(
  entry: Readonly<SandboxEntry>,
  managed: boolean,
): ObservedExportInference["topology"] {
  if (managed) return "managed";
  if (entry.provider === "ollama-local") return "local";
  return entry.hostLocalInferenceReceipt || entry.hostLocalInferenceProvenance || entry.nimContainer
    ? "local"
    : "hosted";
}

function matchesProviderMetadata(
  provider: Provider,
  normalized: ReturnType<typeof normalizeInferenceSelection>,
  routeProvider: string,
  managed: boolean,
): boolean {
  const { type, configKey } = providerContract(normalized.preferredInferenceApi);
  const builtin = provider.builtinInferenceEndpoint !== undefined;
  return (
    type !== null &&
    isDeepStrictEqual(
      [provider.name, provider.type, provider.credentialKeys, provider.configKeys],
      [
        routeProvider,
        builtin ? "nvidia" : type,
        expectedCredentialKeys(normalized.credentialEnv, managed),
        builtin ? [] : [configKey],
      ],
    )
  );
}

async function readProviderEvidence(
  normalized: ReturnType<typeof normalizeInferenceSelection>,
  routeProvider: string,
  gatewayName: string,
  signal: AbortSignal,
  managedServing?: ObservedManagedVllmRuntime,
): Promise<ObservedExportEndpointEvidence> {
  const { configKey } = providerContract(normalized.preferredInferenceApi);
  const managedProfile = !!managedServing || routeProvider === "ollama-local";
  const provider = await createProviders().get({
    target: namedOpenShellGateway(gatewayName),
    workspace: "default",
    name: routeProvider,
    ...(managedProfile ? { profileContract: "openai" as const } : {}),
    configKeys: [configKey],
    signal,
  });
  if (!provider) throw new Error("The live inference provider is missing.");
  const builtin = provider.builtinInferenceEndpoint !== undefined;
  if (!matchesProviderMetadata(provider, normalized, routeProvider, !!managedServing)) {
    throw new Error("The live inference provider metadata does not match the registry.");
  }
  return {
    provider: providerIdentity(provider, gatewayName, managedProfile),
    endpoint: provider.builtinInferenceEndpoint ?? provider.config[configKey] ?? "",
    source: builtin
      ? { kind: "builtin-profile", profileId: "nvidia" }
      : { kind: "provider-config", key: configKey },
  };
}

async function inferenceFor(
  entry: Readonly<SandboxEntry>,
  beforeRead: (stage: ExportSnapshotReadStage) => void,
  signal: AbortSignal,
  managedServing?: ObservedManagedVllmRuntime,
): Promise<ObservedExportInference> {
  const normalized = normalizeInferenceSelection(entry);
  const gateway = resolveGatewayBinding(entry);
  const live = readInferenceRoute(entry, gateway.name);
  beforeRead("provider-metadata");
  const endpointEvidence = await readProviderEvidence(
    normalized,
    live.provider,
    gateway.name,
    signal,
    managedServing,
  );
  let ollamaServing: ObservedExportInference["ollamaServing"];
  if (entry.provider === "ollama-local") {
    beforeRead("ollama-serving");
    ollamaServing = observeOllamaProxy({ model: live.model, ...createOllamaExportProbe() });
  }
  return {
    topology: inferenceTopology(entry, !!managedServing),
    provider: live.provider,
    model: live.model,
    api: normalized.preferredInferenceApi ?? "",
    endpoint: normalized.endpointUrl ?? "",
    endpointEvidence,
    credentialEnv: normalized.credentialEnv,
    ...(managedServing ? { managedServing } : {}),
    ...(ollamaServing ? { ollamaServing } : {}),
  };
}

async function readWebSearchProvider(
  entry: Readonly<SandboxEntry>,
  gatewayName: string,
  signal: AbortSignal,
): Promise<ObservedExportWebSearchProvider> {
  const provider = await createProviders().get({
    target: namedOpenShellGateway(gatewayName),
    workspace: "default",
    name: `${entry.name}-brave-search`,
    configKeys: [],
    profileContract: "brave",
    signal,
  });
  if (!provider) throw new Error("The live web-search provider is missing.");
  return {
    gatewayName,
    workspace: provider.workspace,
    name: provider.name,
    id: provider.id,
    resourceVersion: provider.resourceVersion,
    type: provider.type,
    ...(provider.profileWorkspace === undefined
      ? {}
      : { profileWorkspace: provider.profileWorkspace }),
    ...(provider.managedProfile === undefined ? {} : { profile: provider.managedProfile }),
    credentialKeys: provider.credentialKeys,
    configKeys: provider.configKeys,
  };
}

async function effectivePolicy(gateway: ObservedExportGateway, row: Sandbox, signal: AbortSignal) {
  const { policy, ...configuration } = await createSandboxConfig().get({
    target: namedOpenShellGateway(gateway.name),
    workspace: row.workspace,
    sandboxId: row.id,
    signal,
  });
  if (policy.appliedRevision === null) {
    throw new Error("The effective OpenShell policy and its applied revision could not be read.");
  }
  if (!isSandboxPolicyCredentialFree(policy.document)) {
    throw new Error("The effective OpenShell policy is not credential-free.");
  }
  if (
    row.policyVersion !== policy.appliedRevision ||
    configuration.revision !== policy.appliedRevision
  ) {
    throw new Error("The effective OpenShell policy revision does not match the live sandbox.");
  }
  return {
    sandboxId: row.id,
    revision: String(policy.appliedRevision),
    document: policy.document,
    configuration,
  };
}

async function readSnapshot(sandboxName: string): Promise<RawExportSnapshot> {
  let stage: ExportSnapshotReadStage = "registry";
  try {
    const entry = loadRegistry().sandboxes[sandboxName] ?? null;
    if (!entry) {
      return { kind: "not-found", sandboxName };
    }
    stage = "gateway-binding";
    const gateway = gatewayFor(entry);
    stage = "sandbox-inventory";
    const signal = AbortSignal.timeout(CAPTURE_TIMEOUT_MS);
    const row = await createSandboxes().get({
      target: namedOpenShellGateway(gateway.name),
      workspace: "default",
      name: sandboxName,
      signal,
    });
    if (!row) throw new Error("The live sandbox is missing.");
    stage = "sandbox-identity";
    const sandbox = sandboxIdentity(row);
    stage = "managed-serving";
    const managedServing =
      entry.provider === "vllm-local" && entry.servingProfileProvenance
        ? observeManagedVllmForExport(entry.servingProfileProvenance)
        : undefined;
    stage = "inference-route";
    const inference = await inferenceFor(
      entry,
      (nextStage) => {
        stage = nextStage;
      },
      signal,
      managedServing,
    );
    let webSearchProvider: ObservedExportWebSearchProvider | undefined;
    if (entry.webSearchEnabled === true && entry.webSearchProvider === "brave") {
      stage = "web-search-provider";
      webSearchProvider = await readWebSearchProvider(entry, gateway.name, signal);
    }
    stage = "effective-policy";
    const { configuration, ...policy } = await effectivePolicy(gateway, row, signal);
    return {
      kind: "observed",
      sandboxName,
      registry: registryEvidence(entry),
      gateway,
      sandbox,
      inference,
      ...(webSearchProvider === undefined ? {} : { webSearchProvider }),
      policy,
      configuration,
    };
  } catch {
    return { kind: "read-failed", stage };
  }
}

/** Concrete read-only bindings for one complete export snapshot. */
export function createLiveExportSnapshotReader(): ExportSnapshotReader {
  return { read: readSnapshot };
}
