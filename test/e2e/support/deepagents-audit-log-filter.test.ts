// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { describe, expect, it } from "vitest";

const script = fs.readFileSync(
  "test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
  "utf8",
);
const filter = script.match(/^openshell_audit_logs_since_epoch\(\) \{[\s\S]*?^\}/mu)?.[0];

describe("Deep Agents rejection-interval audit evidence", () => {
  it.each([
    ["success", "AUDIT_LOG_READ:1\n[101.5] NET:OPEN retained\ncontinuation\n"],
    ["read-failure", "AUDIT_LOG_READ:0\n"],
    ["filter-failure", "AUDIT_LOG_READ:0\n"],
  ])("reports extraction success only after reading and filtering logs (%s)", (mode, expected) => {
    expect(filter).toBeDefined();
    const result = spawnSync(
      "bash",
      [
        "-c",
        `${filter}
openshell() {
  if [ "$MODE" = read-failure ]; then return 7; fi
  printf '%s\\n' '[99.1] earlier request' 'earlier continuation' '[101.5] NET:OPEN retained' 'continuation'
}
if [ "$MODE" = filter-failure ]; then
  awk() { return 2; }
fi
openshell_audit_logs_since_epoch 100
`,
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, SANDBOX_NAME: "test-sandbox", MODE: mode },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trimEnd()).toBe(expected.trimEnd());
  });
});
