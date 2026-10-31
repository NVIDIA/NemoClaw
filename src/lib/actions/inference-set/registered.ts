// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import {
  normalizeRegisteredInferenceProviderAttachment,
  attachRegisteredInferenceProvider,
  detachRegisteredInferenceProvider,
  verifyRegisteredInferenceProviderAttachment,
  registeredInferenceProviderRevision,
  resolveRegisteredInferenceProvider,
} from "../../inference/native-provider/registered";
import type { RegisteredInferenceProviderAttachment } from "../../inference/native-provider/registered";
import { readNativeCredentialHandle } from "../inference-set-provider";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function referencedEnvironment(value: unknown): string | undefined {
  const ref = record(value);
  if (ref.source === "env" && ref.provider === "default" && typeof ref.id === "string")
    return ref.id;
  if (typeof value !== "string") return undefined;
  return (
    /^\$\{([A-Z][A-Z0-9_]{0,255})\}$/u.exec(value)?.[1] ??
    /^openshell:resolve:env:(?:(?:v[0-9]{1,20}|s[a-f0-9]{64})_)?([A-Z][A-Z0-9_]{0,255})$/u.exec(
      value,
    )?.[1]
  );
}

function selectMetadata(
  explicit: string | null | undefined,
  configured: unknown,
  label: string,
): string {
  if (explicit && configured && explicit !== configured)
    throw new Error(`Registered provider ${label} disagrees with its native configuration`);
  const value = explicit || configured;
  if (typeof value !== "string" || !value)
    throw new Error(
      `Registered provider requires explicit ${label} metadata in its native configuration or inference set options`,
    );
  return value;
}

export async function resolveRegisteredSelection(input: {
  provider: string;
  sandboxName: string;
  gatewayName: string;
  agentName: string;
  config: Record<string, unknown>;
  endpointUrl?: string | null;
  inferenceApi?: string | null;
  credentialEnv?: string | null;
  previous?: unknown;
  adapter: OpenShellProviderAdapter;
}): Promise<RegisteredInferenceProviderAttachment> {
  const previous = normalizeRegisteredInferenceProviderAttachment(input.previous);
  if (input.previous !== undefined && !previous)
    throw new Error("Recorded registered provider binding is invalid");
  if (
    previous &&
    (previous.sandboxName !== input.sandboxName || previous.gatewayName !== input.gatewayName)
  )
    throw new Error("Recorded registered provider belongs to another sandbox or gateway");
  const models = record(input.config.models);
  const hermesCustom = Array.isArray(input.config.custom_providers)
    ? input.config.custom_providers.find((entry) => record(entry).name === input.provider)
    : undefined;
  const configured =
    input.agentName === "openclaw"
      ? record(record(models.providers)[input.provider])
      : record(record(input.config.providers)[input.provider] ?? hermesCustom);
  const retained = previous?.providerName === input.provider ? previous : undefined;
  const endpoint =
    configured.baseUrl ??
    configured.base_url ??
    (input.agentName === "hermes" ? configured.api : undefined) ??
    retained?.endpointUrl;
  const mode = configured.api_mode ?? configured.transport;
  const hermesApi =
    mode === "anthropic_messages"
      ? "anthropic-messages"
      : mode === "codex_responses"
        ? "openai-responses"
        : (mode === "chat_completions" || mode === undefined) && endpoint
          ? "openai-completions"
          : undefined;
  const api = (input.agentName === "hermes" ? hermesApi : configured.api) ?? retained?.inferenceApi;
  const headers = { ...record(configured.headers), ...record(configured.default_headers) };
  if (
    Object.keys(headers).some((key) => ["authorization", "x-api-key"].includes(key.toLowerCase()))
  )
    throw new Error(
      "Registered native configuration must use its provider credential reference instead of an authentication header override",
    );
  const key = configured.apiKey ?? configured.api_key;
  const env = referencedEnvironment(key) ?? retained?.credentialEnv;
  if (key !== undefined && !referencedEnvironment(key) && !retained)
    throw new Error(
      "Registered provider configuration must name its OpenShell credential environment variable; raw credentials are not imported",
    );
  return resolveRegisteredInferenceProvider({
    adapter: input.adapter,
    gatewayName: input.gatewayName,
    sandboxName: input.sandboxName,
    providerName: input.provider,
    endpointUrl: selectMetadata(input.endpointUrl, endpoint, "endpoint URL"),
    inferenceApi: selectMetadata(input.inferenceApi, api, "API family"),
    credentialEnv: selectMetadata(input.credentialEnv, env, "credential environment"),
    previous: retained,
  });
}

