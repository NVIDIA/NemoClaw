// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const vitestStateIsolation = {
  clearMocks: true,
  restoreMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
} as const;
