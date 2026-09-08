// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveRegisteredRuntimeProvider } from "../../onboard/runtime-provider/selection";
import { compareAndSetSandboxLifecycleGeneration } from "./lifecycle-generation-cas";
import type { SandboxEntry } from "./types";

export function usesLegacyRuntimeLifecycleCompatibility(entry: SandboxEntry): boolean {
  const driverName = entry.openshellDriver?.trim().toLowerCase();
  if (!driverName) return false;
  const provider = resolveRegisteredRuntimeProvider(driverName);
  if (!provider || provider.identity.id !== driverName || provider.lifecycle.supported !== true) {
    return false;
  }
  try {
    return (
      provider.gateway.prepareHostRuntime({
        environment: process.env,
        platform: process.platform,
      }).socketPath === null
    );
  } catch {
    return false;
  }
}

/** Claim a lifecycle generation for one unchanged legacy Docker registry row. */
export function compareAndSetLegacySandboxLifecycleGeneration(
  expected: SandboxEntry,
  lifecycleGeneration: string,
): boolean {
  if (
    !usesLegacyRuntimeLifecycleCompatibility(expected) ||
    expected.lifecycleGeneration !== undefined
  ) {
    return false;
  }
  return compareAndSetSandboxLifecycleGeneration(expected, lifecycleGeneration);
}
