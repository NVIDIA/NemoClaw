// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const check = fileURLToPath(
  new URL(
    "../e2e-cloud-experimental/checks/08-deepagents-code-secret-boundary.sh",
    import.meta.url,
  ),
);

const sshRelay =
  "[100.0] [sandbox] [OCSF ] [ocsf] NET:OPEN [INFO] " +
  "[msg:ssh relay open (channel_id=4e2ee00f-aedb-42f2-9c61-5353208239b8, target=unix:/run/openshell/ssh.sock)]";

it.each([
  ["the sandbox exec SSH relay", sshRelay, "ok", 0, "no network path"],
  [
    "an outbound event after the SSH relay",
    `${sshRelay}\n[100.1] NET:OPEN inference.local`,
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
    `${sshRelay}\n[100.1] sk-TEST-FAKE-DO-NOT-USE-0000000000000000000000`,
    "ok",
    1,
    "raw fake secret leaked",
  ],
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
    "/bin/bash",
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
        PATH: "/usr/bin:/bin",
        NEMOCLAW_E2E_SECRET_BOUNDARY_SELF_TEST: "audit-logs",
        AUDIT_FIXTURE: logs,
        AUDIT_MODE: mode,
      },
    },
  );
  expect(result.status, result.stderr).toBe(status);
  expect(`${result.stdout}\n${result.stderr}`).toContain(message);
});
