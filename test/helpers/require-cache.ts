// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type RequireCache = Record<string, unknown>;

export function restoreRequireCache(
  requireCache: RequireCache,
  modulePath: string,
  prior: unknown,
): void {
  prior === undefined ? delete requireCache[modulePath] : (requireCache[modulePath] = prior);
}
