// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { withMcpLifecycleLock } from "../mcp-lifecycle-lock-acquisition";

const CREDENTIAL_OWNERSHIP_LOCK_NAME = "global-credential-ownership";

export function withMcpCredentialOwnershipLock<T>(operation: () => Promise<T> | T): Promise<T> {
  return withMcpLifecycleLock(CREDENTIAL_OWNERSHIP_LOCK_NAME, operation);
}
