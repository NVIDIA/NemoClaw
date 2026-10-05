// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import {
  observeExportGateway,
  createExportGatewayConnection,
  type ExportGatewayConnection,
} from "./gateway-export";

import { createProviders, type Provider } from "../openshell/providers";
import { createSynchronousCliOpenShellInferenceRouteObserver } from "../openshell/inference-route-cli";
import { createSandboxes, type Sandbox } from "../openshell/sandboxes";
import { createSandboxConfig } from "../openshell/sandbox-config";
import { captureSanitizedResolvedOpenshell } from "../openshell/sanitized-capture";
import { fingerprintOpenShellSandboxId } from "../openshell/sandbox-identity";
import { namedOpenShellGateway } from "../openshell/sandbox-observer";
import {
  EXPORT_REGISTRY_EVIDENCE_KEYS,
  exportWebSearchBinding,
} from "../../domain/config/export-evidence";
import type {
  ExportSnapshotReadStage,
  ExportSnapshotReader,
  ObservedExportGateway,
  ObservedExportSnapshot,
  ObservedExportInference,
  ObservedExportWebSearchProvider,
  ObservedManagedVllmRuntime,
  ObservedExportEndpointEvidence,
  ObservedExportRegistry,
  ObservedExportSandboxIdentity,
  RawExportSnapshot,
} from "../../domain/config/export-evidence";
import { VLLM_LOCAL_CREDENTIAL_ENV } from "../../inference/serving/vllm-credential-contract";
import { observeManagedVllmForExport } from "../../inference/serving/vllm-export-runtime";
import { createOllamaExportProbe } from "../../inference/ollama/proxy";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import { observeOllamaProxy } from "../../inference/ollama/proxy-observation";
import { normalizeInferenceSelection } from "../../inference/selection";
import { isSandboxPolicyCredentialFree } from "../../policy/sandbox-policy-validation";
import { getSandboxEntryInference } from "../../state/registry-entry-view";
import { load as loadRegistry } from "../../state/registry/persistence";
import type { SandboxEntry } from "../../state/registry/types";

const CAPTURE_TIMEOUT_MS = 30_000;

