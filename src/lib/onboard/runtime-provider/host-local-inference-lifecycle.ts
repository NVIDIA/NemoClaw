// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  createManagedLlamaCppLifecycleAdapter,
  type ManagedLlamaCppLifecycleAdapter,
  type ManagedLlamaCppLifecycleAdapterOptions,
} from "../../inference/llama-cpp/managed-lifecycle-adapter";
import { requireSandboxHostLocalInferenceProvenance } from "../../state/registry/host-local-inference";
import type { SandboxEntry } from "../../state/registry/types";
import type { RuntimeProviderBundle } from "./contract";
import {
  type HostLocalInferenceDestroyResult,
  type HostLocalInferenceReceipt,
  type HostLocalInferenceRuntime,
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "./host-local-inference";
import { HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL } from "./host-local-inference-routing";
import { requireRuntimeProviderHostLocalInferenceOperation } from "./registry";

export type ManagedHostLocalInferenceService = "ollama" | "nim" | "vllm" | "llama-cpp";

export type HostLocalInferenceLifecycleSandbox = Pick<
  SandboxEntry,
  | "agent"
  | "credentialEnv"
  | "endpointSource"
  | "endpointUrl"
  | "gatewayName"
  | "gatewayPort"
  | "hostLocalInferenceReceipt"
  | "hostLocalInferenceProvenance"
  | "lifecycleGeneration"
  | "model"
  | "name"
  | "openshellDriver"
  | "preferredInferenceApi"
  | "provider"
>;

export interface HostLocalInferenceSandboxAuthority {
  readonly schemaVersion: 1;
  readonly sandboxName: string;
  readonly agent: string;
  readonly providerId: string;
  readonly routeProvider: "ollama-local" | "vllm-local" | "llama-cpp-local";
  readonly model: string;
  readonly endpointUrl: string;
  readonly endpointSource: SandboxEntry["endpointSource"];
  readonly credentialEnv: string | null;
  readonly preferredInferenceApi: string | null;
  readonly gatewayName: string;
  readonly gatewayPort?: number;
  readonly lifecycleGeneration: string;
  readonly serializedReceipt: string;
  readonly hostLocalInferenceProvenance?: NonNullable<SandboxEntry["hostLocalInferenceProvenance"]>;
}

export interface PreparedHostLocalInferenceAuthority {
  readonly providerId: string;
  readonly sandboxName: string;
  readonly serializedReceipt: string;
  readonly receipt: HostLocalInferenceReceipt;
  readonly mode: "preserve" | "destroy";
  readonly sandboxAuthority: HostLocalInferenceSandboxAuthority;
  /** Stable compare-and-swap identity for the complete outer registry binding. */
  readonly sandboxAuthoritySha256: string;
}

export type HostLocalInferenceRetirementResult =
  | HostLocalInferenceDestroyResult
  | {
      readonly status: "shared";
      readonly receipt: HostLocalInferenceReceipt;
    };

export interface HostLocalInferenceLifecycleOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly createLlamaCppAdapter?: (
    options: ManagedLlamaCppLifecycleAdapterOptions,
  ) => ManagedLlamaCppLifecycleAdapter;
}

export interface HostLocalInferenceSharingAuthority {
  readonly disposition: "exclusive" | "shared";
  readonly sha256: string;
}

type ManagedHostLocalInferenceReceipt = HostLocalInferenceReceipt & {
  readonly service: ManagedHostLocalInferenceService;
};

