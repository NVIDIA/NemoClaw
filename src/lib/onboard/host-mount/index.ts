// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizePersistedSandboxHostMounts,
  parseReadOnlyHostMount,
  parseReadOnlyHostMounts,
  verifyReadOnlyHostMountSources,
} from "../../state/registry/host-mount";
import type { SandboxHostMount } from "../../state/registry/types";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
  requireRuntimeProviderReadOnlyHostMounts,
  resolveCurrentRuntimeProviderBundle,
} from "../runtime-provider/access";

export {
  normalizePersistedSandboxHostMounts,
  parseReadOnlyHostMount,
  parseReadOnlyHostMounts,
  verifyReadOnlyHostMountSources,
};

export interface ReadOnlyHostMountRuntimeSupportDeps {
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly runtimeProviders?: RuntimeProviderBundleRegistry;
}

export function requireReadOnlyHostMountRuntimeSupport(
  mounts: readonly SandboxHostMount[] | undefined,
  deps: ReadOnlyHostMountRuntimeSupportDeps = {},
): void {
  if (!mounts || mounts.length === 0) return;
  const platform = deps.platform ?? process.platform;
  const provider = resolveCurrentRuntimeProviderBundle(
    platform,
    deps.arch ?? process.arch,
    deps.runtimeProviders ?? CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  requireRuntimeProviderReadOnlyHostMounts(provider, platform);
}

let dockerBindMountsEnabled = false;

export function isDockerBindMountsEnabled(): boolean {
  return dockerBindMountsEnabled;
}

export function beginHostMountScope(requested: readonly SandboxHostMount[] | undefined): {
  activate(persisted: unknown): readonly SandboxHostMount[];
  restore(): void;
} {
  const previous = dockerBindMountsEnabled;
  return {
    activate(persisted) {
      const mounts = requested?.length
        ? normalizePersistedSandboxHostMounts(requested)
        : normalizePersistedSandboxHostMounts(persisted);
      dockerBindMountsEnabled = mounts.length > 0;
      return mounts;
    },
    restore() {
      dockerBindMountsEnabled = previous;
    },
  };
}

export function reportReadOnlyHostMounts(
  mounts: readonly SandboxHostMount[],
  note: (message: string) => void,
): void {
  if (mounts.length === 0) return;
  note("  Host directory access requested (read-only):");
  for (const mount of mounts) note(`    ${mount.source} -> ${mount.target}`);
  note("  Files remain on the host, and host-side changes are visible inside the sandbox.");
}
