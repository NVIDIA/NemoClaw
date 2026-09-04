// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import { createCliOpenShellProviderAdapter } from "../adapters/openshell/provider-adapter-cli";
import { captureSanitizedResolvedOpenshell } from "../adapters/openshell/sanitized-capture";
import {
  fingerprintOpenShellSandboxId,
  parseStrictOpenShellSandboxListJson,
} from "../adapters/openshell/sandbox-identity";
import { inspectOpenShellSandboxIdentityFingerprint } from "../adapters/openshell/sandbox-identity-cli";
import { namedOpenShellGateway } from "../adapters/openshell/sandbox-observer";
import { syncCliOpenShellSandboxPolicyReader } from "../adapters/openshell/sandbox-policy-cli";
import { getLiveGatewayInference } from "../inference/live";
import { normalizeInferenceSelection } from "../inference/selection";
import { resolveGatewayName } from "../onboard/gateway-binding/identity";
import {
  managedGatewayStateRootOwnershipFailure,
  resolveGatewayStateDirForPort,
} from "../onboard/gateway/state-dir";
import { isSandboxPolicyCredentialFree } from "../policy/sandbox-policy-validation";
import { getSandboxEntryInference } from "../state/registry-entry-view";
import { load as loadRegistry } from "../state/registry/persistence";
import type { SandboxEntry } from "../state/registry/types";
import {
  observeStableExportSource,
  type ExportObservationResult,
  type ExportSnapshotReader,
  type ObservedExportGateway,
  type ObservedExportInference,
  type ObservedExportSandboxIdentity,
  type RawExportSnapshot,
} from "./export-observation";

const CAPTURE_MAX_BYTES = 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 30_000;

function liveRow(sandboxName: string, gatewayName: string) {
  const captured = captureSanitizedResolvedOpenshell(
    ["sandbox", "list", "-g", gatewayName, "-o", "json"],
    {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      maxBuffer: CAPTURE_MAX_BYTES,
      timeout: CAPTURE_TIMEOUT_MS,
    },
  );
  if (captured.status !== 0 || captured.error || (captured.stderr?.trim().length ?? 0) > 0) {
    throw new Error("OpenShell sandbox inventory could not be read.");
  }
  const rows = parseStrictOpenShellSandboxListJson(captured.stdout ?? captured.output);
  const matches = rows?.filter((row) => row.name === sandboxName) ?? [];
  if (matches.length !== 1) throw new Error("OpenShell sandbox identity is missing or ambiguous.");
  return matches[0]!;
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

function sandboxIdentity(
  sandboxName: string,
  gatewayName: string,
  row: ReturnType<typeof liveRow>,
): ObservedExportSandboxIdentity {
  const fingerprint = inspectOpenShellSandboxIdentityFingerprint({ sandboxName, gatewayName });
  const idFingerprint = fingerprintOpenShellSandboxId(row.id);
  if (!idFingerprint || fingerprint !== idFingerprint) {
    throw new Error("OpenShell sandbox inventory and identity inspection disagree.");
  }
  return {
    sandboxId: row.id,
    fingerprint,
    resourceVersion: row.resource_version,
    policyVersion: row.current_policy_version,
  };
}

async function inferenceFor(entry: Readonly<SandboxEntry>): Promise<ObservedExportInference> {
  const selected = getSandboxEntryInference(entry);
  const normalized = normalizeInferenceSelection(entry);
  const gateway = resolveGatewayBinding(entry);
  const live = getLiveGatewayInference(
    (args, options) =>
      captureSanitizedResolvedOpenshell(args, {
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
        maxBuffer: CAPTURE_MAX_BYTES,
        timeout: options?.timeout ?? CAPTURE_TIMEOUT_MS,
      }),
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
  const provider = await createCliOpenShellProviderAdapter().getProvider({
    target: namedOpenShellGateway(gateway.name),
    providerName: live.inference.provider,
    timeoutMs: CAPTURE_TIMEOUT_MS,
  });
  if (!provider.ok) throw new Error("The live inference provider metadata could not be read.");
  const expectedType = normalized.preferredInferenceApi?.startsWith("anthropic")
    ? "anthropic"
    : normalized.preferredInferenceApi?.startsWith("openai")
      ? "openai"
      : null;
  const expectedConfigKey = expectedType === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL";
  const expectedCredentialCount = normalized.credentialEnv === null ? 0 : 1;
  if (
    provider.value.name !== live.inference.provider ||
    expectedType === null ||
    provider.value.type !== expectedType ||
    provider.value.credentialKeys.length !== expectedCredentialCount ||
    (normalized.credentialEnv !== null &&
      provider.value.credentialKeys[0] !== normalized.credentialEnv) ||
    provider.value.configKeys.length !== 1 ||
    provider.value.configKeys[0] !== expectedConfigKey
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
    // OpenShell's provider metadata does not expose an independently read
    // endpoint value. V1 export therefore fails closed at the pure boundary.
    endpointEvidence: null,
    credentialEnv: normalized.credentialEnv,
  };
}

function effectivePolicy(
  sandboxName: string,
  gateway: ObservedExportGateway,
  row: ReturnType<typeof liveRow>,
) {
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
  if (row.current_policy_version !== result.value.appliedRevision) {
    throw new Error("The effective OpenShell policy revision does not match the live sandbox.");
  }
  return {
    sandboxId: row.id,
    revision: String(result.value.appliedRevision),
    document: result.value.document,
  };
}

async function readSnapshot(sandboxName: string): Promise<RawExportSnapshot> {
  const entry = loadRegistry().sandboxes[sandboxName] ?? null;
  if (!entry) {
    return { kind: "not-found", sandboxName };
  }
  const gateway = gatewayFor(entry);
  const row = liveRow(sandboxName, gateway.name);
  const sandbox = sandboxIdentity(sandboxName, gateway.name, row);
  const inference = await inferenceFor(entry);
  const policy = effectivePolicy(sandboxName, gateway, row);
  return {
    kind: "observed",
    sandboxName,
    registry: entry,
    gateway,
    sandbox,
    inference,
    policy,
  };
}

/** Concrete read-only bindings for one complete export snapshot. */
export function createLiveExportSnapshotReader(): ExportSnapshotReader {
  return {
    read: async (sandboxName) => {
      try {
        return await readSnapshot(sandboxName);
      } catch {
        return { kind: "read-failed" };
      }
    },
  };
}

/** Resolve one verified observation without reading credential values or mutating state. */
export async function observeLiveExportSource(
  sandboxName: string,
): Promise<ExportObservationResult> {
  return observeStableExportSource(sandboxName, createLiveExportSnapshotReader());
}
