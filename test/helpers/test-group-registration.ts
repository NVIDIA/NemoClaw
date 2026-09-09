// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function registerTestGroup<Group extends string>(
  selected: Group,
  expected: Group,
  register: () => void,
): void {
  if (selected === expected) register();
}
