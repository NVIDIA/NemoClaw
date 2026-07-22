// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type DependencyNode = {
  dependencies?: Record<string, DependencyNode>;
  overridden?: boolean;
  resolved?: string;
  version?: string;
};

export function findDependency(root: DependencyNode, name: string): DependencyNode | undefined {
  if (root.dependencies?.[name]) return root.dependencies[name];
  for (const dependency of Object.values(root.dependencies ?? {})) {
    const nested = findDependency(dependency, name);
    if (nested) return nested;
  }
  return undefined;
}
