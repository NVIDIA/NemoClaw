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
