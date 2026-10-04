// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  RuntimeProviderBundle,
  RuntimeProviderBundleRegistry,
  RuntimeProviderContainerEngineOperation,
} from "./contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES, resolveCurrentRuntimeProviderBundle } from "./current";
import {
  requireRuntimeProviderBundleForSandbox,
  resolveRuntimeProviderBundle,
  runtimeProviderSupportsContainerEngineOperation,
} from "./registry";

export { requireRuntimeProviderBundleForSandbox };

/** Resolve persisted provider metadata through the qualification-backed registry. */
export function resolveRegisteredRuntimeProvider(
  providerId: string | null | undefined,
): RuntimeProviderBundle | null {
  return resolveRuntimeProviderBundle(providerId, CURRENT_RUNTIME_PROVIDER_BUNDLES);
}

/** Resolve configured provider intent once at the runtime selection boundary. */
export function resolveConfiguredRuntimeProvider(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeProviderBundle {
  return resolveCurrentRuntimeProviderBundle(
    platform,
    arch,
    CURRENT_RUNTIME_PROVIDER_BUNDLES,
    environment,
  );
}

/** Current registry for dependency injection at provider-neutral orchestration seams. */
export function currentRuntimeProviderBundles(): RuntimeProviderBundleRegistry {
  return CURRENT_RUNTIME_PROVIDER_BUNDLES;
}

/** Capability query for persisted provider metadata. */
export function registeredRuntimeProviderSupportsContainerEngineOperation(
  providerId: string | null | undefined,
  operation: RuntimeProviderContainerEngineOperation,
): boolean {
  return runtimeProviderSupportsContainerEngineOperation(
    providerId,
    CURRENT_RUNTIME_PROVIDER_BUNDLES,
    operation,
  );
}
