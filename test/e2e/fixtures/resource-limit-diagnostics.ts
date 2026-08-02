// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const SECURITY_RESOURCE_LIMIT_DIAGNOSTIC =
  /\[SECURITY\][^\r\n]*(?:resource limits?|nproc|nofile)/iu;

export function containsSecurityResourceLimitDiagnostic(output: string): boolean {
  return SECURITY_RESOURCE_LIMIT_DIAGNOSTIC.test(output);
}
