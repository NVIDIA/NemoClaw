// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createManagedProviderAdapter } from "../../adapters/openshell/managed-provider-adapter";
import { retireUnselectedNativeLocalProviders } from "../../inference/native-local/selection";

/** Retire former providers only after the caller commits sandbox registration. */
export async function retireUnselectedCreatedSandboxProviders(
  input: Omit<Parameters<typeof retireUnselectedNativeLocalProviders>[0], "adapter">,
  retire: typeof retireUnselectedNativeLocalProviders = retireUnselectedNativeLocalProviders,
): Promise<void> {
  await retire({ ...input, adapter: createManagedProviderAdapter() });
}
