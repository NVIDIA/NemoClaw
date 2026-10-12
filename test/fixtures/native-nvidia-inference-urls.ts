// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const NATIVE_NVIDIA_URLS = [
  "https://integrate.api.nvidia.com/v1",
  "HTTPS://INTEGRATE.API.NVIDIA.COM:443/v1/",
  "https://integrate.api.nvidia.com:0443/v1",
  "https://integrate.api.nvidia.com:000443/v1/",
];

export const INVALID_NATIVE_NVIDIA_URLS = [
  "https://integrate.api.nvidia.com:/v1",
  "https://integrate.api.nvidia.com/./v1",
  "https://integrate.api.nvidia.com/x/../v1",
  "https://integrate.api.nvidia.com/%2e/v1",
  "https://integrate.api.nvidia.com/V1",
  "https://integrate.api.nvidia.com//v1",
  "https://integrate.api.nvidia.com/v1?",
  "https://integrate.api.nvidia.com/v1#",
  "https://integrate.api.nvidia.com/v1?token=do-not-echo",
  "https://integrate.api.nvidia.com/v1\n",
];
