// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

const check = path.join(
  process.cwd(),
  "test/e2e/e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
);

it.each([
  ["network event at the boundary", "[100.0] NET:OPEN inference.local", "ok", 1, "network path"],
  [
    "network continuation",
    "[100.1] audit event\n NET:OPEN inference.local",
    "ok",
    1,
    "network path",
  ],
  [
    "older network event",
    "[99.9] NET:OPEN inference.local\n old continuation\n[100.0] SAFE",
    "ok",
    0,
    "no network path",
  ],
  ["log retrieval failure", "unavailable", "fetch-failure", 1, "could not be read"],
  ["parser failure", "[100.0] NET:OPEN inference.local", "parser-failure", 1, "could not be read"],
])("handles %s in the Deep Agents audit check", (_name, logs, mode, status, message) => {
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
openshell() {
  printf '%s\\n' "$AUDIT_FIXTURE"
  [ "$AUDIT_MODE" != fetch-failure ]
}
awk() {
  if [ "$AUDIT_MODE" = parser-failure ]; then return 2; fi
  command awk "$@"
}
source "$1"
`,
      "audit-test",
      check,
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        NEMOCLAW_E2E_SECRET_BOUNDARY_SELF_TEST: "audit-logs",
        AUDIT_FIXTURE: logs,
        AUDIT_MODE: mode,
      },
    },
  );
  expect(result.status, result.stderr).toBe(status);
  expect(`${result.stdout}\n${result.stderr}`).toContain(message);
});
