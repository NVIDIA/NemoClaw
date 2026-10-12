// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
} from "../../../src/lib/inference/native-nvidia/contract.ts";

// A failed restoration must not prevent removal of the temporary provider.
export async function withNativeModelCleanup<T>(
  verify: () => Promise<T>,
  restore: () => Promise<void>,
  removeProvider: () => Promise<void>,
): Promise<T> {
  try {
    return await verify();
  } finally {
    try {
      await restore();
    } finally {
      await removeProvider();
    }
  }
}

// The preceding sandbox inference turn qualifies this model and route. A new
// provider name makes a gateway that ignores the native edit distinguishable.
export function buildNativeModelRestartFixture(model: string, logicalProvider?: string) {
  const nativeNvidia = logicalProvider === NVIDIA_HOSTED_LOGICAL_PROVIDER;
  const provider = `nemoclaw-e2e-native-${randomUUID()}`;
  const primary = `${provider}/${model}`;
  return {
    provider,
    primary,
    model,
    patch: JSON.stringify({
      models: {
        providers: {
          [provider]: {
            baseUrl: nativeNvidia ? NVIDIA_HOSTED_NATIVE_ENDPOINT : "https://inference.local/v1",
            apiKey: nativeNvidia ? "${NVIDIA_INFERENCE_API_KEY}" : "unused",
            api: "openai-completions",
            models: [{ id: model, name: model }],
          },
        },
      },
      agents: { defaults: { model: { primary }, models: { [primary]: {} } } },
    }),
  };
}
