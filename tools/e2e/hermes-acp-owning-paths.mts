// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Product files whose changes require the Hermes ACP lifecycle and rebuild proofs. */
export const HERMES_ACP_E2E_OWNING_PATHS = [
  "src/lib/acp/main.ts",
  "src/lib/acp/command.ts",
  "src/lib/adapters/openshell/hermes-acp-ssh-cli.ts",
  "src/lib/adapters/openshell/hermes-acp-ssh.ts",
] as const;
