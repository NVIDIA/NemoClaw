// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  V1Alpha1Export,
  V1Alpha1ExportAgent,
  V1Alpha1ExportSandbox,
} from "../../src/lib/config/v1alpha1-export";

/** Type one parsed producer fixture for focused shape assertions. This does not validate v1 input. */
export function asExportedConfig(value: unknown): V1Alpha1Export {
  return value as V1Alpha1Export;
}

export function exportedAgentList(sandbox: V1Alpha1ExportSandbox): readonly V1Alpha1ExportAgent[] {
  return "agents" in sandbox ? sandbox.agents : [];
}

export function exportedSingletonSandbox(
  sandbox: V1Alpha1ExportSandbox,
): Extract<V1Alpha1ExportSandbox, { readonly agent: V1Alpha1ExportAgent }> {
  if (!("agent" in sandbox)) throw new Error("The export requires one agent");
  return sandbox;
}
