// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type Environment = Record<string, string | undefined>;

const DEFAULT_CI_E2E_RETRIES = 2;
const DEFAULT_LOCAL_E2E_RETRIES = 0;
const MAX_E2E_RETRIES = 5;

export function resolveE2ERetryCount(env: Environment = process.env): number {
  const override = env.NEMOCLAW_E2E_RETRIES?.trim();
  if (override && /^[0-9]+$/.test(override)) {
    return Math.min(Number.parseInt(override, 10), MAX_E2E_RETRIES);
  }

  const envIsCi = env.GITHUB_ACTIONS === "true" || env.CI === "true" || env.CI === "1";
  return envIsCi ? DEFAULT_CI_E2E_RETRIES : DEFAULT_LOCAL_E2E_RETRIES;
}
