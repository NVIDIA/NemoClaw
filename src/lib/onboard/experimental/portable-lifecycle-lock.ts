// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { McpLifecycleLockOptions } from "../../state/mcp-lifecycle-lock";
import { defaultPortableStateDir } from "../../state/portable-uninstall-retirement";
import { hasHermesPortableReceiptCandidate } from "./hermes-portable-receipt";

export type HermesPortableReceiptCandidate = (
  sandboxName: string,
  env: NodeJS.ProcessEnv,
) => boolean;

/** Return the one host-scoped lifecycle-lock location owned by Portable receipts. */
export function portableLifecycleLockOptions(
  env: NodeJS.ProcessEnv = process.env,
): McpLifecycleLockOptions & { readonly stateDir: string } {
  return { stateDir: path.join(defaultPortableStateDir(env), "state") };
}

/** Select Portable locking only when the sandbox has Hermes receipt authority. */
export function resolveHermesPortableLifecycleLockOptions(
  sandboxName: string,
  env: NodeJS.ProcessEnv = process.env,
  hasReceiptCandidate: HermesPortableReceiptCandidate = (name, environment) =>
    hasHermesPortableReceiptCandidate(name, defaultPortableStateDir(environment)),
): (McpLifecycleLockOptions & { readonly stateDir: string }) | undefined {
  return hasReceiptCandidate(sandboxName, env) ? portableLifecycleLockOptions(env) : undefined;
}
