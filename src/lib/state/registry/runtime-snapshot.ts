// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderRuntimeReceipt } from "../../onboard/runtime-provider/contract";
import { normalizeRuntimeProviderRuntimeReceipt } from "../../onboard/runtime-provider/registry";

export const SANDBOX_RUNTIME_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type SandboxRuntimeLifecycleState = "running" | "paused" | "stopped";

/**
 * Provider-neutral runtime state persisted beside a filesystem snapshot.
 *
 * `providerHandle` and `runtime.handle` remain opaque to the state and action
 * layers. Only the owning provider may interpret either value.
 */
export interface SandboxRuntimeSnapshot {
  readonly schemaVersion: typeof SANDBOX_RUNTIME_SNAPSHOT_SCHEMA_VERSION;
  readonly providerId: string;
  readonly providerHandle: string;
  readonly lifecycleState: SandboxRuntimeLifecycleState;
  readonly lifecycleGeneration: string;
  readonly runtime: RuntimeProviderRuntimeReceipt;
}

const LIFECYCLE_STATES = new Set<SandboxRuntimeLifecycleState>(["running", "paused", "stopped"]);
const MAX_PROVIDER_HANDLE_BYTES = 4096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validProviderHandle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    Buffer.byteLength(value, "utf8") <= MAX_PROVIDER_HANDLE_BYTES &&
    !CONTROL_CHARACTERS.test(value)
  );
}

/**
 * Validate and deeply clone an untrusted persisted runtime snapshot.
 * Unknown keys are deliberately dropped, while the nested runtime receipt is
 * normalized by the sole runtime-provider receipt boundary.
 */
export function cloneSandboxRuntimeSnapshot(value: unknown): SandboxRuntimeSnapshot | undefined {
  if (
    !isPlainRecord(value) ||
    value.schemaVersion !== SANDBOX_RUNTIME_SNAPSHOT_SCHEMA_VERSION ||
    typeof value.providerId !== "string" ||
    !validProviderHandle(value.providerHandle) ||
    typeof value.lifecycleState !== "string" ||
    !LIFECYCLE_STATES.has(value.lifecycleState as SandboxRuntimeLifecycleState) ||
    !validProviderHandle(value.lifecycleGeneration)
  ) {
    return undefined;
  }
  const runtime = normalizeRuntimeProviderRuntimeReceipt(value.runtime);
  if (!runtime || runtime.providerId !== value.providerId) return undefined;
  return {
    schemaVersion: SANDBOX_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    providerId: value.providerId,
    providerHandle: value.providerHandle,
    lifecycleState: value.lifecycleState as SandboxRuntimeLifecycleState,
    lifecycleGeneration: value.lifecycleGeneration,
    runtime,
  };
}
