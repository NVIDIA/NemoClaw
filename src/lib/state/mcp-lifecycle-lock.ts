// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  type McpLifecycleLockOptions,
  withMcpLifecycleLock,
  withMcpLifecycleLock as withSandboxMutationLock,
} from "./mcp-lifecycle-lock-acquisition";
export {
  classifyMcpLifecycleLock,
  type McpLifecycleLockDisposition,
  readMcpLockHostIdentity,
  readMcpLockPidNamespaceIdentity,
  readMcpLockProcessIdentity,
} from "./mcp-lifecycle-lock-identity";
export {
  getMcpLifecycleLockPath,
  MCP_LIFECYCLE_LOCK_DIRNAME,
} from "./mcp-lifecycle-lock-storage";
