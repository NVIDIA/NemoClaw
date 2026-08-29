// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  acquireProcessBoundLockAt,
  type ProcessBoundLockHandle,
  releaseProcessBoundLock,
} from "../../state/registry/lock";
import {
  assertManagedGatewayStateDirectoryParentTrusted,
  managedGatewayStateLifecycleLockPath,
} from "./state-dir";

function acquireManagedGatewayStateLifecycleLockWithRetries(
  stateDir: string,
  maxRetries?: number,
): ProcessBoundLockHandle {
  assertManagedGatewayStateDirectoryParentTrusted(stateDir);
  return acquireProcessBoundLockAt(managedGatewayStateLifecycleLockPath(stateDir), { maxRetries });
}

export function acquireManagedGatewayStateLifecycleLock(stateDir: string): ProcessBoundLockHandle {
  return acquireManagedGatewayStateLifecycleLockWithRetries(stateDir);
}

export function tryAcquireManagedGatewayStateLifecycleLock(
  stateDir: string,
): ProcessBoundLockHandle | null {
  try {
    return acquireManagedGatewayStateLifecycleLockWithRetries(stateDir, 1);
  } catch {
    return null;
  }
}

export function releaseManagedGatewayStateLifecycleLock(lock: ProcessBoundLockHandle): void {
  releaseProcessBoundLock(lock);
}
