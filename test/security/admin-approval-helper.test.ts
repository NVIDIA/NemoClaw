// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { adminApprovalConnectScript } from "../e2e/fixtures/admin-approval-connect.ts";
import { ADMIN_REQUEST_SELECTOR_PY } from "../e2e/fixtures/admin-request-selector.ts";
import {
  pendingAdminRequestId,
  preApprovalAdminProbeEvidence,
} from "../e2e/fixtures/issue-4462-admin-approval-evidence.ts";

const EXPECTED_REQUEST_ID = "12345678-1234-4123-8123-123456789abc";
const VERSION_ONE_REQUEST_ID = "12345678-1234-1123-8123-123456789abc";
const EXPECTED_PUBLIC_KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_value, index) => index));
const EXPECTED_PUBLIC_KEY = EXPECTED_PUBLIC_KEY_BYTES.toString("base64url");
const EXPECTED_DEVICE_ID = createHash("sha256").update(EXPECTED_PUBLIC_KEY_BYTES).digest("hex");
const OTHER_PUBLIC_KEY_BYTES = Buffer.from(
  Array.from({ length: 32 }, (_value, index) => index + 32),
);
const OTHER_PUBLIC_KEY = OTHER_PUBLIC_KEY_BYTES.toString("base64url");
const OTHER_DEVICE_ID = createHash("sha256").update(OTHER_PUBLIC_KEY_BYTES).digest("hex");
const EXPECTED_IDENTITY = { deviceId: EXPECTED_DEVICE_ID, publicKey: EXPECTED_PUBLIC_KEY };
const PAIRING_STATE_HELPER_PY = `import json
from pathlib import Path

def read_openclaw_pairing_state(state_dir, timeout=1):
    fixture_path = Path(state_dir) / "pairing-state.json"
    records = json.loads(fixture_path.read_text(encoding="utf-8")) if fixture_path.exists() else {}
    return records, {"stateDir": state_dir, "timeout": timeout}
`;

type FakeFailureCommand = "devices:list" | "devices:approve" | "cron:add" | "cron:run";

function adminState(
  tokenShape: "array" | "object" = "array",
  requestId = EXPECTED_REQUEST_ID,
): Record<string, unknown> {
  const operatorToken = {
    role: "operator",
    scopes: ["operator.pairing", "operator.read", "operator.write"],
  };
  return {
    pending: [
      {
        requestId,
        deviceId: EXPECTED_DEVICE_ID,
        publicKey: EXPECTED_PUBLIC_KEY,
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.pairing", "operator.read", "operator.write", "operator.admin"],
      },
    ],
    paired: [
      {
        deviceId: EXPECTED_DEVICE_ID,
        publicKey: EXPECTED_PUBLIC_KEY,
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.pairing", "operator.write"],
        approvedScopes: ["operator.pairing", "operator.write"],
        tokens: tokenShape === "array" ? [operatorToken] : { operator: operatorToken },
      },
    ],
  };
}

function writeLocalIdentity(
  root: string,
  identity: Record<string, unknown> = EXPECTED_IDENTITY,
): string {
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "pairing-state.json"), JSON.stringify({ identity }));
  return stateRoot;
}

function omitLocalIdentity(root: string, _identity: Record<string, unknown>): string {
  return path.join(root, "state");
}

function writePairingStateHelper(root: string): string {
  const helperPath = path.join(root, "openclaw_pairing_state.py");
  fs.writeFileSync(helperPath, PAIRING_STATE_HELPER_PY);
  return helperPath;
}

