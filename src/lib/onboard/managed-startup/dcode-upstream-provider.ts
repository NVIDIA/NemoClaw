// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const DCODE_UPSTREAM_PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function isValidDcodeUpstreamProvider(value: string): boolean {
  return DCODE_UPSTREAM_PROVIDER_RE.test(value);
}