/** Read only the selected OpenShell-issued handle, never a host or raw credential. */
export async function readRegisteredInferenceCredentialHandle(
  attachment: RegisteredInferenceProviderAttachment,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<string> {
  const env = attachment.credentialEnv;
  const pattern = new RegExp(`^openshell:resolve:env:(?:v[0-9]{1,20}|s[a-f0-9]{64})_${env}$`, "u");
  return readNativeCredentialHandle(attachment.sandboxName, attachment.gatewayName, {
    script: `if [ -z "\${${env}:-}" ]; then printf "%s\\n" NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING >&2; exit 75; fi; case "$${env}" in *[!a-zA-Z0-9:_]*) exit 2;; esac; printf "%s" "$${env}" | LC_ALL=C grep -E '^openshell:resolve:env:(v[0-9]{1,20}|s[a-f0-9]{64})_${env}$'`,
    pattern,
    providerLabel: "registered inference",
    sleep,
  });
}

export {
  attachRegisteredInferenceProvider,
  detachRegisteredInferenceProvider,
  verifyRegisteredInferenceProviderAttachment,
  registeredInferenceProviderRevision,
  recordedRegisteredInferenceProviderAttachment,
  type RegisteredInferenceProviderAttachment,
} from "../../inference/native-provider/registered";

export async function readVerifiedRegisteredCredentialHandle(input: {
  attachment: RegisteredInferenceProviderAttachment;
  adapter: OpenShellProviderAdapter;
  read?: typeof readRegisteredInferenceCredentialHandle;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<string> {
  const expected = input.attachment;
  const revision = await registeredInferenceProviderRevision({ adapter: input.adapter, expected });
  const handle = await (input.read ?? readRegisteredInferenceCredentialHandle)(
    expected,
    input.sleep,
  );
  await verifyRegisteredInferenceProviderAttachment({ adapter: input.adapter, expected });
  if (
    revision !== (await registeredInferenceProviderRevision({ adapter: input.adapter, expected }))
  )
    throw new Error("Registered provider changed while reading its credential handle");
  return handle;
}

export async function detachPreviousRegisteredSelection(input: {
  adapter: OpenShellProviderAdapter;
  previous?: RegisteredInferenceProviderAttachment;
  next?: RegisteredInferenceProviderAttachment;
}): Promise<boolean> {
  if (!input.previous || input.previous.providerId === input.next?.providerId) return false;
  return detachRegisteredInferenceProvider({ adapter: input.adapter, expected: input.previous });
}

export async function rollbackRegisteredSelection(input: {
  adapter: OpenShellProviderAdapter;
  committed: boolean;
  attachment?: RegisteredInferenceProviderAttachment;
  changed: boolean;
}): Promise<void> {
  if (input.committed) return;
  if (input.changed && input.attachment)
    await detachRegisteredInferenceProvider({ adapter: input.adapter, expected: input.attachment });
}

export async function restorePreviousRegisteredSelection(input: {
  adapter: OpenShellProviderAdapter;
  committed: boolean;
  previous?: RegisteredInferenceProviderAttachment;
  previousDetached: boolean;
  cleanupError: unknown;
  originalError: unknown;
}): Promise<void> {
  if (input.committed || !input.previousDetached || !input.previous) return;
  // A failed cleanup cannot establish that its credential environment is free.
  if (input.cleanupError !== input.originalError) throw input.cleanupError;
  await attachRegisteredInferenceProvider({ adapter: input.adapter, expected: input.previous });
}

/** Capture only the selected operator model; prior model limits are not defaults. */
export function registeredOpenclawModelConfiguration(
  config: Record<string, unknown>,
  binding: RegisteredInferenceProviderAttachment,
  model: string,
): { model: Record<string, unknown>; compatibility: Record<string, unknown> | null } {
  const selected = record(record(record(config.models).providers)[binding.providerName]);
  if (selected.baseUrl !== binding.endpointUrl || selected.api !== binding.inferenceApi)
    throw new Error(
      "Selected registered OpenClaw configuration does not match its recorded provider binding.",
    );
  const models = Array.isArray(selected.models) ? selected.models : [];
  const entry = record(models.find((value) => record(value).id === model));
  const compatibility =
    entry.compat && typeof entry.compat === "object" && !Array.isArray(entry.compat)
      ? record(entry.compat)
      : null;
  return { model: entry, compatibility };
}
