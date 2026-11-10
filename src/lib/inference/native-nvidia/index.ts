// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { nativeProviderLifecycle, NativeProviderError } from "../native-provider";
import { NVIDIA_HOSTED_NATIVE_DEFINITION } from "./contract";

export * from "./contract";
export { NativeProviderError as NativeNvidiaProviderError };

const lifecycle = nativeProviderLifecycle(NVIDIA_HOSTED_NATIVE_DEFINITION);

export const nativeNvidiaProviderProfilePath = lifecycle.nativeProviderProfilePath.bind(lifecycle);
export const requireNativeNvidiaProviderProfileBoundary =
  lifecycle.requireNativeProviderProfileBoundary.bind(lifecycle);
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
