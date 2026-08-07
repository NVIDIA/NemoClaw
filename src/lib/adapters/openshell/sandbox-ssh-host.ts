// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const OPENSHELL_DEFAULT_WORKSPACE = "default";

/** Return OpenShell v0.0.99's SSH config alias for a default-workspace sandbox. */
export function openshellSandboxSshHost(sandboxName: string): string {
  return `openshell-${sandboxName}.${OPENSHELL_DEFAULT_WORKSPACE}`;
}
