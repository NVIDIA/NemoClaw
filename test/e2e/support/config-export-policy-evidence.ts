// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellSandboxPolicyRead } from "../../../src/lib/adapters/openshell/sandbox-policy.ts";
import type { OpenShellSandboxResult } from "../../../src/lib/adapters/openshell/sandbox-observer.ts";

export function requireEffectivePolicyDocument(
  result: OpenShellSandboxResult<OpenShellSandboxPolicyRead>,
): string {
  if (!result.ok) {
    throw new Error(`the effective sandbox policy could not be read: ${result.error.message}`);
  }
  return result.value.document;
}
