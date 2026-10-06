// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const PUBLIC_NVIDIA_SWITCH_PROVIDER = "nvidia-prod";
export const PUBLIC_NVIDIA_SWITCH_MODEL = "nvidia/nemotron-3-super-120b-a12b";

export function requirePublicNvidiaSwitchKey(value: string): string {
  if (!/^nvapi-[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("NVIDIA_API_KEY must be a public NVIDIA Endpoints nvapi-* key");
  }
  return value;
}
