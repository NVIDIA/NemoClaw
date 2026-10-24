// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
export type Origin = { id: string; name: string; paths: string[] };
export const otherOrigin: Origin = { id: "other", name: "Other repository guidance", paths: [] };
// Trailing slash denotes a directory; otherwise the rule matches an exact file.
// The most specific matching path wins, independently of display order.
export function guidanceOrigin(path: string, origins: Origin[]): Origin {
  let winner = otherOrigin;
  let specificity = -1;
  for (const origin of origins)
    for (const rule of origin.paths) {
      if (
        (rule.endsWith("/") ? path.startsWith(rule) : path === rule) &&
        rule.length > specificity
      ) {
        winner = origin;
        specificity = rule.length;
      }
    }
  return winner;
}
