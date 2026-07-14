// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export function resolveHostPathFromCwd(input: string): string {
  if (input.length === 0) return input;
  const hasTrailingSeparator = input.length > 1 && /[/\\]$/.test(input);
  const absolute = path.isAbsolute(input)
    ? path.normalize(input)
    : path.resolve(process.cwd(), input);
  if (hasTrailingSeparator && !/[/\\]$/.test(absolute)) {
    return `${absolute}${path.sep}`;
  }
  return absolute;
}
