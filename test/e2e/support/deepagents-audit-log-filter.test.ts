// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { describe, expect, it, onTestFinished } from "vitest";
import { createHostProcessWorkspace } from "../../helpers/host-process-harness.ts";

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
// The complete Linux check uses Bash's @Q expansion, unavailable in macOS Bash 3.
const supportsParameterQuoting =
  spawnSync("bash", ["-c", 'value=probe; printf "%s" "${value@Q}"']).status === 0;

describe("Deep Agents rejection-interval audit evidence", () => {
  it.runIf(supportsParameterQuoting).each([
    ["earlier-inference", 0],
    ["runtime-egress", 1],
    ["env-egress", 1],
    ["runtime-secret", 1],
    ["env-secret", 1],
  ])("runs both rejection intervals with correctly scoped audit records (%s)", (mode, status) => {
    const workspace = createHostProcessWorkspace("dcode-audit-interval-");
    onTestFinished(() => workspace.remove());
    const check = workspace.path("check.sh");
    fs.writeFileSync(check, script);
    workspace.writeExecutable(
      "date",
      `#!${process.execPath}
const fs = require("node:fs");
const root = process.env.CASE_ROOT;
const format = process.argv[2];
if (format === "+%s%N") { console.log("100123456789"); process.exit(0); }
const counter = root + "/clock-count";
const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(count + 1));
const now = 100.9 + count;
if (format === "+%s.%3N") console.log(now.toFixed(3));
else if (format === "+%s") console.log(Math.floor(now));
else process.exit(97);
`,
    );
    workspace.writeExecutable(
      "openshell",
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const root = process.env.CASE_ROOT;
if (args[0] === "settings") process.exit(0);
if (args[0] === "logs") {
  const counter = root + "/audit-count";
  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(count + 1));
  const phase = count === 0 ? "runtime" : "env";
  const start = 100.9 + count;
  console.log("[100.100] NET:OPEN inference.local:443");
  console.log(${JSON.stringify(execRelay)}.replace("1791329839.209", (start + 0.01).toFixed(3)));
  if (process.env.AUDIT_CASE === phase + "-egress")
    console.log("[" + (start + 0.05).toFixed(3) + "] NET:OPEN inference.local:443");
  if (process.env.AUDIT_CASE === phase + "-secret")
    console.log("[" + (start + 0.05).toFixed(3) + "] sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000");
  process.exit(0);
}
if (args[0] !== "sandbox") process.exit(97);
const command = args.at(-1);
if (command.includes("DCODE_EXIT:")) console.log("refusing to start: OPENAI_API_KEY\\nDCODE_EXIT:1");
else if (command.includes("LOG_MARKER_FOUND:")) console.log("LOG_MARKER_FOUND:1");
else if (command.includes("sha256sum")) console.log("unchanged-env-hash");
else if (command.startsWith("cp ")) fs.writeFileSync(root + "/env-restored", "yes");
else if (!command.startsWith("test ") && !command.startsWith("for log ") &&
         !command.startsWith("mkdir ") && !command.startsWith("printf ")) process.exit(97);
`,
    );
    const result = workspace.run("bash", [check], {
      timeout: 10_000,
      env: workspace.environment({
        CASE_ROOT: workspace.root,
        AUDIT_CASE: mode,
        SANDBOX_NAME: "fixture",
      }),
    });
    expect(result.status, result.output).toBe(status);
    expect(result.output).toContain(`${8 - status} passed, ${status} failed`);
    expect(fs.readFileSync(workspace.path("audit-count"), "utf8")).toBe("2");
    expect(fs.readFileSync(workspace.path("env-restored"), "utf8")).toBe("yes");
  });

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
