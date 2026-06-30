// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function withoutProviderComposedPolicies<T>(
  policies: Record<string, T>,
): Record<string, T>;
