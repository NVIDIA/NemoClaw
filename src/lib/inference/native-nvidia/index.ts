// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import {
  NativeProviderError as NativeNvidiaProviderError,
  ensureNativeProvider,
  persistNativeProviderAuthority,
  verifyNativeProviderAttachment,
  ensureNativeProviderAttached,
  detachNativeProvider,
  type NativeProviderAttachment,
} from "../native-provider/lifecycle";

import { REPOSITORY_ROOT } from "../../core/repository-root";
import {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  normalizeNativeNvidiaProviderAttachment,
  type NativeNvidiaProviderAttachment,
} from "./contract";

export {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  normalizeNativeNvidiaProviderAttachment,
  type NativeNvidiaProviderAttachment,
} from "./contract";

export { NativeProviderError as NativeNvidiaProviderError } from "../native-provider/lifecycle";

export function nativeNvidiaProviderProfilePath(root = REPOSITORY_ROOT): string {
  return path.join(
    root,
    "managed-inference",
    "provider-profiles",
    `${NVIDIA_HOSTED_NATIVE_PROFILE_ID}.yaml`,
  );
}

export function isNativeNvidiaProvider(provider: string | null | undefined): boolean {
  return provider?.trim() === NVIDIA_HOSTED_LOGICAL_PROVIDER;
}

export function resolveGatewayNativeNvidiaProviderAuthority(input: {
  gatewayName: string;
  gatewayAuthority?: NativeNvidiaProviderAttachment | null;
  recordedAttachment?: NativeNvidiaProviderAttachment | null;
}): NativeNvidiaProviderAttachment | undefined {
  const authorities = new Map<string, NativeNvidiaProviderAttachment>();
  for (const receipt of [input.gatewayAuthority, input.recordedAttachment]) {
    if (receipt) authorities.set(receipt.providerId, receipt);
  }
  if (authorities.size > 1) {
    throw new NativeNvidiaProviderError(
      `Gateway '${input.gatewayName}' has conflicting native NVIDIA provider ownership receipts. No provider was changed.`,
    );
  }
  return authorities.values().next().value;
}

export function nativeInferenceProviderForSandbox(
  provider: string | null | undefined,
): string | null {
  const normalized = provider?.trim() || null;
  return isNativeNvidiaProvider(normalized) ? NVIDIA_HOSTED_NATIVE_PROVIDER : normalized;
}

async function requireNativeNvidiaProviderProfileBoundary(
  input: Parameters<typeof verifyNativeProviderAttachment>[0],
): Promise<void> {
  const result = await input.adapter.importProviderProfile({
    target: input.target,
    profilePath: nativeNvidiaProviderProfilePath(),
  });
  if (result.ok) return;
  throw new NativeNvidiaProviderError(
    result.error.kind === "command" && result.error.reason === "profile_incompatible"
      ? `OpenShell provider profile '${NVIDIA_HOSTED_NATIVE_PROFILE_ID}' conflicts with NemoClaw's checked-in security boundary. No provider was changed.`
      : `Could not verify OpenShell provider profile '${NVIDIA_HOSTED_NATIVE_PROFILE_ID}': ${result.error.message}`,
  );
}

function nativeProfile(profilePath = nativeNvidiaProviderProfilePath()) {
  return {
    profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
    providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
    credentialEnv: NVIDIA_HOSTED_CREDENTIAL_ENV,
    label: "NVIDIA",
    profilePath,
  };
}
function nvidiaReceipt(receipt: NativeProviderAttachment): NativeNvidiaProviderAttachment {
  const normalized = normalizeNativeNvidiaProviderAttachment(receipt);
  if (!normalized)
    throw new NativeNvidiaProviderError("OpenShell returned an invalid NVIDIA provider identity.");
  return normalized;
}
export async function ensureNativeNvidiaProvider(
  input: Omit<Parameters<typeof ensureNativeProvider>[0], "profile" | "expected"> & {
    expected?: NativeNvidiaProviderAttachment;
  },
): Promise<NativeNvidiaProviderAttachment> {
  return nvidiaReceipt(
    await ensureNativeProvider({ ...input, profile: nativeProfile(input.profilePath) }),
  );
}
export async function verifyNativeNvidiaProviderAttachment(
  input: Omit<Parameters<typeof verifyNativeProviderAttachment>[0], "profile" | "expected"> & {
    expected?: NativeNvidiaProviderAttachment;
  },
): Promise<NativeNvidiaProviderAttachment> {
  await requireNativeNvidiaProviderProfileBoundary({ ...input, profile: nativeProfile() });
  return nvidiaReceipt(
    await verifyNativeProviderAttachment({ ...input, profile: nativeProfile() }),
  );
}
export async function ensureNativeNvidiaProviderAttached(
  input: Omit<Parameters<typeof ensureNativeProviderAttached>[0], "profile" | "expected"> & {
    expected: NativeNvidiaProviderAttachment;
  },
): Promise<{ receipt: NativeNvidiaProviderAttachment; changed: boolean }> {
  await requireNativeNvidiaProviderProfileBoundary({ ...input, profile: nativeProfile() });
  const result = await ensureNativeProviderAttached({ ...input, profile: nativeProfile() });
  return { ...result, receipt: nvidiaReceipt(result.receipt) };
}
export async function detachNativeNvidiaProvider(
  input: Omit<Parameters<typeof detachNativeProvider>[0], "profile" | "expected"> & {
    expected: NativeNvidiaProviderAttachment;
  },
): Promise<void> {
  return detachNativeProvider({ ...input, profile: nativeProfile() });
}

/** Persist before attaching; failed writes must not strand an unowned provider. */
export async function persistNativeNvidiaProviderAuthority(
  input: Omit<
    Parameters<typeof persistNativeProviderAuthority>[0],
    "profile" | "recoveryGuidance" | "receipt" | "existing" | "readAuthority" | "writeAuthority"
  > & {
    receipt: NativeNvidiaProviderAttachment;
    existing?: NativeNvidiaProviderAttachment;
    readAuthority: (gatewayName: string) => NativeNvidiaProviderAttachment | undefined;
    writeAuthority: (gatewayName: string, receipt: NativeNvidiaProviderAttachment) => void;
  },
): Promise<void> {
  return persistNativeProviderAuthority({
    ...input,
    profile: nativeProfile(),
    recoveryGuidance: `Run 'nemoclaw credentials reset ${NVIDIA_HOSTED_LOGICAL_PROVIDER} --yes' against gateway '${input.gatewayName}', then retry.`,
    writeAuthority: (gatewayName, receipt) =>
      input.writeAuthority(gatewayName, nvidiaReceipt(receipt)),
  });
}
