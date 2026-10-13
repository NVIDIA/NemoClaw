// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { nativeProviderLifecycle, NativeProviderError } from "../native-provider";
import {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
} from "./contract";

export * from "./contract";
export { NativeProviderError as NativeNvidiaProviderError };

const lifecycle = nativeProviderLifecycle({
  logicalProvider: NVIDIA_HOSTED_LOGICAL_PROVIDER,
  label: "NVIDIA",
  profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
  credentialEnv: NVIDIA_HOSTED_CREDENTIAL_ENV,
});

export const nativeNvidiaProviderProfilePath = lifecycle.nativeProviderProfilePath.bind(lifecycle);
export const isNativeNvidiaProvider = lifecycle.isNativeProvider.bind(lifecycle);
export const resolveGatewayNativeNvidiaProviderAuthority =
  lifecycle.resolveGatewayNativeProviderAuthority.bind(lifecycle);
export const nativeInferenceProviderForSandbox =
  lifecycle.nativeInferenceProviderForSandbox.bind(lifecycle);
export const nativeNvidiaProviderAttachmentFromMetadata =
  lifecycle.nativeProviderAttachmentFromMetadata.bind(lifecycle);
export const persistNativeNvidiaProviderAuthority =
  lifecycle.persistNativeProviderAuthority.bind(lifecycle);
export const ensureNativeNvidiaProvider = lifecycle.ensureNativeProvider.bind(lifecycle);
export const verifyNativeNvidiaProviderAttachment =
  lifecycle.verifyNativeProviderAttachment.bind(lifecycle);
export const ensureNativeNvidiaProviderAttached =
  lifecycle.ensureNativeProviderAttached.bind(lifecycle);
export const detachNativeNvidiaProvider = lifecycle.detachNativeProvider.bind(lifecycle);
