// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  hasUnsafeHostMountTerminalText,
  normalizePersistedSandboxHostMounts,
  parseReadOnlyHostMount,
  parseReadOnlyHostMounts,
  verifyReadOnlyHostMountSources,
} from "../../state/registry/host-mount";
import type { SandboxHostMount } from "../../state/registry/types";
import {
  type ExperimentalOnboardProfile,
  isPortableExperimentalProfile,
  PORTABLE_EXPERIMENTAL_PROFILE,
} from "../docker-driver-platform";
import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundleRegistry,
  RuntimeProviderSelectionError,
  requireRuntimeProviderReadOnlyHostMounts,
  resolveCurrentRuntimeProviderBundle,
} from "../runtime-provider/access";
import { PODMAN_READ_ONLY_HOST_MOUNT_UNSUPPORTED_REASON } from "../runtime-provider/podman";

export {
  hasUnsafeHostMountTerminalText,
  normalizePersistedSandboxHostMounts,
  parseReadOnlyHostMount,
  parseReadOnlyHostMounts,
  verifyReadOnlyHostMountSources,
};

export interface ReadOnlyHostMountRuntimeSupportDeps {
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly env?: NodeJS.ProcessEnv;
  readonly experimentalProfile?: ExperimentalOnboardProfile | null;
  readonly runtimeProviders?: RuntimeProviderBundleRegistry;
}

export function requireReadOnlyHostMountRuntimeSupport(
  mounts: readonly SandboxHostMount[] | undefined,
  deps: ReadOnlyHostMountRuntimeSupportDeps = {},
): void {
  if (!mounts || mounts.length === 0) return;
  const portable =
    deps.experimentalProfile === PORTABLE_EXPERIMENTAL_PROFILE ||
    isPortableExperimentalProfile(deps.env);
  if (portable) {
    throw new RuntimeProviderSelectionError(
      `Runtime provider 'podman' does not support read-only host mounts: ${PODMAN_READ_ONLY_HOST_MOUNT_UNSUPPORTED_REASON}`,
    );
  }
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
  const validatedRequested = requested?.length
    ? normalizePersistedSandboxHostMounts(requested)
    : null;
  return {
    activate(persisted) {
      const mounts = validatedRequested
        ? validatedRequested.map((mount) => ({ ...mount }))
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
  if (
    mounts.some(
      ({ source, target }) =>
        hasUnsafeHostMountTerminalText(source) || hasUnsafeHostMountTerminalText(target),
    )
  ) {
    throw new Error("Cannot report a host mount that contains terminal control characters.");
  }
  note("  Host directory access requested (read-only):");
  for (const mount of mounts) note(`    ${mount.source} -> ${mount.target}`);
  note("  Files remain on the host, and host-side changes are visible inside the sandbox.");
}
