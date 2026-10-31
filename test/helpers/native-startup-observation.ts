// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Model canonical state becoming observable only after native startup finishes. */
export function observeAfterNativeStartup<T>(
  now: () => number,
  readyAt: number,
  observe: () => T,
  pending: Error,
): () => T {
  return () => {
    if (now() < readyAt) throw pending;
    return observe();
  };
}
