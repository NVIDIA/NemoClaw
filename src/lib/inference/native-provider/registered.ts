// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../../adapters/openshell/provider-adapter";
import type { InferenceProviderProfileProjection } from "../../adapters/openshell/provider-profile";
import { unsafeEndpointUrlViolation } from "../../core/endpoint-url-safety";

export type RegisteredInferenceApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

/** Selection of an operator provider grants no ownership of that provider. */
export type RegisteredInferenceProviderAttachment = Readonly<{
  schemaVersion: 1;
  gatewayName: string;
  sandboxName: string;
  providerName: string;
  providerId: string;
  profileId: string;
  profileDigest: string;
  endpointUrl: string;
  inferenceApi: RegisteredInferenceApi;
  credentialEnv: string;
  /** Only an attachment made by inference selection may be removed on departure. */
  attachedBySelection: boolean;
}>;

export function registeredInferenceEndpoint(value: string): URL {
  if (unsafeEndpointUrlViolation(value))
    throw new Error("Registered inference endpoint is invalid");
  const endpoint = new URL(value);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    ["localhost", "127.0.0.1", "[::1]", "inference.local"].includes(endpoint.hostname) ||
    /%2f|%5c/iu.test(endpoint.pathname)
  )
    throw new Error("Registered inference requires its explicit native HTTP(S) endpoint");
  return endpoint;
}

export function normalizeRegisteredInferenceProviderAttachment(
  value: unknown,
): RegisteredInferenceProviderAttachment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || typeof row.attachedBySelection !== "boolean") return undefined;
  for (const key of ["gatewayName", "sandboxName", "providerName", "profileId"]) {
    if (typeof row[key] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(row[key]))
      return undefined;
  }
  if (
    typeof row.providerId !== "string" ||
    !row.providerId.trim() ||
    row.providerId.length > 256 ||
    /\s/u.test(row.providerId) ||
    typeof row.profileDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.profileDigest) ||
    typeof row.credentialEnv !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,255}$/u.test(row.credentialEnv)
  )
    return undefined;
  if (
    !["openai-completions", "openai-responses", "anthropic-messages"].includes(
      String(row.inferenceApi),
    ) ||
    typeof row.endpointUrl !== "string"
  )
    return undefined;
  try {
    registeredInferenceEndpoint(row.endpointUrl);
  } catch {
    return undefined;
  }
  return {
    schemaVersion: 1,
    gatewayName: row.gatewayName as string,
    sandboxName: row.sandboxName as string,
    providerName: row.providerName as string,
    providerId: row.providerId,
    profileId: row.profileId as string,
    profileDigest: row.profileDigest,
    endpointUrl: row.endpointUrl,
    inferenceApi: row.inferenceApi as RegisteredInferenceApi,
    credentialEnv: row.credentialEnv,
    attachedBySelection: row.attachedBySelection,
  };
}

function requireBinding(value: unknown): RegisteredInferenceProviderAttachment {
  const binding = normalizeRegisteredInferenceProviderAttachment(value);
  if (!binding) throw new Error("Registered inference provider binding is invalid");
  return binding;
}

function matchesDeclaredEndpoint(
  endpoint: URL,
  projection: InferenceProviderProfileProjection,
): boolean {
  const port = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));
  return projection.endpoints.some(
    (declared) =>
      declared.port === port &&
      (declared.host === endpoint.hostname ||
        (declared.host.startsWith("*.") &&
          endpoint.hostname.endsWith(declared.host.slice(1)) &&
          endpoint.hostname !== declared.host.slice(2))),
  );
}

function assertProjection(
  binding: RegisteredInferenceProviderAttachment,
  metadata: OpenShellProviderMetadata,
  projection: InferenceProviderProfileProjection | undefined,
): void {
  if (
    !projection ||
    projection.digest !== binding.profileDigest ||
    !matchesDeclaredEndpoint(registeredInferenceEndpoint(binding.endpointUrl), projection)
  )
    throw new Error("Registered provider profile does not match the selected inference endpoint");
  const matches = projection.credentials.filter((credential) =>
    credential.envVars.includes(binding.credentialEnv),
  );
  const expectedHeader =
    binding.inferenceApi === "anthropic-messages" ? "x-api-key" : "authorization";
  const expectedStyle = binding.inferenceApi === "anthropic-messages" ? "header" : "bearer";
  if (
    !metadata.credentialKeys.includes(binding.credentialEnv) ||
    matches.length !== 1 ||
    matches[0]!.headerName !== expectedHeader ||
    matches[0]!.authStyle !== expectedStyle
  )
    throw new Error("Registered provider credential does not match the selected inference API");
}

