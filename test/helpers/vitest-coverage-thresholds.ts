// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const securityCoverageThresholds = {
  perFile: true,
  "nemoclaw/src/blueprint/ssrf.ts": {
    lines: 95,
    functions: 100,
    branches: 95,
    statements: 95,
  },
  "src/lib/inference/endpoint-ssrf-preflight.ts": {
    lines: 76,
    functions: 80,
    branches: 69,
    statements: 75,
  },
  "src/lib/security/{credential-filter,redact,redact-url}.ts": {
    lines: 80,
    functions: 70,
    branches: 65,
    statements: 80,
  },
  "src/commands/sandbox/policy/{add,remove}.ts": {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  "src/lib/policy/{commands,merge}.ts": {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  },
  "src/lib/inference/gateway-route-mutation-lock.ts": {
    lines: 100,
    functions: 100,
    branches: 65,
    statements: 80,
  },
  "src/lib/shields/transition-lock.ts": {
    lines: 70,
    functions: 60,
    branches: 60,
    statements: 65,
  },
  "src/lib/state/mcp-lifecycle-lock-{acquisition,identity,storage}.ts": {
    lines: 60,
    functions: 75,
    branches: 60,
    statements: 60,
  },
} as const;

export function resolveVitestCoverageThresholds(argv: readonly string[]) {
  const usesShard = argv.some(
    (argument, index) =>
      argument.startsWith("--shard=") || (argument === "--shard" && argv[index + 1] !== undefined),
  );
  return usesShard ? undefined : securityCoverageThresholds;
}
