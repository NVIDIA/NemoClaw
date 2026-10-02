// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createCanonicalCliFixture, runOpenclaw } from "./auto-pair-settlement-fixture";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");
const APPROVAL_POLICY = path.resolve(
  import.meta.dirname,
  "../../../../scripts/lib/openclaw_device_approval_policy.py",
);

function heredoc(source: string, marker: string): string {
  const match = source.match(new RegExp(`<<'${marker}'[^\\n]*\\n([\\s\\S]*?)\\n${marker}`));
  return match?.[1] ?? "";
}

function buildAutoPairScript(tmpDir: string): string {
  const policy = path.join(tmpDir, "openclaw_device_approval_policy.py");
  fs.copyFileSync(APPROVAL_POLICY, policy);
  fs.chmodSync(policy, 0o444);
  return heredoc(fs.readFileSync(START_SCRIPT, "utf8"), "PYAUTOPAIR")
    .replace(
      "APPROVAL_POLICY_FILE = '/usr/local/lib/nemoclaw/openclaw_device_approval_policy.py'",
      `APPROVAL_POLICY_FILE = ${JSON.stringify(policy)}`,
    )
    .replaceAll("time.time()", "_nemoclaw_test_time()")
    .replaceAll("time.sleep(", "_nemoclaw_test_sleep(")
    .replace(
      "import time",
      `import time
_nemoclaw_test_clock = [time.time()]
_nemoclaw_test_time = lambda: _nemoclaw_test_clock[0]
def _nemoclaw_test_sleep(seconds): _nemoclaw_test_clock.__setitem__(0, _nemoclaw_test_clock[0] + min(max(float(seconds), 0), 0.25))
`,
    );
}

describe("nemoclaw-start persisted admin pairing settlement", () => {
  it("recognizes an exact admin-upgraded canonical CLI without approving it again", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-admin-settled-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const stateDir = path.join(tmpDir, "state");
    const canonicalCli = createCanonicalCliFixture(stateDir);
    canonicalCli.scopes = ["operator.admin", "operator.pairing", "operator.write"];
    canonicalCli.approvedScopes = ["operator.admin", "operator.pairing", "operator.write"];
    canonicalCli.tokens.operator.scopes = [
      "operator.admin",
      "operator.pairing",
      "operator.read",
      "operator.write",
    ];
    const settled = JSON.stringify({ pending: [], paired: [canonicalCli] });
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\n' ${JSON.stringify(settled)}
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const run = await runOpenclaw("python3", ["-c", buildAutoPairScript(tmpDir)], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_BIN: fakeOpenclaw,
          OPENCLAW_STATE_DIR: stateDir,
          NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1",
          NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "0.1",
        },
        timeout: 10_000,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(
        "[auto-pair] canonical CLI baseline settled; entering slow-mode approvals=0",
      );
      expect(run.stdout).not.toContain("approved request=");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15_000);
});
