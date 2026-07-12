// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Shared assertions for tests that inspect the curl --config tmpfile route
// introduced in PR #5975. Extracted from src/lib/inference/onboard-probes.test.ts
// and src/lib/inference/provider-models.test.ts so the assertion shape stays
// in one place. See PR #5975 review notes PRA-9 (Nemotron) and PRA-CR
// (CodeRabbit "assert --config has a path value").

import fs from "node:fs";

import { expect } from "vitest";

export function captureAuthConfigPath(argv: readonly string[]): string {
  const index = argv.indexOf("--config");
  expect(index).toBeGreaterThanOrEqual(0);
  const configPath = argv[index + 1];
  expect(configPath).toBeTruthy();
  expect(typeof configPath).toBe("string");
  return configPath;
}

export function readAuthConfigContents(argv: readonly string[]): string {
  const configPath = captureAuthConfigPath(argv);
  // Single readFileSync, no existsSync precheck: readFileSync throws ENOENT
  // synchronously if the file is missing, which is what the assertion wants
  // anyway, and avoids the "check then use" filesystem race that CodeQL
  // flagged in PR #5975 review.
  const contents = fs.readFileSync(configPath, "utf8");
  const stat = fs.statSync(configPath);
  expect(stat.mode & 0o777).toBe(0o600);
  return contents;
}

export function expectTrustedConfig(
  argv: readonly string[],
  opts: { trustedConfigFiles?: readonly string[] } | undefined,
): void {
  const configPath = captureAuthConfigPath(argv);
  expect(opts?.trustedConfigFiles ?? []).toContain(configPath);
}
