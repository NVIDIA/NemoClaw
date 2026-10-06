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
const auditAssertion = script.match(
  /^assert_no_rejected_interval_audit_logs\(\) \{[\s\S]*?^\}/mu,
)?.[0];
const auditPatterns = script
  .split("\n")
  .filter((line) => line.startsWith("AUDIT_"))
  .join("\n");
const execRelay =
  "[1791329839.209] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] [msg:ssh relay open (channel_id=f33398ff-9ceb-421d-9de5-cb4d6b18ab15, target=unix:/run/openshell/ssh.sock)]";

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

  it.each([
    [execRelay, 0],
    [`${execRelay}\n[1791329839.210] NET:OPEN inference.local`, 1],
    ["[1791329839.210] NET:OPEN unknown destination", 1],
    [execRelay.replace("unix:/run/openshell/ssh.sock", "tcp:example.com:443"), 1],
    [execRelay.replace("ssh.sock", "ssh.sock.other"), 1],
    [`${execRelay} inference.local`, 1],
    [`${execRelay}\nsecret-fixture`, 1],
    [`NET:OPEN inference.local\n${"audit continuation\n".repeat(6000)}`, 1],
    [`secret-fixture\n${"audit continuation\n".repeat(6000)}`, 1],
  ])("distinguishes local exec transport from application egress (%s)", (logs, failures) => {
    expect(auditAssertion).toBeDefined();
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
${auditPatterns}
${auditAssertion}
FAILED=0
FAKE_SECRET=secret-fixture
fail_test() { FAILED=$((FAILED + 1)); }
pass() { :; }
assert_no_rejected_interval_audit_logs test "AUDIT_LOG_READ:1
$AUDIT_INPUT"
printf '%s' "$FAILED"
`,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, AUDIT_INPUT: logs } },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(String(failures));
  });
});
