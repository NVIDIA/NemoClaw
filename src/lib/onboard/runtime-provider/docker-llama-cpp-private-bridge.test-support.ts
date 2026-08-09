// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import {
  createDockerLlamaCppManagedLifecycle,
  type DockerLlamaCppManagedLifecycleOptions,
} from "./docker-llama-cpp-managed-lifecycle";
import { invariant } from "./docker-llama-cpp-managed-lifecycle.test-support";

export function privateBridgeFixture() {
  let active: string | null = null;
  return {
    start: vi.fn((authority: unknown) => (active = JSON.stringify(authority))),
    assertRunning: vi.fn((authority: unknown) =>
      invariant(active === JSON.stringify(authority), "bridge is not running"),
    ),
    assertStopped: vi.fn(() => invariant(active === null, "bridge is still running")),
    stopTransaction: vi.fn(() => (active = null)),
  };
}

export function createTestDockerLlamaCppManagedLifecycle(
  lifecycleOptions: DockerLlamaCppManagedLifecycleOptions,
  dependencies: { readonly now?: () => number } = {},
  privateBridge = privateBridgeFixture(),
) {
  return createDockerLlamaCppManagedLifecycle(lifecycleOptions, {
    ...dependencies,
    privateBridge,
  });
}
