// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
  normalizeNativeNvidiaProviderAttachment,
} from "../native-nvidia/contract";
import {
  requireHostedProviderAttachment,
  hostedNativeProviderForAttachment,
} from "./hosted-attachment";
import { normalizeProviderBaseUrl } from "../../core/provider-endpoint";
import type { NativeProviderAttachment } from "./contract";

/** Persisted authority selects the route; a logical provider name alone does not. */
export function recordedNativeProviderAttachment(selection: {
  provider?: string | null;
  endpointUrl?: string | null;
  credentialEnv?: string | null;
  preferredInferenceApi?: string | null;
  nativeNvidiaProviderAttachment?: unknown;
  nativeHostedProviderAttachment?: unknown;
}): NativeProviderAttachment | undefined {
  const hosted = requireHostedProviderAttachment(
    selection.nativeHostedProviderAttachment,
    selection.provider,
  );
  if (hosted?.custom) {
    const binding = hosted.custom;
    const api =
      selection.preferredInferenceApi === "responses"
        ? "openai-responses"
        : selection.preferredInferenceApi;
    if (
      (api && api !== binding.api) ||
      (selection.credentialEnv && selection.credentialEnv !== binding.credentialEnv) ||
      (selection.endpointUrl &&
        normalizeProviderBaseUrl(
          selection.endpointUrl,
          binding.provider === "compatible-anthropic-endpoint" ? "anthropic" : "openai",
        ) !== binding.endpointUrl)
    )
      throw new Error(
        "Recorded custom native selection does not match its endpoint, API or credential authority",
      );
  }
  if (selection.nativeNvidiaProviderAttachment !== undefined) {
    const nvidia = normalizeNativeNvidiaProviderAttachment(
      selection.nativeNvidiaProviderAttachment,
    );
    if (!nvidia || selection.provider?.trim() !== NVIDIA_HOSTED_LOGICAL_PROVIDER || hosted) {
      throw new Error("Invalid native provider attachment for the recorded inference selection");
    }
    return nvidia;
  }
  return hosted;
}

export function matchesRecordedNativeProviderEndpoint(
  selection: Parameters<typeof recordedNativeProviderAttachment>[0],
  endpoint: unknown,
): boolean {
  try {
    const attachment = recordedNativeProviderAttachment(selection);
    const expected =
      selection.provider === NVIDIA_HOSTED_LOGICAL_PROVIDER
        ? NVIDIA_HOSTED_NATIVE_ENDPOINT
        : hostedNativeProviderForAttachment(attachment)?.endpoint;
    return Boolean(
      attachment &&
      typeof endpoint === "string" &&
      expected &&
      new URL(endpoint).href.replace(/\/$/u, "") === new URL(expected).href.replace(/\/$/u, ""),
    );
  } catch {
    return false;
  }
}
