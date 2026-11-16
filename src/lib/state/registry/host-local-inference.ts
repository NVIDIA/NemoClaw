// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  type HostLocalInferenceReceipt,
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "../../onboard/runtime-provider/host-local-inference";
import { HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL } from "../../onboard/runtime-provider/host-local-inference-routing";
import type { SandboxHostLocalInferenceProvenance } from "./types";
import { gatewayReachableCompatibleEndpointUrl } from "../../inference/native-local/eligibility";
import { qualifiedNativeLocalEndpointUrl } from "../../inference/native-local/agent-config";
import { OLLAMA_PROXY_PORT } from "../../core/ollama-proxy-port";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Bind a published application route to the exact host endpoint in its receipt. */
export function nativeLocalAttachmentMatchesHostLocalReceipt(
  applicationEndpointUrl: string | null | undefined,
  attachmentEndpointUrl: string,
  serializedReceipt: string | null | undefined,
): boolean {
  if (applicationEndpointUrl !== HOST_LOCAL_INFERENCE_APPLICATION_BASE_URL || !serializedReceipt)
    return false;
  try {
    const receipt = parseHostLocalInferenceReceipt(serializedReceipt);
    return (
      attachmentEndpointUrl ===
      `http://${receipt.endpoint.host}:${String(receipt.endpoint.port)}/v1`
    );
  } catch {
    return false;
  }
}

/**
 * Return the token-protected proxy route a no-authentication loopback selection is attached to.
 * Onboarding fronts that endpoint with the proxy, so the sandbox-facing URL names the proxy port
 * instead of the backend port the user entered. Only a loopback selection the gateway bridge maps
 * to the host alias can be fronted this way.
 */
function noAuthProxyAttachmentEndpointUrl(
  provider: string,
  selectedEndpointUrl: string | null | undefined,
  credentialEnv: string | null | undefined,
): string | null {
  if (
    provider !== "compatible-endpoint" ||
    credentialEnv !== OLLAMA_LOCAL_CREDENTIAL_ENV ||
    !selectedEndpointUrl
  )
    return null;
  const bridged = gatewayReachableCompatibleEndpointUrl(provider, selectedEndpointUrl);
  if (!bridged || bridged === selectedEndpointUrl) return null;
  try {
    const { hostname, pathname } = new URL(bridged);
    if (hostname !== "host.openshell.internal") return null;
    return qualifiedNativeLocalEndpointUrl(
      `http://host.openshell.internal:${String(OLLAMA_PROXY_PORT)}${pathname}`,
    );
  } catch {
    return null;
  }
}

/**
 * Match a normalized native attachment to its selected route using the existing endpoint owners.
 * Pass the selection's recorded credential so a no-authentication route is matched to its proxy.
 */
export function nativeLocalAttachmentMatchesSelectedEndpoint(
  provider: string,
  selectedEndpointUrl: string | null | undefined,
  attachmentEndpointUrl: string,
  serializedReceipt: string | null | undefined,
  credentialEnv?: string | null,
): boolean {
  const gatewayEndpoint = gatewayReachableCompatibleEndpointUrl(provider, selectedEndpointUrl);
  return (
    attachmentEndpointUrl === qualifiedNativeLocalEndpointUrl(gatewayEndpoint ?? "") ||
    attachmentEndpointUrl ===
      noAuthProxyAttachmentEndpointUrl(provider, selectedEndpointUrl, credentialEnv) ||
    nativeLocalAttachmentMatchesHostLocalReceipt(
      selectedEndpointUrl,
      attachmentEndpointUrl,
      serializedReceipt,
    )
  );
}

function receiptTransactionId(receipt: HostLocalInferenceReceipt): string | null {
  if (receipt.schemaVersion === 2) return receipt.publication?.transactionId ?? null;
  return receipt.runtime.kind === "container" ? (receipt.runtime.model?.generation ?? null) : null;
}

/**
 * Clone a canonical, secret-free provider-neutral receipt. The state boundary
 * validates the complete schema before accepting durable authority.
 */
export function cloneSandboxHostLocalInferenceReceipt(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  try {
    return serializeHostLocalInferenceReceipt(parseHostLocalInferenceReceipt(value));
  } catch {
    return undefined;
  }
}

/** Clone and strictly validate the private durable lifecycle discriminator. */
export function cloneSandboxHostLocalInferenceProvenance(
  value: unknown,
): SandboxHostLocalInferenceProvenance | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      ["origin", "receiptSha256", "runtimeOwnerSandboxName", "schemaVersion", "transactionId"].join(
        ",",
      ) ||
    record.schemaVersion !== 1 ||
    record.origin !== "startup-selection" ||
    typeof record.runtimeOwnerSandboxName !== "string" ||
    !SAFE_SANDBOX_NAME.test(record.runtimeOwnerSandboxName) ||
    typeof record.transactionId !== "string" ||
    !SHA256.test(record.transactionId) ||
    typeof record.receiptSha256 !== "string" ||
    !SHA256.test(record.receiptSha256)
  ) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    origin: "startup-selection" as const,
    runtimeOwnerSandboxName: record.runtimeOwnerSandboxName,
    transactionId: record.transactionId,
    receiptSha256: record.receiptSha256,
  });
}

/** Build provenance only at the operation-scoped startup-selection boundary. */
export function createSandboxHostLocalInferenceProvenance(
  runtimeOwnerSandboxName: string,
  serializedReceipt: string,
): SandboxHostLocalInferenceProvenance {
  const receipt = parseHostLocalInferenceReceipt(serializedReceipt);
  const transactionId = receiptTransactionId(receipt);
  if (!transactionId || !SHA256.test(transactionId)) {
    throw new Error("Host-local inference receipt has no durable create transaction");
  }
  const provenance = cloneSandboxHostLocalInferenceProvenance({
    schemaVersion: 1,
    origin: "startup-selection",
    runtimeOwnerSandboxName,
    transactionId,
    receiptSha256: createHash("sha256").update(serializedReceipt).digest("hex"),
  });
  if (!provenance) throw new Error("Host-local inference lifecycle provenance is malformed");
  return provenance;
}

/** Require a provenance record to remain paired with the exact receipt bytes and transaction. */
export function requireSandboxHostLocalInferenceProvenance(
  value: unknown,
  serializedReceipt: string,
): SandboxHostLocalInferenceProvenance {
  const provenance = cloneSandboxHostLocalInferenceProvenance(value);
  const receipt = parseHostLocalInferenceReceipt(serializedReceipt);
  if (
    !provenance ||
    provenance.receiptSha256 !== createHash("sha256").update(serializedReceipt).digest("hex") ||
    provenance.transactionId !== receiptTransactionId(receipt)
  ) {
    throw new Error("Host-local inference lifecycle provenance does not match its receipt");
  }
  return provenance;
}
