// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../state/registry/types";
import type { RuntimeProviderBundle } from "./contract";
import {
  type HostLocalInferenceDestroyResult,
  type HostLocalInferenceReceipt,
  type HostLocalInferenceRuntime,
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "./host-local-inference";

export interface PreparedHostLocalInferenceAuthority {
  readonly providerId: string;
  readonly sandboxName: string;
  readonly serializedReceipt: string;
  readonly receipt: HostLocalInferenceReceipt;
}

export type HostLocalInferenceRetirementResult =
  | HostLocalInferenceDestroyResult
  | {
      readonly status: "shared";
      readonly receipt: HostLocalInferenceReceipt;
    };

function requireRuntime(
  provider: RuntimeProviderBundle,
  receipt: HostLocalInferenceReceipt,
): HostLocalInferenceRuntime {
  const surface = provider.hostLocalInference;
  if (!surface.supported) {
    throw new Error(
      `Runtime provider '${provider.identity.id}' does not support host-local inference.`,
    );
  }
  if (
    surface.providerId !== provider.identity.id ||
    surface.runtime.providerId !== provider.identity.id ||
    receipt.providerId !== provider.identity.id
  ) {
    throw new Error("Host-local inference receipt belongs to a different runtime provider.");
  }
  if (!surface.runtime.services.includes(receipt.service)) {
    throw new Error(
      `Runtime provider '${provider.identity.id}' does not support host-local ${receipt.service}.`,
    );
  }
  return surface.runtime;
}

/** Re-prove an exact durable route through its owning provider. */
export function reproveHostLocalInferenceReceipt(
  provider: RuntimeProviderBundle,
  serialized: string,
): string {
  const receipt = parseHostLocalInferenceReceipt(serialized);
  const runtime = requireRuntime(provider, receipt);
  const reproved = serializeHostLocalInferenceReceipt(runtime.preserveForRebuild(receipt));
  if (reproved !== serialized) {
    throw new Error("Host-local inference authority changed while it was being preserved.");
  }
  return reproved;
}

export function prepareHostLocalInferenceAuthority(
  provider: RuntimeProviderBundle,
  sandbox: Pick<SandboxEntry, "hostLocalInferenceReceipt" | "name">,
  serialized: string,
): PreparedHostLocalInferenceAuthority {
  if (sandbox.hostLocalInferenceReceipt !== serialized) {
    throw new Error(`target '${sandbox.name}' has different host-local inference authority`);
  }
  reproveHostLocalInferenceReceipt(provider, serialized);
  return Object.freeze({
    providerId: provider.identity.id,
    sandboxName: sandbox.name,
    serializedReceipt: serialized,
    receipt: parseHostLocalInferenceReceipt(serialized),
  });
}

export function prepareSandboxHostLocalInferenceAuthority(
  provider: RuntimeProviderBundle,
  sandbox: Pick<SandboxEntry, "hostLocalInferenceReceipt" | "name">,
): PreparedHostLocalInferenceAuthority | null {
  return typeof sandbox.hostLocalInferenceReceipt === "string"
    ? prepareHostLocalInferenceAuthority(provider, sandbox, sandbox.hostLocalInferenceReceipt)
    : null;
}

export function prepareSandboxHostLocalInferenceDestroyAuthority(
  provider: RuntimeProviderBundle,
  sandbox: Pick<SandboxEntry, "hostLocalInferenceReceipt" | "name">,
): PreparedHostLocalInferenceAuthority | null {
  const serialized = sandbox.hostLocalInferenceReceipt;
  if (typeof serialized !== "string") return null;
  const receipt = parseHostLocalInferenceReceipt(serialized);
  const runtime = requireRuntime(provider, receipt);
  if (serializeHostLocalInferenceReceipt(runtime.prepareDestroy(receipt)) !== serialized) {
    throw new Error("Host-local inference authority changed during destroy preflight.");
  }
  return Object.freeze({
    providerId: provider.identity.id,
    sandboxName: sandbox.name,
    serializedReceipt: serialized,
    receipt,
  });
}

export function confirmHostLocalInferenceAuthority(
  provider: RuntimeProviderBundle,
  sandbox: Pick<SandboxEntry, "hostLocalInferenceReceipt" | "name">,
  prepared: PreparedHostLocalInferenceAuthority,
): void {
  if (provider.identity.id !== prepared.providerId || sandbox.name !== prepared.sandboxName) {
    throw new Error("Host-local inference restore target changed runtime identity.");
  }
  prepareHostLocalInferenceAuthority(provider, sandbox, prepared.serializedReceipt);
}

function confirmHostLocalInferenceDestroyAuthority(
  provider: RuntimeProviderBundle,
  sandbox: Pick<SandboxEntry, "hostLocalInferenceReceipt" | "name">,
  prepared: PreparedHostLocalInferenceAuthority,
): void {
  if (
    provider.identity.id !== prepared.providerId ||
    sandbox.name !== prepared.sandboxName ||
    sandbox.hostLocalInferenceReceipt !== prepared.serializedReceipt
  ) {
    throw new Error("Host-local inference destroy target changed runtime identity.");
  }
  const runtime = requireRuntime(provider, prepared.receipt);
  if (
    serializeHostLocalInferenceReceipt(runtime.prepareDestroy(prepared.receipt)) !==
    prepared.serializedReceipt
  ) {
    throw new Error("Host-local inference authority changed before destroy mutation.");
  }
}

/**
 * Retire an exact managed runtime only after the caller has confirmed sandbox
 * deletion. Shared receipts remain live for their peer sandboxes, and host
 * Ollama is always retained because NemoClaw does not own that process.
 */
export function retirePreparedHostLocalInferenceAuthority(
  provider: RuntimeProviderBundle,
  sandbox: Pick<SandboxEntry, "hostLocalInferenceReceipt" | "name">,
  prepared: PreparedHostLocalInferenceAuthority,
  peers: readonly Pick<SandboxEntry, "hostLocalInferenceReceipt" | "name">[],
): HostLocalInferenceRetirementResult {
  confirmHostLocalInferenceDestroyAuthority(provider, sandbox, prepared);
  if (
    peers.some(
      (peer) =>
        peer.name !== sandbox.name && peer.hostLocalInferenceReceipt === prepared.serializedReceipt,
    )
  ) {
    return Object.freeze({ status: "shared" as const, receipt: prepared.receipt });
  }
  const runtime = requireRuntime(provider, prepared.receipt);
  const result = runtime.destroy(prepared.receipt);
  if (serializeHostLocalInferenceReceipt(result.receipt) !== prepared.serializedReceipt) {
    throw new Error("Host-local inference destroy returned different runtime authority.");
  }
  return result;
}
