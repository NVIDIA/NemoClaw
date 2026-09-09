// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import { createProviders } from "../openshell/providers";
import { createSandboxes, type Sandbox } from "../openshell/sandboxes";
import { createSandboxConfig } from "../openshell/sandbox-config";
import { captureSanitizedResolvedOpenshell } from "../openshell/sanitized-capture";
import { fingerprintOpenShellSandboxId } from "../openshell/sandbox-identity";
import { namedOpenShellGateway } from "../openshell/sandbox-observer";
import { syncCliOpenShellSandboxPolicyReader } from "../openshell/sandbox-policy-cli";
import { EXPORT_REGISTRY_EVIDENCE_KEYS } from "../../domain/config/export-evidence";
import type {
  ExportSnapshotReadStage,
  ExportSnapshotReader,
  ObservedExportGateway,
  ObservedExportInference,
  ObservedExportRegistry,
  ObservedExportSandboxIdentity,
  RawExportSnapshot,
} from "../../domain/config/export-evidence";
import { getLiveGatewayInference } from "../../inference/live";
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
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
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

async function inferenceFor(
  entry: Readonly<SandboxEntry>,
  beforeProviderRead: () => void,
  signal: AbortSignal,
): Promise<ObservedExportInference> {
  const selected = getSandboxEntryInference(entry);
  const normalized = normalizeInferenceSelection(entry);
  const gateway = resolveGatewayBinding(entry);
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
    { gatewayName: gateway.name, timeout: CAPTURE_TIMEOUT_MS },
  );
  if (live.failure || !live.inference)
    throw new Error("The live gateway inference route could not be read.");
  if (
    selected.kind !== "configured" ||
    live.inference.provider !== selected.provider ||
    live.inference.model !== selected.model
  )
    throw new Error("The live gateway inference route does not match the registry.");
  beforeProviderRead();
  const expectedType = normalized.preferredInferenceApi?.startsWith("anthropic")
    ? "anthropic"
    : normalized.preferredInferenceApi?.startsWith("openai")
      ? "openai"
      : null;
  const expectedConfigKey = expectedType === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL";
  const provider = await createProviders().get({
    target: namedOpenShellGateway(gateway.name),
    workspace: "default",
    name: live.inference.provider,
    configKeys: [expectedConfigKey],
    signal,
  });
  if (!provider) throw new Error("The live inference provider is missing.");
  const expectedCredentialCount = normalized.credentialEnv === null ? 0 : 1;
  if (
    provider.name !== live.inference.provider ||
    expectedType === null ||
    provider.type !== expectedType ||
    provider.credentialKeys.length !== expectedCredentialCount ||
    (normalized.credentialEnv !== null &&
      provider.credentialKeys[0] !== normalized.credentialEnv) ||
    provider.configKeys.length !== 1 ||
    provider.configKeys[0] !== expectedConfigKey
  )
    throw new Error("The live inference provider metadata does not match the registry.");

  return {
    topology:
      entry.hostLocalInferenceReceipt || entry.hostLocalInferenceProvenance || entry.nimContainer
        ? "local"
        : "hosted",
    provider: live.inference.provider,
    model: live.inference.model,
    api: normalized.preferredInferenceApi ?? "",
    endpoint: normalized.endpointUrl ?? "",
    endpointEvidence: {
      endpoint: provider.config[expectedConfigKey] ?? "",
      gatewayName: gateway.name,
      providerName: provider.name,
      configKey: expectedConfigKey,
      providerId: provider.id,
      workspace: provider.workspace,
      resourceVersion: provider.resourceVersion,
    },
    credentialEnv: normalized.credentialEnv,
  };
}

async function effectivePolicy(
  sandboxName: string,
  gateway: ObservedExportGateway,
  row: Sandbox,
  signal: AbortSignal,
) {
  const configuration = await createSandboxConfig().get({
    target: namedOpenShellGateway(gateway.name),
    workspace: row.workspace,
    sandboxId: row.id,
    signal,
  });
  const result = syncCliOpenShellSandboxPolicyReader.readSandboxPolicy({
    target: namedOpenShellGateway(gateway.name),
    sandboxName,
    scope: "effective",
  });
  if (!result.ok || result.value.appliedRevision === null) {
    throw new Error("The effective OpenShell policy and its applied revision could not be read.");
  }
  if (!isSandboxPolicyCredentialFree(result.value.document)) {
    throw new Error("The effective OpenShell policy is not credential-free.");
  }
  if (
    row.policyVersion !== result.value.appliedRevision ||
    configuration.revision !== result.value.appliedRevision
  ) {
    throw new Error("The effective OpenShell policy revision does not match the live sandbox.");
  }
  return {
    sandboxId: row.id,
    revision: String(result.value.appliedRevision),
    document: result.value.document,
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
    stage = "inference-route";
    const inference = await inferenceFor(
      entry,
      () => {
        stage = "provider-metadata";
      },
      signal,
    );
    stage = "effective-policy";
    const { configuration, ...policy } = await effectivePolicy(sandboxName, gateway, row, signal);
    return {
      kind: "observed",
      sandboxName,
      registry: registryEvidence(entry),
      gateway,
      sandbox,
      inference,
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
