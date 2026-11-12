// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adminApprovalBody } from "../fixtures/admin-approval-connect.ts";
import { createHostProcessWorkspace } from "../../helpers/host-process-harness.ts";

describe("failed approval diagnostic deadline", () => {
  it("rejects a stalled canonical diagnostic when its configured alarm fires", () => {
    const fixture = createHostProcessWorkspace("nemoclaw-managed-admin-read-deadline-");
    const requestId = "4edc8df0-20d0-4308-b0e8-850843ae0cf4";
    try {
      const helperPath = join(fixture.root, "pairing-state-reader.py");
      const env = { NEMOCLAW_OPENCLAW_PAIRING_STATE_HELPER: helperPath };
      writeFileSync(
        helperPath,
        "import time\ndef read_openclaw_pairing_state(*args, **kwargs):\n    time.sleep(60)\n",
      );
      const program = adminApprovalBody("managed-cron")
        .split("<<'PY_ADMIN_POST_STATE'\n")[1]
        ?.split("\nPY_ADMIN_POST_STATE")[0];
      expect(program).toBeTypeOf("string");
      // Record the production budget, then accelerate only the test's OS timer.
      const timedProgram = `import json, signal
alarms = []
native_alarm = signal.alarm
def observed_alarm(seconds):
    alarms.append(seconds)
    return native_alarm(1 if seconds else 0)
signal.alarm = observed_alarm
exec(${JSON.stringify(program)})
print(json.dumps(alarms))
`;
      const result = fixture.run("python3", ["-c", timedProgram, requestId], {
        env: fixture.environment(env),
        killSignal: "SIGKILL",
        timeout: 10_000,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("ADMIN_APPROVAL_REQUEST_STATE=unavailable\n");
      expect(result.stdout).toBe("[8, 0]\n");
    } finally {
      fixture.remove();
    }
  });
});
