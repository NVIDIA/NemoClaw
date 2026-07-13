// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function requireFixture(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
