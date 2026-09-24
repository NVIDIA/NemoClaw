// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import { withLock } from "./lock";
import { load, save } from "./persistence";
import type { SandboxEntry } from "./types";

/** Claim a lifecycle generation after the caller establishes provider authority. */
export function compareAndSetSandboxLifecycleGeneration(
  expected: SandboxEntry,
  lifecycleGeneration: string,
): boolean {
  if (
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

export function compareAndSetSandboxLifecycleIdentity(
  expected: SandboxEntry,
  registration: Required<
    Pick<SandboxEntry, "lifecycleGeneration" | "lifecycleLiveIdentityFingerprint">
  >,
  revalidate: () => void,
): boolean {
  const snapshot = structuredClone(expected);
  const { lifecycleGeneration, lifecycleLiveIdentityFingerprint } = registration;
  if (
    snapshot.pendingRouteReservation ||
    snapshot.pendingCreateIdentity ||
    (snapshot.lifecycleGeneration !== undefined &&
      snapshot.lifecycleLiveIdentityFingerprint !== undefined) ||
    !lifecycleGeneration ||
    lifecycleGeneration.length > 256 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(lifecycleGeneration) ||
    !/^[0-9a-f]{64}$/u.test(lifecycleLiveIdentityFingerprint) ||
    (snapshot.lifecycleGeneration !== undefined &&
      snapshot.lifecycleGeneration !== lifecycleGeneration) ||
    (snapshot.lifecycleLiveIdentityFingerprint !== undefined &&
      snapshot.lifecycleLiveIdentityFingerprint !== lifecycleLiveIdentityFingerprint)
  )
    return false;
  return withLock(() => {
    if (!isDeepStrictEqual(load().sandboxes[snapshot.name], snapshot)) return false;
    revalidate();
    const data = load();
    if (!isDeepStrictEqual(data.sandboxes[snapshot.name], snapshot)) return false;
    data.sandboxes[snapshot.name] = {
      ...snapshot,
      lifecycleGeneration,
      lifecycleLiveIdentityFingerprint,
    };
    save(data);
    return true;
  });
}
