// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function normalizeContainerPath(value: string): string {
  return value.replace(/\/+$/u, "") || "/";
}

export function containerPathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeContainerPath(left);
  const normalizedRight = normalizeContainerPath(right);
  const contains = (parent: string, child: string): boolean =>
    parent === "/" ? child.startsWith("/") : child.startsWith(`${parent}/`);
  return (
    normalizedLeft === normalizedRight ||
    contains(normalizedLeft, normalizedRight) ||
    contains(normalizedRight, normalizedLeft)
  );
}