const MANAGED_SERVICES = new Set<ManagedHostLocalInferenceService>(["ollama", "nim", "vllm"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function fail(message: string): never {
  throw new Error(`Host-local inference lifecycle authority is invalid: ${message}`);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactText(value: unknown, label: string, maxBytes = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    CONTROL_CHARACTERS.test(value) ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    fail(`${label} is missing or malformed`);
  }
  return value;
}

function parseManagedReceipt(
  serialized: string,
  sandbox?: HostLocalInferenceLifecycleSandbox,
): ManagedHostLocalInferenceReceipt | null {
  const receipt = parseHostLocalInferenceReceipt(serialized);
  if (MANAGED_SERVICES.has(receipt.service as ManagedHostLocalInferenceService)) {
    if (sandbox?.hostLocalInferenceProvenance) {
      requireSandboxHostLocalInferenceProvenance(sandbox.hostLocalInferenceProvenance, serialized);
    }
    return receipt as ManagedHostLocalInferenceReceipt;
  }
  if (receipt.service !== "llama-cpp") {
    if (sandbox?.hostLocalInferenceProvenance) fail("provenance names an unsupported service");
    return null;
  }
  if (!sandbox?.hostLocalInferenceProvenance) return null;
  requireSandboxHostLocalInferenceProvenance(sandbox.hostLocalInferenceProvenance, serialized);
  return receipt as ManagedHostLocalInferenceReceipt;
}

/** True only for receipts already handled by the common host-local lifecycle. */
export function isManagedHostLocalInferenceLifecycleReceipt(serialized: string): boolean {
  return parseManagedReceipt(serialized) !== null;
}

function sandboxAuthoritySha256(authority: HostLocalInferenceSandboxAuthority): string {
  return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

function captureSandboxAuthority(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  serialized: string,
  receipt: ManagedHostLocalInferenceReceipt,
): HostLocalInferenceSandboxAuthority {
  if (sandbox.hostLocalInferenceReceipt !== serialized) {
    fail(`target '${sandbox.name}' has different host-local inference authority`);
  }
  const providerId = exactText(sandbox.openshellDriver, "sandbox runtime provider");
  if (providerId !== provider.identity.id) {
    fail("sandbox runtime provider differs from the selected provider");
  }
  const routeProvider =
    receipt.service === "ollama"
      ? "ollama-local"
      : receipt.service === "llama-cpp"
        ? "llama-cpp-local"
        : "vllm-local";
  if (sandbox.provider !== routeProvider) {
    fail("sandbox route provider differs from the receipt service");
  }
  if (sandbox.endpointUrl !== HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL) {
    fail("sandbox inference endpoint is outside the canonical local route");
  }
  const receiptModel = receipt.service === "llama-cpp" ? sandbox.model : receipt.inference?.model;
  if (typeof receiptModel !== "string" || sandbox.model !== receiptModel) {
    fail("sandbox model differs from the provider inference proof");
  }
  const provenance = sandbox.hostLocalInferenceProvenance
    ? requireSandboxHostLocalInferenceProvenance(sandbox.hostLocalInferenceProvenance, serialized)
    : undefined;
  if (receipt.service === "llama-cpp" && !provenance) {
    fail("llama.cpp is missing explicit lifecycle provenance");
  }
  const gatewayPort = sandbox.gatewayPort;
  const hasGatewayPort =
    Number.isSafeInteger(gatewayPort) && Number(gatewayPort) >= 1 && Number(gatewayPort) <= 65_535;
  if (provenance && !hasGatewayPort) fail("sandbox gateway port is missing or malformed");
  return Object.freeze({
    schemaVersion: 1 as const,
    sandboxName: exactText(sandbox.name, "sandbox name"),
    agent: exactText(sandbox.agent, "sandbox agent"),
    providerId,
    routeProvider,
    model: exactText(receiptModel, "sandbox model"),
    endpointUrl: HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL,
    endpointSource: sandbox.endpointSource ?? null,
    credentialEnv: sandbox.credentialEnv ?? null,
    preferredInferenceApi: sandbox.preferredInferenceApi ?? null,
    gatewayName: exactText(sandbox.gatewayName, "sandbox gateway"),
    ...(hasGatewayPort ? { gatewayPort: Number(gatewayPort) } : {}),
    lifecycleGeneration: exactText(sandbox.lifecycleGeneration, "sandbox lifecycle generation"),
    serializedReceipt: serialized,
    ...(provenance ? { hostLocalInferenceProvenance: provenance } : {}),
  });
}

function requireRuntime(
  provider: RuntimeProviderBundle,
  receipt: ManagedHostLocalInferenceReceipt,
  sandbox: HostLocalInferenceLifecycleSandbox,
  options: HostLocalInferenceLifecycleOptions,
): HostLocalInferenceRuntime {
  const acceleration =
    receipt.runtime.kind === "host" ? receipt.runtime.acceleration : "nvidia-gpu";
  const operation = requireRuntimeProviderHostLocalInferenceOperation(provider, receipt.service, {
    env: options.environment ?? process.env,
    acceleration,
  });
  operation.assertAuthority();
  if (
    receipt.providerId !== provider.identity.id ||
    receipt.engineAuthority.providerId !== provider.identity.id ||
    operation.providerId !== provider.identity.id ||
    operation.engine.engineId !== receipt.engineAuthority.engineId ||
    operation.engine.authorityId !== receipt.engineAuthority.authorityId ||
    operation.bindingSha256 !== receipt.engineAuthority.bindingSha256
  ) {
    fail("receipt differs from the operation-scoped provider engine authority");
  }
  if (receipt.service === "llama-cpp") {
    const provenance = requireSandboxHostLocalInferenceProvenance(
      sandbox.hostLocalInferenceProvenance,
      sandbox.hostLocalInferenceReceipt ?? "",
    );
    const adapter = (options.createLlamaCppAdapter ?? createManagedLlamaCppLifecycleAdapter)({
      runtimeProvider: provider,
      runtimeOwnerSandboxName: provenance.runtimeOwnerSandboxName,
      expectedModel: exactText(sandbox.model, "sandbox model"),
      expectedReceipt: receipt,
      gatewayPort: sandbox.gatewayPort!,
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      operation,
    });
    if (adapter.model !== sandbox.model) {
      fail("sandbox model differs from reconstructed llama.cpp authority");
    }
    return adapter.runtime;
  }
  const runtime = operation.managedRuntime;
  if (
    !runtime ||
    runtime.providerId !== provider.identity.id ||
    runtime.authorityId !== operation.engine.authorityId ||
    !runtime.services.includes(receipt.service) ||
    typeof runtime.preserveForRebuild !== "function" ||
    typeof runtime.prepareDestroy !== "function" ||
    typeof runtime.destroy !== "function"
  ) {
    fail("provider returned an incomplete managed inference lifecycle");
  }
  return runtime;
}

function requireExactReceipt(
  expected: string,
  receipt: HostLocalInferenceReceipt,
  message: string,
): HostLocalInferenceReceipt {
  if (serializeHostLocalInferenceReceipt(receipt) !== expected) fail(message);
  return receipt;
}

function prepare(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  serialized: string,
  mode: PreparedHostLocalInferenceAuthority["mode"],
  options: HostLocalInferenceLifecycleOptions,
): PreparedHostLocalInferenceAuthority | null {
  const receipt = parseManagedReceipt(serialized, sandbox);
  if (!receipt) return null;
  const sandboxAuthority = captureSandboxAuthority(provider, sandbox, serialized, receipt);
  const runtime = requireRuntime(provider, receipt, sandbox, options);
  const reproved =
    mode === "destroy" ? runtime.prepareDestroy(receipt) : runtime.preserveForRebuild(receipt);
  requireExactReceipt(
    serialized,
    reproved,
    mode === "destroy"
      ? "provider authority changed during destroy preflight"
      : "provider authority changed while it was being preserved",
  );
  return Object.freeze({
    providerId: provider.identity.id,
    sandboxName: sandboxAuthority.sandboxName,
    serializedReceipt: serialized,
    receipt,
    mode,
    sandboxAuthority,
    sandboxAuthoritySha256: sandboxAuthoritySha256(sandboxAuthority),
  });
}

/** Re-prove a canonical receipt only while it remains bound to the complete sandbox row. */
export function reproveHostLocalInferenceReceipt(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  serialized: string,
  options: HostLocalInferenceLifecycleOptions = {},
): string {
  const prepared = prepareHostLocalInferenceAuthority(provider, sandbox, serialized, options);
  if (!prepared) fail("receipt uses the dedicated llama.cpp lifecycle");
  return prepared.serializedReceipt;
}

export function prepareHostLocalInferenceAuthority(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  serialized: string,
  options: HostLocalInferenceLifecycleOptions = {},
): PreparedHostLocalInferenceAuthority | null {
  return prepare(provider, sandbox, serialized, "preserve", options);
}

export function prepareSandboxHostLocalInferenceAuthority(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  options: HostLocalInferenceLifecycleOptions = {},
): PreparedHostLocalInferenceAuthority | null {
  const serialized = sandbox.hostLocalInferenceReceipt;
  return typeof serialized === "string"
    ? prepareHostLocalInferenceAuthority(provider, sandbox, serialized, options)
    : null;
}

export function prepareSandboxHostLocalInferenceDestroyAuthority(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  options: HostLocalInferenceLifecycleOptions = {},
): PreparedHostLocalInferenceAuthority | null {
  const serialized = sandbox.hostLocalInferenceReceipt;
  return typeof serialized === "string"
    ? prepare(provider, sandbox, serialized, "destroy", options)
    : null;
}

function requireCurrentSandboxAuthority(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  prepared: PreparedHostLocalInferenceAuthority,
  mode: PreparedHostLocalInferenceAuthority["mode"],
): void {
  if (prepared.mode !== mode || prepared.providerId !== provider.identity.id) {
    fail("prepared authority has a different lifecycle intent or provider");
  }
  const receipt = parseManagedReceipt(prepared.serializedReceipt, sandbox);
  if (!receipt) fail("prepared receipt no longer has a managed lifecycle");
  const current = captureSandboxAuthority(provider, sandbox, prepared.serializedReceipt, receipt);
  if (
    JSON.stringify(current) !== JSON.stringify(prepared.sandboxAuthority) ||
    sandboxAuthoritySha256(current) !== prepared.sandboxAuthoritySha256
  ) {
    fail("sandbox authority changed after lifecycle preparation");
  }
}

export function confirmHostLocalInferenceAuthority(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  prepared: PreparedHostLocalInferenceAuthority,
  options: HostLocalInferenceLifecycleOptions = {},
): void {
  requireCurrentSandboxAuthority(provider, sandbox, prepared, "preserve");
  const receipt = parseManagedReceipt(prepared.serializedReceipt, sandbox);
  if (!receipt) fail("prepared receipt no longer has a managed lifecycle");
  const runtime = requireRuntime(provider, receipt, sandbox, options);
  requireExactReceipt(
    prepared.serializedReceipt,
    runtime.preserveForRebuild(receipt),
    "provider authority changed during lifecycle confirmation",
  );
}

function currentHostLocalInferenceRuntime(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  prepared: PreparedHostLocalInferenceAuthority,
  options: HostLocalInferenceLifecycleOptions,
): {
  readonly receipt: ManagedHostLocalInferenceReceipt;
  readonly runtime: HostLocalInferenceRuntime;
} {
  requireCurrentSandboxAuthority(provider, sandbox, prepared, "destroy");
  const receipt = parseManagedReceipt(prepared.serializedReceipt, sandbox);
  if (!receipt) fail("prepared receipt no longer has a managed lifecycle");
  const runtime = requireRuntime(provider, receipt, sandbox, options);
  return { receipt, runtime };
}

function confirmHostLocalInferenceDestroyAuthority(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  prepared: PreparedHostLocalInferenceAuthority,
  options: HostLocalInferenceLifecycleOptions,
): HostLocalInferenceRuntime {
  const { receipt, runtime } = currentHostLocalInferenceRuntime(
    provider,
    sandbox,
    prepared,
    options,
  );
  requireExactReceipt(
    prepared.serializedReceipt,
    runtime.prepareDestroy(receipt),
    "provider authority changed before destroy mutation",
  );
  return runtime;
}

/** Require the prepared exact managed runtime to remain present, whether running or stopped. */
export function assertPreparedHostLocalInferenceRuntimePresent(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  prepared: PreparedHostLocalInferenceAuthority,
  options: HostLocalInferenceLifecycleOptions = {},
): void {
  const { receipt, runtime } = currentHostLocalInferenceRuntime(
    provider,
    sandbox,
    prepared,
    options,
  );
  runtime.inspectManaged(receipt);
}

function sameImmutableRuntimeAuthority(
  left: HostLocalInferenceReceipt,
  right: HostLocalInferenceReceipt,
): boolean {
  if (
    left.providerId !== right.providerId ||
    left.service !== right.service ||
    left.engineAuthority.engineId !== right.engineAuthority.engineId ||
    left.engineAuthority.authorityId !== right.engineAuthority.authorityId ||
    left.runtime.kind !== right.runtime.kind
  ) {
    return false;
  }
  if (left.runtime.kind === "container" && right.runtime.kind === "container") {
    return left.runtime.runtimeId === right.runtime.runtimeId;
  }
  return (
    left.runtime.kind === "host" &&
    right.runtime.kind === "host" &&
    left.endpoint.host === right.endpoint.host &&
    left.endpoint.port === right.endpoint.port
  );
}

function sharedPeerStatus(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  prepared: PreparedHostLocalInferenceAuthority,
  peers: readonly HostLocalInferenceLifecycleSandbox[],
): "exclusive" | "shared" {
  const names = new Set<string>();
  const preparedReceipt = parseManagedReceipt(prepared.serializedReceipt, sandbox);
  if (!preparedReceipt) fail("prepared receipt no longer has a managed lifecycle");
  let targetCount = 0;
  let shared = false;
  for (const peer of peers) {
    const peerName = exactText(peer.name, "peer sandbox name");
    if (names.has(peerName)) fail("peer registry contains duplicate sandbox identities");
    names.add(peerName);
    if (peerName === sandbox.name) {
      targetCount += 1;
      const current = captureSandboxAuthority(
        provider,
        peer,
        prepared.serializedReceipt,
        preparedReceipt,
      );
      if (
        JSON.stringify(current) !== JSON.stringify(prepared.sandboxAuthority) ||
        sandboxAuthoritySha256(current) !== prepared.sandboxAuthoritySha256
      ) {
        fail("peer registry contains a different target sandbox authority");
      }
      continue;
    }
    if (typeof peer.hostLocalInferenceReceipt !== "string") continue;
    let peerReceipt: HostLocalInferenceReceipt;
    try {
      peerReceipt = parseHostLocalInferenceReceipt(peer.hostLocalInferenceReceipt);
    } catch {
      fail("peer runtime ownership is malformed or indeterminate");
    }
    if (!sameImmutableRuntimeAuthority(prepared.receipt, peerReceipt)) continue;
    if (peer.hostLocalInferenceReceipt !== prepared.serializedReceipt) {
      fail("the same immutable provider runtime has conflicting registry authority");
    }
    const managedPeerReceipt = parseManagedReceipt(peer.hostLocalInferenceReceipt, peer);
    if (!managedPeerReceipt) fail("peer runtime ownership is malformed or indeterminate");
    const peerAuthority = captureSandboxAuthority(
      provider,
      peer,
      peer.hostLocalInferenceReceipt,
      managedPeerReceipt,
    );
    if (
      prepared.receipt.service === "llama-cpp" &&
      (peerAuthority.model !== prepared.sandboxAuthority.model ||
        peerAuthority.gatewayName !== prepared.sandboxAuthority.gatewayName ||
        peerAuthority.gatewayPort !== prepared.sandboxAuthority.gatewayPort ||
        peerAuthority.endpointSource !== prepared.sandboxAuthority.endpointSource ||
        peerAuthority.credentialEnv !== prepared.sandboxAuthority.credentialEnv ||
        peerAuthority.preferredInferenceApi !== prepared.sandboxAuthority.preferredInferenceApi ||
        JSON.stringify(peerAuthority.hostLocalInferenceProvenance) !==
          JSON.stringify(prepared.sandboxAuthority.hostLocalInferenceProvenance))
    ) {
      fail("the same llama.cpp runtime has conflicting gateway, route, or provenance authority");
    }
    shared = true;
  }
  if (targetCount !== 1) {
    fail("peer registry does not contain exactly one target sandbox authority");
  }
  return shared ? "shared" : "exclusive";
}

/** Bind the exact registry owners that decide whether one runtime can be removed. */
export function inspectPreparedHostLocalInferenceSharingAuthority(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  prepared: PreparedHostLocalInferenceAuthority,
  peers: readonly HostLocalInferenceLifecycleSandbox[],
): HostLocalInferenceSharingAuthority {
  const disposition = sharedPeerStatus(provider, sandbox, prepared, peers);
  const authorities = peers
    .filter(
      (peer) =>
        peer.name === sandbox.name || peer.hostLocalInferenceReceipt === prepared.serializedReceipt,
    )
    .map((peer) => {
      const serialized =
        peer.name === sandbox.name ? prepared.serializedReceipt : peer.hostLocalInferenceReceipt;
      if (typeof serialized !== "string") {
        fail("shared peer receipt disappeared while binding ownership");
      }
      const receipt = parseManagedReceipt(serialized, peer);
      if (!receipt) fail("shared peer receipt no longer has a managed lifecycle");
      return captureSandboxAuthority(provider, peer, serialized, receipt);
    })
    .sort((left, right) => compareCodeUnits(left.sandboxName, right.sandboxName));
  return Object.freeze({
    disposition,
    sha256: createHash("sha256").update(JSON.stringify(authorities), "utf8").digest("hex"),
  });
}

/**
 * Retire one exact managed runtime after the caller has confirmed sandbox
 * deletion. The durable row remains the retry journal until this returns.
 */
export function retirePreparedHostLocalInferenceAuthority(
  provider: RuntimeProviderBundle,
  sandbox: HostLocalInferenceLifecycleSandbox,
  prepared: PreparedHostLocalInferenceAuthority,
  peers: readonly HostLocalInferenceLifecycleSandbox[],
  options: HostLocalInferenceLifecycleOptions = {},
): HostLocalInferenceRetirementResult {
  const runtime = confirmHostLocalInferenceDestroyAuthority(provider, sandbox, prepared, options);
  if (sharedPeerStatus(provider, sandbox, prepared, peers) === "shared") {
    return Object.freeze({ status: "shared" as const, receipt: prepared.receipt });
  }
  const result = runtime.destroy(prepared.receipt);
  requireExactReceipt(
    prepared.serializedReceipt,
    result.receipt,
    "destroy returned different runtime authority",
  );
  if (
    (prepared.receipt.runtime.kind === "host" &&
      (result.status !== "retained" || result.reason !== "host-process")) ||
    (prepared.receipt.runtime.kind === "container" && result.status === "retained")
  ) {
    fail("destroy returned a result incompatible with exact runtime ownership");
  }
  return result;
}
