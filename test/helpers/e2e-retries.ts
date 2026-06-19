// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type Environment = Record<string, string | undefined>;

const DEFAULT_CI_E2E_RETRIES = 2;
const DEFAULT_LOCAL_E2E_RETRIES = 0;

export function resolveE2ERetryCount(env: Environment = process.env): number {
  const override = env.NEMOCLAW_E2E_RETRIES?.trim();
  if (override && /^[0-9]+$/.test(override)) {
    return Number.parseInt(override, 10);
  }

  const envIsCi = env.GITHUB_ACTIONS === "true" || env.CI === "true" || env.CI === "1";
  return envIsCi ? DEFAULT_CI_E2E_RETRIES : DEFAULT_LOCAL_E2E_RETRIES;
}