function runSelector(
  state: Record<string, unknown>,
  identity: Record<string, unknown> = EXPECTED_IDENTITY,
  prepareIdentity: (root: string, identity: Record<string, unknown>) => string = writeLocalIdentity,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-admin-selector-"));
  const statePath = path.join(root, "devices.json");
  const requestIdPath = path.join(root, "selected-request-id");
  const stateRoot = prepareIdentity(root, identity);
  const helperPath = writePairingStateHelper(root);
  fs.writeFileSync(statePath, JSON.stringify(state));
  try {
    const result = spawnSync("python3", ["-", statePath, requestIdPath], {
      encoding: "utf-8",
      env: {
        ...process.env,
        NEMOCLAW_OPENCLAW_PAIRING_STATE_HELPER: helperPath,
        OPENCLAW_STATE_DIR: stateRoot,
      },
      input: ADMIN_REQUEST_SELECTOR_PY,
    });
    const selectedRequestId = fs.existsSync(requestIdPath)
      ? fs.readFileSync(requestIdPath, "utf8")
      : "";
    return Object.assign(result, { selectedRequestId });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runAdminApprovalScript(
  failureCommand?: FakeFailureCommand,
  failureOutputPaddingBytes = 0,
  requestId = EXPECTED_REQUEST_ID,
): {
  commands: string[];
  capturedApprovalBytes: number;
  result: SpawnSyncReturns<string>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-admin-script-"));
  const cliPath = path.join(root, "nemoclaw");
  const openclawPath = path.join(root, "openclaw");
  const devicesPath = path.join(root, "devices.json");
  const commandLogPath = path.join(root, "openclaw.log");
  const mktempCounterPath = path.join(root, "mktemp-counter");
  const stateRoot = writeLocalIdentity(root);
  const helperPath = writePairingStateHelper(root);
  fs.writeFileSync(
    cliPath,
    `#!/bin/sh
set -eu
[ "$#" -eq 2 ] && [ "$1" = "e2e-issue-4462" ] && [ "$2" = "connect" ]
exec /bin/bash
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(root, "mktemp"),
    `#!/bin/sh
set -eu
count=0
if [ -f "$FAKE_MKTEMP_COUNTER" ]; then IFS= read -r count <"$FAKE_MKTEMP_COUNTER"; fi
count=$((count + 1))
printf '%s\n' "$count" >"$FAKE_MKTEMP_COUNTER"
output="$FAKE_MKTEMP_ROOT/capture-$count"
: >"$output"
printf '%s\n' "$output"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(root, "rm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    openclawPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_OPENCLAW_LOG"
if [ "\${FAKE_OPENCLAW_FAIL:-}" = "$1:$2" ]; then
  case "$1:$2" in
    devices:list) printf '%s\\n' 'gateway connection unavailable token=test-gateway-token device=${EXPECTED_DEVICE_ID}' >&2 ;;
    devices:approve) printf '%s\\n' 'approval denied by policy request=${EXPECTED_REQUEST_ID} publicKey=${EXPECTED_PUBLIC_KEY}' >&2 ;;
    cron:add) printf '%s\\n' 'scope upgrade pending approval cron=cron-1' >&2 ;;
    cron:run) printf '%s\\n' 'request timed out cron=cron-1' >&2 ;;
  esac
  python3 -c 'import sys; sys.stderr.buffer.write(b"x" * int(sys.argv[1]))' "$FAKE_FAILURE_OUTPUT_PADDING_BYTES"
  exit 91
fi
case "$1:$2" in
  devices:list) cat "$FAKE_DEVICES_STATE" ;;
  devices:approve) ;;
  cron:add) printf '%s\\n' '{"id":"cron-1","name":"admin-cron"}' ;;
  cron:run) printf '%s\\n' '{"ok":true,"ran":true}' ;;
  *) exit 90 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(devicesPath, JSON.stringify(adminState("array", requestId)));
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ""}`,
    FAKE_DEVICES_STATE: devicesPath,
    FAKE_OPENCLAW_FAIL: failureCommand ?? "",
    FAKE_OPENCLAW_LOG: commandLogPath,
    FAKE_FAILURE_OUTPUT_PADDING_BYTES: String(failureOutputPaddingBytes),
    FAKE_MKTEMP_COUNTER: mktempCounterPath,
    FAKE_MKTEMP_ROOT: root,
    NEMOCLAW_OPENCLAW_PAIRING_STATE_HELPER: helperPath,
    OPENCLAW_STATE_DIR: stateRoot,
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "",
    OPENCLAW_GATEWAY_URL: "",
    OPENCLAW_GATEWAY_PORT: "18789",
    OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
  };
  try {
    const result = spawnSync("bash", [], {
      encoding: "utf-8",
      env: childEnv,
      input: adminApprovalConnectScript(cliPath, "e2e-issue-4462", "admin-cron"),
    });
    const commands = fs.existsSync(commandLogPath)
      ? fs.readFileSync(commandLogPath, "utf8").trim().split("\n")
      : [];
    const approvalCapturePath = path.join(root, "capture-5");
    const capturedApprovalBytes = fs.existsSync(approvalCapturePath)
      ? fs.statSync(approvalCapturePath).size
      : 0;
    return { capturedApprovalBytes, commands, result };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("prepared connect-shell administrative approval", () => {
  it.each([
    [
      "approval boundary",
      {
        exitCode: 1,
        stderr: `scope upgrade pending approval requestId=${EXPECTED_REQUEST_ID} device=${EXPECTED_DEVICE_ID}`,
        stdout: "",
        timedOut: false,
      },
      "approval-required",
    ],
    [
      "timeout",
      {
        exitCode: null,
        stderr: `request timed out token=test-gateway-token requestId=${EXPECTED_REQUEST_ID}`,
        stdout: "",
        timedOut: true,
      },
      "timeout",
    ],
    [
      "gateway failure",
      {
        exitCode: 1,
        stderr: `gateway connection unavailable token=test-gateway-token device=${EXPECTED_DEVICE_ID}`,
        stdout: "",
        timedOut: false,
      },
      "gateway-unavailable",
    ],
    [
      "unexpected success",
      { exitCode: 0, stderr: "", stdout: `cron=cron-1`, timedOut: false },
      "unexpected-success",
    ],
    [
      "unclassified command failure",
      {
        exitCode: 1,
        stderr: `command failed requestId=${EXPECTED_REQUEST_ID}`,
        stdout: "",
        timedOut: false,
      },
      "command-failed",
    ],
  ] as const)(
    "records a fixed, redacted pre-approval outcome for %s (#5324)",
    (_case, result, outcome) => {
      const evidence = preApprovalAdminProbeEvidence(result);
      const artifact = JSON.stringify(evidence);

      expect(evidence).toEqual({ outcome });
      expect(artifact).not.toContain(EXPECTED_REQUEST_ID);
      expect(artifact).not.toContain(EXPECTED_DEVICE_ID);
      expect(artifact).not.toContain(EXPECTED_PUBLIC_KEY);
      expect(artifact).not.toContain("cron-1");
      expect(artifact).not.toContain("test-gateway-token");
    },
  );

  it("bounds failed approval output while preserving the command status and diagnostic (#5324)", () => {
    const { capturedApprovalBytes, result } = runAdminApprovalScript("devices:approve", 256 * 1024);

    expect(result.status).toBe(27);
    expect(result.stderr).toContain("ADMIN_APPROVE_FAILED");
    expect(result.stderr).toContain("ADMIN_DIAGNOSTIC=authorization-rejected");
    expect(capturedApprovalBytes).toBe(65_536);
  });

  it("executes the approval sequence over native loopback (#5324)", () => {
    const { commands, result } = runAdminApprovalScript();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ISSUE_5324_ADMIN_APPROVAL_OK");
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain(EXPECTED_REQUEST_ID);
    expect(output).not.toContain(EXPECTED_DEVICE_ID);
    expect(output).not.toContain(EXPECTED_PUBLIC_KEY);
    expect(output).not.toContain("cron-1");
    expect(output).not.toContain("test-gateway-token");
    expect(commands).toEqual([
      "devices list --json",
      `devices approve ${EXPECTED_REQUEST_ID}`,
      "cron add --name admin-cron --every 2h --agent main --session isolated --message hello",
      "cron run cron-1",
    ]);
  });

  it("accepts the same non-v4 request IDs in the trigger parser and canonical selector (#5324)", () => {
    const triggeredRequestId = pendingAdminRequestId({
      exitCode: 1,
      stderr: `scope upgrade pending approval (requestId: ${VERSION_ONE_REQUEST_ID})`,
      stdout: "",
      timedOut: false,
    });
    expect(triggeredRequestId).toBe(VERSION_ONE_REQUEST_ID);

    const { commands, result } = runAdminApprovalScript(undefined, 0, VERSION_ONE_REQUEST_ID);
    expect(result.status, result.stderr).toBe(0);
    expect(commands).toContain(`devices approve ${VERSION_ONE_REQUEST_ID}`);
  });

  it.each([
    ["devices:list", 25, "ADMIN_DEVICES_LIST_FAILED", "gateway-unavailable", 1],
    ["devices:approve", 27, "ADMIN_APPROVE_FAILED", "authorization-rejected", 2],
    ["cron:add", 28, "ADMIN_CRON_RETRY_FAILED", "scope-upgrade-pending", 3],
    ["cron:run", 29, "ADMIN_CRON_RUN_FAILED", "timeout", 4],
  ] as const)(
    "reports a fixed failure classification without raw command output when %s fails (#5324)",
    (failureCommand, expectedStatus, marker, diagnostic, expectedCommandCount) => {
      const { commands, result } = runAdminApprovalScript(failureCommand);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).toBe(expectedStatus);
      expect(result.stderr).toContain(marker);
      expect(result.stderr).toContain(`ADMIN_DIAGNOSTIC=${diagnostic}`);
      expect(commands).toHaveLength(expectedCommandCount);
      expect(output).not.toContain(EXPECTED_REQUEST_ID);
      expect(output).not.toContain(EXPECTED_DEVICE_ID);
      expect(output).not.toContain(EXPECTED_PUBLIC_KEY);
      expect(output).not.toContain("cron-1");
      expect(output).not.toContain("test-gateway-token");
    },
  );

  it.each(["array", "object"] as const)(
    "accepts exact paired CLI grants, including compact device scopes [case %#] (#5324)",
    (tokenShape) => {
      const result = runSelector(adminState(tokenShape));
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.selectedRequestId).toBe(EXPECTED_REQUEST_ID);
    },
  );

  it("does not infer the distinct pairing scope while comparing approved views (#5324)", () => {
    const state = adminState("object");
    const device = (
      state.paired as Array<{
        approvedScopes: string[];
        scopes: string[];
      }>
    )[0];
    device.scopes = ["operator.write"];
    device.approvedScopes = ["operator.write"];

    const result = runSelector(state);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("approved scope arrays disagree");
  });

  it("rejects an operator.admin request from a different paired CLI identity (#5324)", () => {
    const state = adminState();
    const localDevice = (state.paired as Array<Record<string, unknown>>)[0];
    const otherDevice = {
      ...localDevice,
      deviceId: OTHER_DEVICE_ID,
      publicKey: OTHER_PUBLIC_KEY,
    };
    state.paired = [localDevice, otherDevice];
    state.pending = [
      {
        ...(state.pending as Array<Record<string, unknown>>)[0],
        deviceId: OTHER_DEVICE_ID,
        publicKey: OTHER_PUBLIC_KEY,
      },
    ];

    const result = runSelector(state);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not match the local CLI identity");
    expect(result.selectedRequestId).toBe("");
  });

  it.each(["pending", "paired"] as const)(
    "rejects malformed %s records alongside otherwise valid state (#5324)",
    (recordSet) => {
      const state = adminState();
      (state[recordSet] as unknown[]).push("malformed");

      const result = runSelector(state);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${recordSet} records must be an array of objects`);
      expect(result.selectedRequestId).toBe("");
    },
  );

  it("rejects a missing local CLI identity (#5324)", () => {
    const result = runSelector(adminState(), EXPECTED_IDENTITY, omitLocalIdentity);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be an object");
    expect(result.selectedRequestId).toBe("");
  });

  it("rejects an invalid local CLI identity binding (#5324)", () => {
    const result = runSelector(adminState(), { deviceId: "invalid", publicKey: "invalid" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("binding is invalid");
    expect(result.selectedRequestId).toBe("");
  });

  it("rejects ambiguous requests, contradictory roles, unrequested operator.admin, broad scopes, or pre-approved operator.admin (#5324)", () => {
    const ambiguous = adminState();
    (ambiguous.pending as Array<Record<string, unknown>>).push({
      ...(ambiguous.pending as Array<Record<string, unknown>>)[0],
      requestId: "87654321-4321-4321-8321-cba987654321",
    });
    const ambiguousResult = runSelector(ambiguous);
    expect(ambiguousResult.status).not.toBe(0);
    expect(ambiguousResult.stderr).toContain("exactly one pending request");

    const contradictoryRole = adminState();
    (contradictoryRole.pending as Array<{ role: string }>)[0].role = "node";
    const contradictoryRoleResult = runSelector(contradictoryRole);
    expect(contradictoryRoleResult.status).not.toBe(0);
    expect(contradictoryRoleResult.stderr).toContain("expected CLI operator");

    const unrequestedAdmin = adminState();
    const unrequestedPending = (
      unrequestedAdmin.pending as Array<{ approvedScopes?: string[]; scopes: string[] }>
    )[0];
    unrequestedPending.scopes = ["operator.pairing", "operator.read", "operator.write"];
    unrequestedPending.approvedScopes = ["operator.admin"];
    const unrequestedAdminResult = runSelector(unrequestedAdmin);
    expect(unrequestedAdminResult.status).not.toBe(0);
    expect(unrequestedAdminResult.stderr).toContain("unexpected scopes");

    const broad = adminState();
    (broad.pending as Array<{ scopes: string[] }>)[0].scopes.push("operator.superadmin");
    const broadResult = runSelector(broad);
    expect(broadResult.status).not.toBe(0);
    expect(broadResult.stderr).toContain("unexpected scopes");

    const alreadyApproved = adminState("object");
    const approvedDevice = (
      alreadyApproved.paired as Array<{
        approvedScopes: string[];
        scopes: string[];
        tokens: { operator: { scopes: string[] } };
      }>
    )[0];
    approvedDevice.scopes.push("operator.admin");
    approvedDevice.approvedScopes.push("operator.admin");
    approvedDevice.tokens.operator.scopes.push("operator.admin");
    const approvedResult = runSelector(alreadyApproved);
    expect(approvedResult.status).not.toBe(0);
    expect(approvedResult.stderr).toContain("already granted");
  });
});