async function inspectBinding(
  adapter: OpenShellProviderAdapter,
  expected: RegisteredInferenceProviderAttachment,
): Promise<OpenShellProviderMetadata> {
  const target = { kind: "named", gatewayName: expected.gatewayName } as const;
  const provider = await adapter.getProvider({ target, providerName: expected.providerName });
  if (
    !provider.ok ||
    provider.value.name !== expected.providerName ||
    provider.value.type !== expected.profileId ||
    provider.value.revision?.id !== expected.providerId ||
    !Number.isSafeInteger(provider.value.revision.resourceVersion) ||
    provider.value.revision.resourceVersion < 1
  )
    throw new Error("Registered inference provider identity changed");
  const profile = await adapter.inspectProviderProfile({
    target,
    profileType: expected.profileId,
    includeInferenceProjection: true,
  });
  if (!profile.ok) throw new Error("Registered inference provider profile could not be verified");
  assertProjection(expected, provider.value, profile.value.inference);
  return provider.value;
}

export async function resolveRegisteredInferenceProvider(input: {
  adapter: OpenShellProviderAdapter;
  gatewayName: string;
  sandboxName: string;
  providerName: string;
  endpointUrl: string;
  inferenceApi: string;
  credentialEnv: string;
  previous?: RegisteredInferenceProviderAttachment;
}): Promise<RegisteredInferenceProviderAttachment> {
  const target = { kind: "named", gatewayName: input.gatewayName } as const;
  const observed = await input.adapter.getProvider({ target, providerName: input.providerName });
  if (
    !observed.ok ||
    !observed.value.revision?.id ||
    observed.value.name !== input.providerName ||
    !Number.isSafeInteger(observed.value.revision.resourceVersion) ||
    observed.value.revision.resourceVersion < 1
  )
    throw new Error("Registered inference provider identity is unavailable");
  const profile = await input.adapter.inspectProviderProfile({
    target,
    profileType: observed.value.type,
    includeInferenceProjection: true,
  });
  if (!profile.ok || !profile.value.inference)
    throw new Error("Registered provider has no declared inference profile");
  const binding = requireBinding({
    schemaVersion: 1,
    gatewayName: input.gatewayName,
    sandboxName: input.sandboxName,
    providerName: input.providerName,
    providerId: observed.value.revision.id,
    profileId: observed.value.type,
    profileDigest: profile.value.inference.digest,
    endpointUrl: input.endpointUrl,
    inferenceApi: input.inferenceApi,
    credentialEnv: input.credentialEnv,
    attachedBySelection: input.previous?.attachedBySelection ?? false,
  });
  if (
    input.previous &&
    (input.previous.providerId !== binding.providerId ||
      input.previous.profileId !== binding.profileId ||
      input.previous.profileDigest !== binding.profileDigest)
  )
    throw new Error("Recorded registered inference provider identity or profile changed");
  assertProjection(binding, observed.value, profile.value.inference);
  return binding;
}

export async function verifyRegisteredInferenceProviderAttachment(input: {
  adapter: OpenShellProviderAdapter;
  expected: RegisteredInferenceProviderAttachment;
}): Promise<void> {
  const expected = requireBinding(input.expected);
  await inspectBinding(input.adapter, expected);
  const attachments = await input.adapter.listProviderAttachments({
    target: { kind: "named", gatewayName: expected.gatewayName },
    sandboxName: expected.sandboxName,
  });
  if (!attachments.ok || !attachments.value.names.includes(expected.providerName))
    throw new Error("Registered inference provider is not attached to the selected sandbox");
}

