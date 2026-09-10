// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type McpLifecycleLockOptions,
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} from "../../../state/mcp-lifecycle-lock-acquisition";
import { withCurrentPortableHostFence } from "../../../state/portable-uninstall-retirement";
import {
  portableLifecycleLockOptions,
  resolveHermesPortableLifecycleLockOptions,
} from "../../../onboard/experimental/portable-lifecycle-lock";

function resolveLifecycleLockOptions(
  sandboxName: string,
  options: McpLifecycleLockOptions,
): McpLifecycleLockOptions {
  if (options.stateDir !== undefined) return options;
  const portable = resolveHermesPortableLifecycleLockOptions(sandboxName);
  return portable ? { ...options, ...portable } : options;
}

function usesPortableLifecycleLock(options: McpLifecycleLockOptions): boolean {
  return options.stateDir === portableLifecycleLockOptions().stateDir;
}

/** Serialize one sandbox on its receipt-owned lock and host fence when Portable. */
export async function withSandboxLifecycleLock<T>(
  sandboxName: string,
  operation: () => Promise<T> | T,
  options: McpLifecycleLockOptions = {},
): Promise<T> {
  const resolved = resolveLifecycleLockOptions(sandboxName, options);
  const acquire = () =>
    Object.keys(resolved).length === 0
      ? withMcpLifecycleLock(sandboxName, operation)
      : withMcpLifecycleLock(sandboxName, operation, resolved);
  return usesPortableLifecycleLock(resolved)
    ? await withCurrentPortableHostFence(acquire)
    : await acquire();
}

/** Synchronous nested provider operations reuse the receipt-owned sandbox lock. */
export function withSandboxLifecycleLockSync<T>(
  sandboxName: string,
  operation: () => T,
  options: McpLifecycleLockOptions = {},
): T {
  const resolved = resolveLifecycleLockOptions(sandboxName, options);
  return Object.keys(resolved).length === 0
    ? withMcpLifecycleLockSync(sandboxName, operation)
    : withMcpLifecycleLockSync(sandboxName, operation, resolved);
}

export const withConnectSandboxLifecycleLock = withSandboxLifecycleLock;
