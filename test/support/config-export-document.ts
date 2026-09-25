// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { V1Alpha1Export, V1Alpha1ExportSandbox } from "../../src/lib/config/v1alpha1-export";

/** Type one parsed producer fixture for focused shape assertions. This does not validate v1 input. */
export function asExportedConfig(value: unknown): V1Alpha1Export {
  return value as V1Alpha1Export;
}

export function exportedDeepAgentsSandbox(
  sandbox: V1Alpha1ExportSandbox,
): Extract<V1Alpha1ExportSandbox, { readonly image: Readonly<{ ref: string }> }> {
  if (sandbox.image === undefined || sandbox.harness.kind !== "deepagents") {
    throw new Error("The export requires a Deep Agents sandbox");
  }
  return sandbox as Extract<V1Alpha1ExportSandbox, { readonly image: Readonly<{ ref: string }> }>;
}
