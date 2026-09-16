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
import { withHermesPortableStartupOperation } from "../../../onboard/experimental/hermes-portable-startup-operation";

function resolveLifecycleLockOptions(
  sandboxName: string,
  options: McpLifecycleLockOptions,
): McpLifecycleLockOptions {
  if (options.stateDir !== undefined) return options;
  const portable = resolveHermesPortableLifecycleLockOptions(sandboxName);
  return portable ? { ...options, ...portable } : options;
}

/** Select the sandbox lock domain while holding the host fence, then serialize the operation. */
export async function withSandboxLifecycleLock<T>(
  sandboxName: string,
  operation: () => Promise<T> | T,
  options: McpLifecycleLockOptions = {},
): Promise<T> {
  return await withCurrentPortableHostFence(async () => {
    const portable = resolveHermesPortableLifecycleLockOptions(sandboxName);
    const resolved =
      options.stateDir !== undefined ? options : portable ? { ...options, ...portable } : options;
    const startupEnv =
      portable && process.env.NEMOCLAW_EXPERIMENTAL_PROFILE === undefined
        ? { ...process.env, NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" }
        : process.env;
    const scoped = () =>
      withHermesPortableStartupOperation(sandboxName, resolved.stateDir, operation, startupEnv);
    return Object.keys(resolved).length === 0
      ? await withMcpLifecycleLock(sandboxName, scoped)
      : await withMcpLifecycleLock(sandboxName, scoped, resolved);
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
  return Object.keys(resolved).length === 0
    ? withMcpLifecycleLockSync(sandboxName, operation)
    : withMcpLifecycleLockSync(sandboxName, operation, resolved);
}

export const withConnectSandboxLifecycleLock = withSandboxLifecycleLock;