function registryEvidence(entry: Readonly<SandboxEntry>): ObservedExportRegistry {
  return {
    name: entry.name,
    ...Object.fromEntries(EXPORT_REGISTRY_EVIDENCE_KEYS.map((key) => [key, entry[key]])),
  } as ObservedExportRegistry;
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

async function readInferenceRoute(
  entry: Readonly<SandboxEntry>,
  gateway: ObservedExportGateway,
  connection?: ExportGatewayConnection,
) {
  const selected = getSandboxEntryInference(entry);
  const capture = connection?.captureInferenceRoute ?? captureSanitizedResolvedOpenshell;
  const observer = createSynchronousCliOpenShellInferenceRouteObserver((args, options) =>
    capture(args, {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      maxBuffer: options.maxBuffer,
      timeout: options?.timeout ?? CAPTURE_TIMEOUT_MS,
    }),
  );
  const result = observer.observeInferenceRoute({
    target: namedOpenShellGateway(gateway.name),
    timeoutMs: CAPTURE_TIMEOUT_MS,
  });
  if (!result.ok || result.value.state !== "configured")
    throw new Error("The live gateway inference route could not be read.");
  const live = result.value.route;
  if (
    selected.kind !== "configured" ||
    live.provider !== selected.provider ||
    live.model !== selected.model
  )
    throw new Error("The live gateway inference route does not match the registry.");
  return live;
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

function expectedCredentialKeys(credentialEnv: string | null, routeProvider: string): string[] {
  // vLLM onboarding always registers this gateway-owned key, including for
  // legacy host-local installs whose registry credential remains null.
  if (routeProvider === "vllm-local") return [VLLM_LOCAL_CREDENTIAL_ENV];
  // Ollama onboarding has no user credential; its managed proxy still authenticates the route.
  if (routeProvider === "ollama-local" && credentialEnv === null)
    return [OLLAMA_LOCAL_CREDENTIAL_ENV];
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
  // OpenShell's CLI writes the selected workspace for a newly created
  // provider, while legacy records and protobuf defaults can leave the field
  // empty. A different workspace is outside this direct provider contract.
  const managedBindingMatches =
    !managed ||
    ((provider.profileWorkspace === undefined ||
      provider.profileWorkspace === "" ||
      provider.profileWorkspace === provider.workspace) &&
      provider.managedProfile === undefined);
  return (
    type !== null &&
    managedBindingMatches &&
    isDeepStrictEqual(
      [provider.name, provider.type, provider.credentialKeys, provider.configKeys],
      [
        routeProvider,
        builtin ? "nvidia" : type,
        expectedCredentialKeys(normalized.credentialEnv, routeProvider),
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
  connection?: ExportGatewayConnection,
): Promise<ObservedExportEndpointEvidence> {
  const { configKey } = providerContract(normalized.preferredInferenceApi);
  const inspectOpenAiProfile = routeProvider === "ollama-local";
  const provider = await createProviders(connection?.connect).get({
    target: namedOpenShellGateway(gatewayName),
    workspace: "default",
    name: routeProvider,
    ...(inspectOpenAiProfile ? { profileContract: "openai" as const } : {}),
    configKeys: [configKey],
    signal,
  });
  if (!provider) throw new Error("The live inference provider is missing.");
  const builtin = provider.builtinInferenceEndpoint !== undefined;
  if (!matchesProviderMetadata(provider, normalized, routeProvider, !!managedServing)) {
    throw new Error("The live inference provider metadata does not match the registry.");
  }
  return {
    provider: providerIdentity(provider, gatewayName, inspectOpenAiProfile),
    endpoint: provider.builtinInferenceEndpoint ?? provider.config[configKey] ?? "",
    source: builtin
      ? { kind: "builtin-profile", profileId: "nvidia" }
      : { kind: "provider-config", key: configKey },
  };
}

async function inferenceFor(
  entry: Readonly<SandboxEntry>,
  gateway: ObservedExportGateway,
  beforeRead: (stage: ExportSnapshotReadStage) => void,
  signal: AbortSignal,
  managedServing?: ObservedManagedVllmRuntime,
  connection?: ExportGatewayConnection,
): Promise<ObservedExportInference> {
  const normalized = normalizeInferenceSelection(entry);
  const live = await readInferenceRoute(entry, gateway, connection);
  beforeRead("provider-metadata");
  const endpointEvidence = await readProviderEvidence(
    normalized,
    live.provider,
    gateway.name,
    signal,
    managedServing,
    connection,
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
  binding: NonNullable<ReturnType<typeof exportWebSearchBinding>>,
  gatewayName: string,
  signal: AbortSignal,
  connection?: ExportGatewayConnection,
): Promise<ObservedExportWebSearchProvider> {
  const provider = await createProviders(connection?.connect).get({
    target: namedOpenShellGateway(gatewayName),
    workspace: "default",
    name: binding.name,
    configKeys: [],
    profileContract: binding.profileId,
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
    ...(provider.managedProfile === undefined || provider.managedProfile === null
      ? {}
      : { profile: provider.managedProfile }),
    credentialKeys: provider.credentialKeys,
    configKeys: provider.configKeys,
  };
}

async function effectivePolicy(
  gateway: ObservedExportGateway,
  row: Sandbox,
  signal: AbortSignal,
  connection?: ExportGatewayConnection,
) {
  const { policy, ...configuration } = await createSandboxConfig(connection?.connect).get({
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

async function recheckExternalGateway(
  entry: Readonly<SandboxEntry>,
  gateway: ObservedExportGateway,
  beforeRead: (stage: ExportSnapshotReadStage) => void,
) {
  if (!gateway.external) return;
  const confirmed = await observeExportGateway(entry, beforeRead);
  beforeRead("gateway-stability");
  if (!isDeepStrictEqual(gateway, confirmed)) {
    throw new Error("External gateway changed during the source read.");
  }
}

async function readGatewaySnapshot(
  sandboxName: string,
  entry: Readonly<SandboxEntry>,
  gateway: ObservedExportGateway,
  signal: AbortSignal,
  connection: ExportGatewayConnection,
  beforeRead: (stage: ExportSnapshotReadStage) => void,
): Promise<ObservedExportSnapshot> {
  const row = await createSandboxes(connection?.connect).get({
    target: namedOpenShellGateway(gateway.name),
    workspace: "default",
    name: sandboxName,
    signal,
  });
  if (!row) throw new Error("The live sandbox is missing.");
  beforeRead("sandbox-identity");
  const sandbox = sandboxIdentity(row);
  beforeRead("managed-serving");
  const managedServing =
    entry.provider === "vllm-local"
      ? observeManagedVllmForExport(entry.servingProfileProvenance)
      : undefined;
  beforeRead("inference-route");
  const inference = await inferenceFor(
    entry,
    gateway,
    beforeRead,
    signal,
    managedServing,
    connection,
  );
  let webSearchProvider: ObservedExportWebSearchProvider | undefined;
  const search = exportWebSearchBinding(entry);
  if (search) {
    beforeRead("web-search-provider");
    webSearchProvider = await readWebSearchProvider(search, gateway.name, signal, connection);
  }
  beforeRead("effective-policy");
  const { configuration, ...policy } = await effectivePolicy(gateway, row, signal, connection);
  beforeRead("gateway-binding");
  await recheckExternalGateway(entry, gateway, beforeRead);
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
}

async function readSnapshot(sandboxName: string): Promise<RawExportSnapshot> {
  let stage: ExportSnapshotReadStage = "registry";
  let connection: ExportGatewayConnection;
  let result: RawExportSnapshot;
  const beforeRead = (nextStage: ExportSnapshotReadStage) => {
    stage = nextStage;
  };
  try {
    const entry = loadRegistry().sandboxes[sandboxName] ?? null;
    if (!entry) return { kind: "not-found", sandboxName };
    stage = "gateway-binding";
    const gateway = await observeExportGateway(entry, beforeRead);
    stage = "sandbox-inventory";
    const signal = AbortSignal.timeout(CAPTURE_TIMEOUT_MS);
    connection = createExportGatewayConnection(gateway, signal);
    result = await readGatewaySnapshot(sandboxName, entry, gateway, signal, connection, beforeRead);
  } catch {
    result = { kind: "read-failed", stage };
  }
  const directoryName = connection?.removeTemporaryHome();
  if (directoryName) {
    return {
      kind: "cleanup-failed",
      directoryName,
      ...(result.kind === "read-failed" ? { readFailure: result.stage } : {}),
    };
  }
  return result;
}

/** Concrete read-only bindings for one complete export snapshot. */
export function createLiveExportSnapshotReader(): ExportSnapshotReader {
  return { read: readSnapshot };
}
