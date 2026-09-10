// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  withMcpLifecycleLock,
  withMcpLifecycleLockSync,
} from "../../../state/mcp-lifecycle-lock-acquisition";

export const withSandboxLifecycleLock = withMcpLifecycleLock;
export const withSandboxLifecycleLockSync = withMcpLifecycleLockSync;
export const withConnectSandboxLifecycleLock = withMcpLifecycleLock;
