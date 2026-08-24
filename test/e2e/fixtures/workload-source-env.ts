// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reject automatic legacy source selection at the final E2E spawn boundary.
 * An explicit custom Dockerfile remains a separate user-supplied input.
 */
export function resolveLiveE2eWorkloadSourceEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const targetId = input.E2E_TARGET_ID;
  const source = input.E2E_WORKLOAD_SOURCE;
  if (!targetId || source !== "legacy-dockerfile") return input;
  if (input.NEMOCLAW_FROM_DOCKERFILE) return input;
  throw new Error(`live E2E target '${targetId}' cannot select a stock legacy Dockerfile`);
}
