// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Configuration and credential identity share provider policy, not executable entrypoints.
export const PROVIDER_CONFIGURATION: Readonly<
  Record<
    string,
    Readonly<{
      endpoint: string | null;
      credentialRequired: boolean;
      credentialPrefix: string | null;
      loopbackOnly: boolean;
    }>
  >
> = Object.freeze({
  nvidia: Object.freeze({
    endpoint: "https://integrate.api.nvidia.com/v1",
    credentialRequired: true,
    credentialPrefix: "nvapi-",
    loopbackOnly: false,
  }),
  openrouter: Object.freeze({
    endpoint: "https://openrouter.ai/api/v1",
    credentialRequired: true,
    credentialPrefix: "sk-or-",
    loopbackOnly: false,
  }),
  compatible: Object.freeze({
    endpoint: null,
    credentialRequired: false,
    credentialPrefix: null,
    loopbackOnly: false,
  }),
  local: Object.freeze({
    endpoint: null,
    credentialRequired: false,
    credentialPrefix: null,
    loopbackOnly: true,
  }),
});
