// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import {
  type McpLifecycleLockOptions,
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} from "../../../state/mcp-lifecycle-lock-acquisition";
import {
  assertCurrentPortableHostFenceHeld,
  withCurrentPortableHostFence,
} from "../../../state/portable-uninstall-retirement";
import { resolveHermesPortableLifecycleLockOptions } from "../../../onboard/experimental/portable-lifecycle-lock";

/** Host-boundary sink for the one-time "still waiting on the lock" notice. */
export function writeLifecycleLockWaitNoticeToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function resolveLifecycleLockOptions(
  sandboxName: string,
  options: McpLifecycleLockOptions,
): McpLifecycleLockOptions {
  const withNotice: McpLifecycleLockOptions = {
    onWaitNotice: writeLifecycleLockWaitNoticeToStderr,
    ...options,
  };
  if (options.stateDir !== undefined) return withNotice;
  const portable = resolveHermesPortableLifecycleLockOptions(sandboxName);
  return portable ? { ...withNotice, ...portable } : withNotice;
}

/** Select the sandbox lock domain while holding the host fence, then serialize the operation. */
export async function withSandboxLifecycleLock<T>(
  sandboxName: string,
  operation: () => Promise<T> | T,
  options: McpLifecycleLockOptions = {},
): Promise<T> {
  return await withCurrentPortableHostFence(async () => {
    const resolved = resolveLifecycleLockOptions(sandboxName, options);
    return await withMcpLifecycleLock(sandboxName, operation, resolved);
  });
}

/** Synchronous lifecycle operations are valid only beneath the asynchronous host fence. */
export function withSandboxLifecycleLockSync<T>(
  sandboxName: string,
  operation: () => T,
  options: McpLifecycleLockOptions = {},
): T {
  assertCurrentPortableHostFenceHeld(process.env.HOME || os.homedir());
  const resolved = resolveLifecycleLockOptions(sandboxName, options);
  return withMcpLifecycleLockSync(sandboxName, operation, resolved);
}

export const withConnectSandboxLifecycleLock = withSandboxLifecycleLock;
