// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
  NVIDIA_HOSTED_CREDENTIAL_ENV,
} from "../native-nvidia/contract";
import { hostedNativeProvider } from "./hosted";
import { hostedNativeProviderForAttachment } from "./hosted-attachment";
import type { NativeProviderAttachment, NativeProviderDefinition } from "./contract";

const nvidiaDefinition: NativeProviderDefinition = {
  logicalProvider: NVIDIA_HOSTED_LOGICAL_PROVIDER,
  label: "NVIDIA",
  profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
  credentialEnv: NVIDIA_HOSTED_CREDENTIAL_ENV,
};

export function fixedNativeProvider(
  provider: string | null | undefined,
): NativeProviderDefinition | undefined {
  return provider?.trim() === NVIDIA_HOSTED_LOGICAL_PROVIDER
    ? nvidiaDefinition
    : hostedNativeProvider(provider);
}

export function fixedNativeProviderForAttachment(
  receipt: NativeProviderAttachment,
): NativeProviderDefinition {
  const definition =
    receipt.profileId === nvidiaDefinition.profileId &&
    receipt.providerName === nvidiaDefinition.providerName
      ? nvidiaDefinition
      : hostedNativeProviderForAttachment(receipt);
  if (!definition) throw new Error("Invalid fixed native provider attachment");
  return definition;
}