export async function attachRegisteredInferenceProvider(input: {
  adapter: OpenShellProviderAdapter;
  expected: RegisteredInferenceProviderAttachment;
}): Promise<{ attachment: RegisteredInferenceProviderAttachment; changed: boolean }> {
  const expected = requireBinding(input.expected);
  const before = await inspectBinding(input.adapter, expected);
  const request = {
    target: { kind: "named", gatewayName: expected.gatewayName } as const,
    sandboxName: expected.sandboxName,
    providerName: expected.providerName,
  };
  const attachments = await input.adapter.listProviderAttachments(request);
  if (!attachments.ok) throw new Error("Registered provider attachments could not be inspected");
  if (attachments.value.names.includes(expected.providerName)) {
    await verifyRegisteredInferenceProviderAttachment({ ...input, expected });
    return { attachment: expected, changed: false };
  }
  const policy = await input.adapter.ensureProviderPolicyComposition(request);
  if (!policy.ok) throw new Error("Registered provider policy composition could not be verified");
  const attached = await input.adapter.attachProvider(request);
  // An uncertain runtime mutation must never become an inferred successful attachment.
  if (!attached.ok)
    throw new Error(
      `Registered provider attachment failed: ${attached.error.kind}. Inspect the sandbox attachment before retrying.`,
    );
  const attachment = { ...expected, attachedBySelection: true };
  try {
    const after = await inspectBinding(input.adapter, expected);
    if (before.revision?.resourceVersion !== after.revision?.resourceVersion)
      throw new Error("Registered provider changed during attachment");
    await verifyRegisteredInferenceProviderAttachment({ ...input, expected: attachment });
    return { attachment, changed: true };
  } catch (error) {
    await detachRegisteredInferenceProvider({ ...input, expected: attachment });
    throw error;
  }
}

/** Remove only selection-created access; the operator provider is never mutated. */
export async function detachRegisteredInferenceProvider(input: {
  adapter: OpenShellProviderAdapter;
  expected: RegisteredInferenceProviderAttachment;
}): Promise<boolean> {
  const expected = requireBinding(input.expected);
  if (!expected.attachedBySelection) return false;
  await inspectBinding(input.adapter, expected);
  const request = {
    target: { kind: "named", gatewayName: expected.gatewayName } as const,
    sandboxName: expected.sandboxName,
    providerName: expected.providerName,
  };
  const before = await input.adapter.listProviderAttachments(request);
  if (!before.ok) throw new Error("Registered provider attachments could not be inspected");
  if (!before.value.names.includes(expected.providerName)) return false;
  const detached = await input.adapter.detachProvider(request);
  if (!detached.ok) throw new Error("Registered provider attachment removal was not confirmed");
  const after = await input.adapter.listProviderAttachments(request);
  if (!after.ok || after.value.names.includes(expected.providerName))
    throw new Error("Registered provider attachment absence was not confirmed");
  return true;
}

/** A recorded selection binds one operator provider to this exact sandbox route. */
export function recordedRegisteredInferenceProviderAttachment(entry: {
  name?: string;
  gatewayName?: string | null;
  provider?: string | null;
  endpointUrl?: string | null;
  preferredInferenceApi?: string | null;
  credentialEnv?: string | null;
  registeredInferenceProviderAttachment?: unknown;
  nativeLocalProviderAttachment?: unknown;
  nativeNvidiaProviderAttachment?: unknown;
  nativeHostedProviderAttachment?: unknown;
}): RegisteredInferenceProviderAttachment | undefined {
  if (entry.registeredInferenceProviderAttachment === undefined) return undefined;
  const binding = requireBinding(entry.registeredInferenceProviderAttachment);
  if (
    entry.name !== binding.sandboxName ||
    entry.gatewayName !== binding.gatewayName ||
    entry.provider !== binding.providerName ||
    entry.endpointUrl !== binding.endpointUrl ||
    entry.preferredInferenceApi !== binding.inferenceApi ||
    entry.credentialEnv !== binding.credentialEnv ||
    entry.nativeLocalProviderAttachment !== undefined ||
    entry.nativeNvidiaProviderAttachment !== undefined ||
    entry.nativeHostedProviderAttachment !== undefined
  )
    throw new Error("Recorded registered inference selection does not match its sandbox route");
  return binding;
}

export async function registeredInferenceProviderRevision(input: {
  adapter: OpenShellProviderAdapter;
  expected: RegisteredInferenceProviderAttachment;
}): Promise<number> {
  const metadata = await inspectBinding(input.adapter, requireBinding(input.expected));
  const revision = metadata.revision?.resourceVersion;
  if (!Number.isSafeInteger(revision) || !revision || revision < 1)
    throw new Error("Registered provider revision is unavailable");
  return revision;
}
