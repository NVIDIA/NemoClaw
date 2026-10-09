// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  isMcpLifecycleLockHeld,
  type McpLifecycleLockOptions,
  withMcpLifecycleLock,
  withMcpLifecycleLock as withSandboxMutationLock,
  withMcpLifecycleLockSync,
} from "./mcp-lifecycle-lock-acquisition";
export {
  classifyMcpLifecycleLock,
  type McpLifecycleLockDisposition,
  type McpLifecycleLockOwner,
  readMcpLockHostIdentity,
  readMcpLockPidNamespaceIdentity,
  readMcpLockProcessIdentity,
} from "./mcp-lifecycle-lock-identity";
export { getMcpLifecycleLockPath, MCP_LIFECYCLE_LOCK_DIRNAME } from "./mcp-lifecycle-lock-storage";
