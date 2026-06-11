// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function isExplicitlyEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function shouldRunInstallerIntegration(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true" || env.CI === "1" || env.NEMOCLAW_RUN_INSTALLER_TESTS === "1";
}

export function shouldRunBranchValidationE2E(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isExplicitlyEnabled(env.NEMOCLAW_RUN_BRANCH_VALIDATION_E2E) ||
    (!!env.BREV_API_KEY && !!env.BREV_ORG_ID) ||
    !!env.BREV_API_TOKEN
  );
}

export function shouldRunLiveE2EScenarios(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NEMOCLAW_RUN_E2E_SCENARIOS?.trim().toLowerCase();
  return isExplicitlyEnabled(value);
}
