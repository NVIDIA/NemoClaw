// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveLiveInferenceGatewayName } from "../inference/gateway-route-compatibility";
import { withGatewayRouteMutationLock } from "../inference/gateway-route-mutation-lock";
import { withSandboxMutationLock } from "../state/mcp-lifecycle-lock";
import { load } from "../state/registry/persistence";
import type { SandboxEntry } from "../state/registry/types";

type GetSandbox = (name: string) => SandboxEntry | null;

const getSandboxForRouteLock: GetSandbox = (name) => load().sandboxes[name] ?? null;

export interface CuaCommandRouteLockDeps {
  getSandbox?: GetSandbox;
  withSandboxMutationLock?: typeof withSandboxMutationLock;
  withGatewayRouteMutationLock?: typeof withGatewayRouteMutationLock;
}

/**
 * Hold the shared sandbox and gateway mutation leases for a complete CUA
 * command. The global order is sandbox mutation, then gateway route, then the
 * lifecycle's brief registry snapshot/CAS locks. This matches inference-set
 * and keeps policy, channel, shields, snapshot, and CUA mutations serialized.
 */
export async function withCuaCommandRouteLock<T>(
  sandboxName: string,
  operation: (entry: SandboxEntry | null) => Promise<T> | T,
  deps: CuaCommandRouteLockDeps = {},
): Promise<T> {
  return await (deps.withSandboxMutationLock ?? withSandboxMutationLock)(sandboxName, async () => {
    const entry = (deps.getSandbox ?? getSandboxForRouteLock)(sandboxName);
    if (!entry) return await operation(null);
    return await (deps.withGatewayRouteMutationLock ?? withGatewayRouteMutationLock)(
      resolveLiveInferenceGatewayName(entry),
      () => operation(entry),
    );
  });
}
