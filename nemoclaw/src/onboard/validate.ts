// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return "****";
  }

  const lastFour = apiKey.slice(-4);
  if (apiKey.startsWith("nvapi-")) {
    return `nvapi-****${lastFour}`;
  }

  return `****${lastFour}`;
}
