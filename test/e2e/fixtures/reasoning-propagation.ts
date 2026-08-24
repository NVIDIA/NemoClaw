// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CorporateCaWorkloadKind } from "./corporate-ca.ts";

export type ReasoningPropagationSource = {
  kind: "managed-runtime-environment";
  path: "/run/nemoclaw/managed-startup-runtime.env";
};

export function reasoningPropagationSource(
  _workloadKind: CorporateCaWorkloadKind,
): ReasoningPropagationSource {
  return {
    kind: "managed-runtime-environment",
    path: "/run/nemoclaw/managed-startup-runtime.env",
  };
}
