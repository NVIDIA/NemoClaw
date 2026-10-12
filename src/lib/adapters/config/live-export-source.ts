// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import {
  providerContract,
  matchesProviderMetadata,
  resolveExportInferenceSelection,
  type NativeInferenceReceipt,
} from "./live-export-inference-contract";
import { isValidNemoClawPort } from "../../config/model";

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
  ObservedExportInference,
  ObservedExportWebSearchProvider,
  ObservedManagedVllmRuntime,
  ObservedExportEndpointEvidence,
  ObservedExportRegistry,
  ObservedExportSandboxIdentity,
  RawExportSnapshot,
} from "../../domain/config/export-evidence";
import { observeManagedVllmForExport } from "../../inference/serving/vllm-export-runtime";
import { createOllamaExportProbe } from "../../inference/ollama/proxy";
import { observeOllamaProxy } from "../../inference/ollama/proxy-observation";
import type { normalizeInferenceSelection } from "../../inference/selection";
import { resolveGatewayName } from "../../onboard/gateway-binding/identity";
import {
  managedGatewayStateRootOwnershipFailure,
  resolveGatewayStateDirForPort,
} from "../../onboard/gateway/state-dir";
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
  const configuredStateDir = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR?.trim();
  const stateDir = resolveGatewayStateDirForPort({
    configured: configuredStateDir,
    home: os.homedir(),
    port,
  });
  const stateRootOwned =
    managedGatewayStateRootOwnershipFailure(
      { gatewayName: name, gatewayPort: port, stateDir },
      { allowLegacyManagedState: !configuredStateDir },
    ) === null;
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

async function readInferenceRoute(entry: Readonly<SandboxEntry>, gatewayName: string) {
  const selected = getSandboxEntryInference(entry);
  const observer = createSynchronousCliOpenShellInferenceRouteObserver((args, options) =>
    captureSanitizedResolvedOpenshell(args, {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      maxBuffer: options.maxBuffer,
      timeout: options?.timeout ?? CAPTURE_TIMEOUT_MS,
    }),
  );
  const result = observer.observeInferenceRoute({
    target: namedOpenShellGateway(gatewayName),
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

function providerIdentity(
  provider: Provider,
  gatewayName: string,
  managed: boolean,
): ObservedExportEndpointEvidence["provider"] {
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

function profileContractFor(
  routeProvider: string,
  nativeReceipt: NativeInferenceReceipt | undefined,
): "native-nvidia" | "native-hosted" | "openai" | undefined {
  if (nativeReceipt)
    return nativeReceipt.profileId === "nemoclaw-nvidia-inference-v1"
      ? "native-nvidia"
      : "native-hosted";
  return routeProvider === "ollama-local" ? "openai" : undefined;
}

function endpointSourceFor(
  nativeReceipt: NativeInferenceReceipt | undefined,
  builtin: boolean,
  configKey: "ANTHROPIC_BASE_URL" | "OPENAI_BASE_URL",
): ObservedExportEndpointEvidence["source"] {
  if (nativeReceipt) return { kind: "managed-profile", profileId: nativeReceipt.profileId };
  if (builtin) return { kind: "builtin-profile", profileId: "nvidia" };
  return { kind: "provider-config", key: configKey };
}

async function readProviderEvidence(
  normalized: ReturnType<typeof normalizeInferenceSelection>,
  routeProvider: string,
  gatewayName: string,
  signal: AbortSignal,
  managedServing?: ObservedManagedVllmRuntime,
  nativeReceipt?: NativeInferenceReceipt,
): Promise<ObservedExportEndpointEvidence> {
  const { configKey } = providerContract(normalized.preferredInferenceApi);
  const profileContract = profileContractFor(routeProvider, nativeReceipt);
  const provider = await createProviders().get({
    target: namedOpenShellGateway(gatewayName),
    workspace: "default",
    name: routeProvider,
    ...(profileContract ? { profileContract } : {}),
    ...(nativeReceipt?.endpointUrl
      ? {
          nativeHostedEndpoint: nativeReceipt.endpointUrl,
          nativeHostedAllowedIps: nativeReceipt.allowedIps,
        }
      : {}),
    configKeys: [configKey],
    signal,
  });
  if (!provider) throw new Error("The live inference provider is missing.");
  const builtin = provider.builtinInferenceEndpoint !== undefined;
  if (
    !matchesProviderMetadata(provider, normalized, routeProvider, !!managedServing, nativeReceipt)
  ) {
    throw new Error("The live inference provider metadata does not match the registry.");
  }
  return {
    provider: providerIdentity(provider, gatewayName, profileContract !== undefined),
    endpoint:
      provider.managedInferenceEndpoint ??
      provider.builtinInferenceEndpoint ??
      provider.config[configKey] ??
      "",
    source: endpointSourceFor(nativeReceipt, builtin, configKey),
  };
}

async function resolveLiveInference(
  entry: Readonly<SandboxEntry>,
  gatewayName: string,
  nativeReceipt: NativeInferenceReceipt | undefined,
): Promise<Readonly<{ provider: string; model: string; logicalProvider: string }>> {
  if (!nativeReceipt) {
    const live = await readInferenceRoute(entry, gatewayName);
    return { ...live, logicalProvider: live.provider };
  }
  const selected = getSandboxEntryInference(entry);
  if (selected.kind !== "configured") {
    throw new Error("The native inference selection is incomplete.");
  }
  return {
    provider: nativeReceipt.providerName,
    model: selected.model,
    logicalProvider: selected.provider,
  };
}

async function inferenceFor(
  entry: Readonly<SandboxEntry>,
  beforeRead: (stage: ExportSnapshotReadStage) => void,
  signal: AbortSignal,
  sandbox: ObservedExportSandboxIdentity,
  managedServing?: ObservedManagedVllmRuntime,
): Promise<ObservedExportInference> {
  const { normalized, nativeReceipt } = resolveExportInferenceSelection(entry);
  const gateway = resolveGatewayBinding(entry);
  if (nativeReceipt && !sandbox.providerNames.includes(nativeReceipt.providerName)) {
    throw new Error("The native provider is not attached to the sandbox.");
  }
  const live = await resolveLiveInference(entry, gateway.name, nativeReceipt);
  beforeRead("provider-metadata");
  const endpointEvidence = await readProviderEvidence(
    normalized,
    live.provider,
    gateway.name,
    signal,
    managedServing,
    nativeReceipt,
  );
  let ollamaServing: ObservedExportInference["ollamaServing"];
  if (entry.provider === "ollama-local") {
    beforeRead("ollama-serving");
    ollamaServing = observeOllamaProxy({ model: live.model, ...createOllamaExportProbe() });
  }
  return {
    topology: inferenceTopology(entry, !!managedServing),
    provider: live.logicalProvider,
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
): Promise<ObservedExportWebSearchProvider> {
  const provider = await createProviders().get({
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
      entry.provider === "vllm-local"
        ? observeManagedVllmForExport(entry.servingProfileProvenance)
        : undefined;
    stage = "inference-route";
    const inference = await inferenceFor(
      entry,
      (nextStage) => {
        stage = nextStage;
      },
      signal,
      sandbox,
      managedServing,
    );
    let webSearchProvider: ObservedExportWebSearchProvider | undefined;
    const search = exportWebSearchBinding(entry);
    if (search) {
      stage = "web-search-provider";
      webSearchProvider = await readWebSearchProvider(search, gateway.name, signal);
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
