// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizePersistedSandboxHostMounts,
  parseReadOnlyHostMount,
  parseReadOnlyHostMounts,
} from "../../state/registry/host-mount";
import type { SandboxHostMount } from "../../state/registry/types";

export { normalizePersistedSandboxHostMounts, parseReadOnlyHostMount, parseReadOnlyHostMounts };

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
        ? requested.map((mount) => ({ ...mount }))
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
