// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Static attribution shared by native agent requests and the legacy adapter.
export const OPENROUTER_DEFAULT_HEADERS = [
  ["HTTP-Referer", "https://www.nvidia.com/nemoclaw/"],
  ["X-OpenRouter-Title", "NVIDIA NemoClaw"],
] as const;
