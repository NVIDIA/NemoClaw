// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createHostProcessWorkspace } from "../../helpers/host-process-harness.ts";

const check = fileURLToPath(
  new URL(
    "../e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
    import.meta.url,
  ),
);

const sshRelay =
  "[100.123] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] " +
  "[msg:ssh relay open (channel_id=4e2ee00f-aedb-42f2-9c61-5353208239b8, target=unix:/run/openshell/ssh.sock)]";

it.each([
  ["the sandbox exec SSH relay", sshRelay, "ok", 0, "no network path"],
  [
    "an outbound event after the SSH relay",
    `${sshRelay}\n[100.124] NET:OPEN inference.local`,
    "ok",
    1,
    "network path",
  ],
  [
    "a network continuation after the SSH relay",
    `${sshRelay}\n NET:OPEN inference.local`,
    "ok",
    1,
    "network path",
  ],
  ["another Unix socket", sshRelay.replace("ssh.sock", "other.sock"), "ok", 1, "network path"],
  [
    "a TCP relay",
    sshRelay
      .replace("ssh relay", "tcp relay")
      .replace("unix:/run/openshell/ssh.sock", "127.0.0.1:443"),
    "ok",
    1,
    "network path",
  ],
  ["an unexpected log source", sshRelay.replace("[sandbox]", "[gateway]"), "ok", 1, "network path"],
  ["an extended relay record", `${sshRelay} inference.local`, "ok", 1, "network path"],
  [
    "a credential next to the relay record",
    `${sshRelay}\n[100.124] sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000`,
    "ok",
    1,
    "raw fake secret leaked",
  ],
  ["network event at the boundary", "[100.123] NET:OPEN inference.local", "ok", 1, "network path"],
  [
    "network continuation",
    "[100.124] audit event\n NET:OPEN inference.local",
    "ok",
    1,
    "network path",
  ],
  [
    "older network event",
    "[100.122] NET:OPEN inference.local\n old continuation\n[100.123] SAFE",
    "ok",
    0,
    "no network path",
  ],
  ["missing end fence", "[100.123] SAFE", "missing-fence", 1, "could not be read"],
  ["missing start coverage", "[100.124] SAFE", "missing-start", 1, "could not be read"],
  ["truncated page", Array(500).fill("[100.124] SAFE").join("\n"), "ok", 1, "could not be read"],
  ["late delivery", "[100.124] SAFE", "delayed", 0, "no network path"],
  ["late network event", "[100.124] NET:OPEN inference.local", "delayed", 1, "network path"],
  ["invalid timestamp", "[100.124] SAFE", "bad-time", 1, "could not be read"],
  ["reversed interval", "[100.124] SAFE", "reverse-time", 1, "could not be read"],
  ["log retrieval failure", "unavailable", "fetch-failure", 1, "could not be read"],
  [
    "parser failure",
    "[100.123] NET:OPEN inference.local",
    "parser-failure",
    1,
    "could not be read",
  ],
])("handles %s in the Deep Agents audit check", (_name, logs, mode, status, message) => {
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `
openshell() {
  if [ "$AUDIT_MODE" = delayed ] && [ -z "\${AUDIT_RETRY:-}" ]; then
    printf '%s\\n' "$AUDIT_BEFORE"
    return 0
  fi
  if [ "$AUDIT_MODE" != missing-start ]; then printf '%s\\n' "$AUDIT_BEFORE"; fi
  printf '%s\\n' "$AUDIT_FIXTURE"
  if [ "$AUDIT_MODE" != missing-fence ]; then printf '%s\\n' "$AUDIT_AFTER"; fi
  [ "$AUDIT_MODE" != fetch-failure ]
}
sleep() { export AUDIT_RETRY=1; }
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
        PATH: "/usr/bin:/bin",
        NEMOCLAW_E2E_SECRET_BOUNDARY_SELF_TEST: "audit-logs",
        AUDIT_FIXTURE: logs,
        AUDIT_MODE: mode,
        AUDIT_BEFORE: sshRelay.replace("100.123", "100.122"),
        AUDIT_AFTER: sshRelay.replace("100.123", "100.457"),
        AUDIT_TEST_START: mode === "bad-time" ? "100" : "100.123",
        AUDIT_TEST_END: mode === "reverse-time" ? "100.122" : "100.456",
      },
    },
  );
  expect(result.status, result.stderr).toBe(status);
  expect(`${result.stdout}\n${result.stderr}`).toContain(message);
});

it("captures sandbox timestamps around each secret probe and preserves its exit status", () => {
  const fixture = createHostProcessWorkspace("dcode-probe-timestamps-");
  try {
    fixture.writeExecutable(
      "date",
      '#!/bin/sh\n[ "$1" = +%s.%3N ] || exit 2\nprintf "100.123\\n"\n',
    );
    fixture.writeExecutable(
      "dcode",
      '#!/bin/sh\nprintf "refusing to start: OPENAI_API_KEY\\n"\nexit 7\n',
    );
    const result = fixture.run("/bin/bash", ["-c", 'source "$1"', "probe-test", check], {
      timeout: 5000,
      env: fixture.environment({ NEMOCLAW_E2E_SECRET_BOUNDARY_SELF_TEST: "probe-timestamps" }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/^DCODE_EXIT:7$/gm)).toHaveLength(2);
    expect(result.stdout.match(/^DCODE_AUDIT_START:100\.123$/gm)).toHaveLength(2);
    expect(result.stdout.match(/^DCODE_AUDIT_END:100\.123$/gm)).toHaveLength(2);
    expect(result.stdout).not.toContain("sk-TEST-FAKE");
  } finally {
    fixture.remove();
  }
});
