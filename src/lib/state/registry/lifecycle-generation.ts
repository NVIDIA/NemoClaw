// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { withLock } from "./lock";
import { load, save } from "./persistence";
import type { SandboxEntry } from "./types";

/** Claim a lifecycle generation for one unchanged legacy Docker registry row. */
export function compareAndSetLegacySandboxLifecycleGeneration(
  expected: SandboxEntry,
  lifecycleGeneration: string,
): boolean {
  if (
    expected.openshellDriver !== "docker" ||
    expected.lifecycleGeneration !== undefined ||
    lifecycleGeneration.length === 0 ||
    lifecycleGeneration.length > 256 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(lifecycleGeneration)
  ) {
    return false;
  }
  return withLock(() => {
    const data = load();
    const current = data.sandboxes[expected.name];
    if (!current || !isDeepStrictEqual(current, expected)) return false;
    current.lifecycleGeneration = lifecycleGeneration;
    save(data);
    return true;
  });
}

/** Publish complete live lifecycle authority for one unchanged pre-authority registry row. */
export function compareAndSetLegacySandboxLifecycleAuthority(
  expected: SandboxEntry,
  lifecycleGeneration: string,
  sandboxIdentityFingerprint: string,
): boolean {
  const expectedSnapshot = structuredClone(expected);
  if (
    expectedSnapshot.pendingRouteReservation === true ||
    (expectedSnapshot.lifecycleGeneration !== undefined &&
      expectedSnapshot.lifecycleLiveIdentityFingerprint !== undefined) ||
    lifecycleGeneration.length === 0 ||
    lifecycleGeneration.length > 256 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(lifecycleGeneration) ||
    !/^[0-9a-f]{64}$/u.test(sandboxIdentityFingerprint) ||
    (expectedSnapshot.lifecycleGeneration !== undefined &&
      expectedSnapshot.lifecycleGeneration !== lifecycleGeneration) ||
    (expectedSnapshot.lifecycleLiveIdentityFingerprint !== undefined &&
      expectedSnapshot.lifecycleLiveIdentityFingerprint !== sandboxIdentityFingerprint)
  ) {
    return false;
  }
  return withLock(() => {
    const data = load();
    const current = data.sandboxes[expectedSnapshot.name];
    if (!current || !isDeepStrictEqual(current, expectedSnapshot)) return false;
    data.sandboxes[expectedSnapshot.name] = {
      ...current,
      lifecycleGeneration,
      lifecycleLiveIdentityFingerprint: sandboxIdentityFingerprint,
    };
    save(data);
    return true;
  });
}

/** Mark legacy forward retirement complete only for the exact lifecycle authority. */
export function compareAndSetForwardServiceMigrationComplete(
  sandboxName: string,
  lifecycleGeneration: string,
  sandboxIdentityFingerprint: string,
): boolean {
  if (!sandboxName || !lifecycleGeneration || !/^[0-9a-f]{64}$/u.test(sandboxIdentityFingerprint)) {
    return false;
  }
  return withLock(() => {
    const data = load();
    const current = data.sandboxes[sandboxName];
    if (
      !current ||
      current.pendingRouteReservation === true ||
      current.lifecycleGeneration !== lifecycleGeneration ||
      current.lifecycleLiveIdentityFingerprint !== sandboxIdentityFingerprint
    ) {
      return false;
    }
    current.forwardServiceMigrationVersion = 1;
    save(data);
    return true;
  });
}
