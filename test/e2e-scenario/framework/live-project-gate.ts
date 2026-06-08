// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function shouldRunLiveE2EScenarios(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NEMOCLAW_RUN_E2E_SCENARIOS?.trim().toLowerCase();
  return value === "1" || value === "true";
}
