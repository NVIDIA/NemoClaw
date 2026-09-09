// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Configuration identity without policy contents, settings, or credential values. */
export type SandboxConfiguration = Readonly<{
  sandboxId: string;
  workspace: string;
  revision: number;
  policyHash: string;
  configRevision: string;
  providerEnvRevision: string;
  policySource: "sandbox" | "global";
  globalPolicyVersion: number;
}>;
