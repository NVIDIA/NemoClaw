// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function isExplicitlyEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function shouldRunInstallerIntegration(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI === "true" || env.CI === "1" || env.NEMOCLAW_RUN_INSTALLER_TESTS === "1";
}

export function shouldRunLiveE2E(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NEMOCLAW_RUN_LIVE_E2E?.trim().toLowerCase();
  return isExplicitlyEnabled(value);
}
