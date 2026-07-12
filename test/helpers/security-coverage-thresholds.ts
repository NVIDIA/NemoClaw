// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Keep security-sensitive coverage from hiding behind the aggregate ratchet.
// Values are conservative integer floors below the July 12, 2026 main baseline.
export const securityCoverageThresholds = {
  perFile: true,
  "nemoclaw/src/blueprint/ssrf.ts": {
    lines: 96,
    functions: 100,
    branches: 95,
    statements: 96,
  },
  "src/lib/security/{credential-filter,redact,redact-url}.ts": {
    lines: 98,
    functions: 92,
    branches: 86,
    statements: 96,
  },
  "src/lib/policy/index.ts": {
    lines: 66,
    functions: 68,
    branches: 57,
    statements: 66,
  },
  "src/lib/shields/transition-lock.ts": {
    lines: 85,
    functions: 82,
    branches: 78,
    statements: 83,
  },
};

export function securityCoverageThresholdsForRun(
  env: NodeJS.ProcessEnv,
): typeof securityCoverageThresholds | undefined {
  // Coverage shards only own part of the test suite. Enforce per-file floors
  // after Vitest merges every shard, when each protected file has its complete
  // coverage map.
  if (env.CLI_SHARD || env.CLI_SHARD_COUNT) {
    return undefined;
  }
  return securityCoverageThresholds;
}
