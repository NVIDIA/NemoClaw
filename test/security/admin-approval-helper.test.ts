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
import { exactRequestAdminApprovalConnectScript } from "../e2e/live/openclaw-admin-scope.ts";
import {
  ADMIN_APPROVAL_TEST_CLI_SH,
  ADMIN_APPROVAL_TEST_OPENSHELL_SH,
  ADMIN_APPROVAL_TEST_PTY_PY,
  removeStagedAdminScript,
} from "../support/admin-approval-connect-fixture.ts";
import {
  pendingAdminRequestId,
  preApprovalAdminProbeEvidence,
} from "../e2e/fixtures/issue-4462-admin-approval-evidence.ts";

const COMPLETED_CRON_RUN = {
  ok: true,
  enqueued: true,
  runId: "run-1",
  completed: true,
  status: "ok",
  completionStatus: "succeeded",
  run: {
    jobId: "cron-1",
    runId: "run-1",
    action: "finished",
    status: "ok",
    completionStatus: "succeeded",
  },
};

const FAILED_CRON_RUN = {
  ...COMPLETED_CRON_RUN,
  status: "error",
  completionStatus: "failed",
  run: { ...COMPLETED_CRON_RUN.run, status: "error", completionStatus: "failed" },
};

const EXPECTED_REQUEST_ID = "12345678-1234-4123-8123-123456789abc";
const VERSION_ONE_REQUEST_ID = "12345678-1234-1123-8123-123456789abc";
const EXPECTED_OPENSHELL_ARGS = [
  "sandbox",
  "exec",
  "--name",
  "e2e-issue-4462",
  "-g",
  "nemoclaw",
  "--tty",
  "--",
  "/bin/bash",
  "-i",
];
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

function writePairingStateHelper(root: string, source = PAIRING_STATE_HELPER_PY): string {
  const helperPath = path.join(root, "openclaw_pairing_state.py");
  fs.writeFileSync(helperPath, source);
  return helperPath;
}

function runSelector(
  state: Record<string, unknown>,
  identity: Record<string, unknown> = EXPECTED_IDENTITY,
  prepareIdentity: (root: string, identity: Record<string, unknown>) => string = writeLocalIdentity,
  pairingHelperSource = PAIRING_STATE_HELPER_PY,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-admin-selector-"));
  const statePath = path.join(root, "devices.json");
  const requestIdPath = path.join(root, "selected-request-id");
  const stateRoot = prepareIdentity(root, identity);
  const helperPath = writePairingStateHelper(root, pairingHelperSource);
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
  options: {
    expectedRequestId?: string;
    verifyCronConsumer?: boolean;
    cronRunOutput?: string;
    cronRunError?: string;
    cronRunExitCode?: number;
    terminal?: boolean;
    cleanupFails?: boolean;
    removeCaptures?: boolean;
    diagnosticFails?: boolean;
    tamperScript?: boolean;
    requireNonInteractiveBody?: boolean;
    omitPreparedWrapper?: boolean;
    pendingRequestIds?: readonly string[];
    selectExpectedRequest?: boolean;
  } = {},
): {
  commands: string[];
  capturedApprovalBytes: number;
  capturedCronBytes: number;
  privateCaptureCount: number;
  failureOutputDrained: boolean;
  privateCapturesRemaining: string[];
  openshellArgs: string[];
  stagedScriptRetained: boolean;
  result: SpawnSyncReturns<string>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-admin-script-"));
  const cliPath = path.join(root, "nemoclaw");
  const openshellPath = path.join(root, "openshell");
  const openclawPath = path.join(root, "openclaw");
  const devicesPath = path.join(root, "devices.json");
  const commandLogPath = path.join(root, "openclaw.log");
  const openshellArgvLogPath = path.join(root, "openshell-argv.log");
  const mktempCounterPath = path.join(root, "mktemp-counter");
  const stagedScriptReceipt = path.join(root, "staged-script");
  fs.writeFileSync(
    path.join(root, "python3"),
    `#!/bin/sh
if [ "$FAKE_ADMIN_DIAGNOSTIC_FAIL" = 1 ] && [ "$#" -eq 4 ] && [ "$3" = cron-run ]; then exit 97; fi
exec "$FAKE_REAL_PYTHON" "$@"
`,
    { mode: 0o755 },
  );
  const stateRoot = writeLocalIdentity(root);
  const helperPath = writePairingStateHelper(root);
  const terminalProbe = path.join(root, "terminal-probe.py");
  fs.writeFileSync(terminalProbe, ADMIN_APPROVAL_TEST_PTY_PY);
  const terminalRc = path.join(root, "connect.bashrc");
  fs.writeFileSync(
    terminalRc,
    `trap 'printf "ADMIN_CONNECT_SHELL_CLEANED\\n"' EXIT
openclaw() {
  case "$ADMIN_REQUIRE_NONINTERACTIVE_BODY:$-" in 1:*i*) return 95 ;; esac
  local approval_errexit=0 approval_status=0
  case $- in *e*) approval_errexit=1 ;; esac
  set +e
  (unset OPENCLAW_GATEWAY_TOKEN; ADMIN_CONNECT_WRAPPER_USED=1 command openclaw "$@")
  approval_status=$?
  if [ "$approval_errexit" = 1 ]; then set -e; else set +e; fi
  return "$approval_status"
}
${options.omitPreparedWrapper ? "unset -f openclaw" : ""}
`,
  );
  fs.writeFileSync(cliPath, ADMIN_APPROVAL_TEST_CLI_SH, { mode: 0o755 });
  fs.writeFileSync(openshellPath, ADMIN_APPROVAL_TEST_OPENSHELL_SH, { mode: 0o755 });
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
  fs.writeFileSync(
    path.join(root, "rm"),
    `#!/bin/sh
if [ "$#" -eq 3 ] && [ "$2" = -- ]; then
  printf '%s' "$3" >"$FAKE_ADMIN_SCRIPT_RECEIPT"
  if [ "$FAKE_ADMIN_CLEANUP_FAIL" = 1 ]; then exit 91; fi
  exec /bin/rm "$@"
fi
if [ "$FAKE_REMOVE_CAPTURES" = 1 ]; then exec /bin/rm "$@"; fi
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    openclawPath,
    `#!/bin/sh
set -eu
if [ -n "\${ADMIN_CONNECT_TERMINAL_PROBE:-}" ] && [ "\${ADMIN_CONNECT_WRAPPER_USED:-}" != 1 ]; then exit 94; fi
printf '%s\\n' "$*" >> "$FAKE_OPENCLAW_LOG"
if [ "\${FAKE_OPENCLAW_FAIL:-}" = "$1:$2" ]; then
  case "$1:$2" in
    devices:list) printf '%s\\n' 'gateway connection unavailable token=test-gateway-token device=${EXPECTED_DEVICE_ID}' >&2 ;;
    devices:approve) printf '%s\\n' 'approval denied by policy request=${EXPECTED_REQUEST_ID} publicKey=${EXPECTED_PUBLIC_KEY}' >&2 ;;
    cron:add) printf '%s\\n' 'scope upgrade pending approval cron=cron-1' >&2 ;;
    cron:run) printf '%s\\n' "$FAKE_CRON_RUN_ERROR" >&2 ;;
  esac
  python3 -c 'import sys; sys.stderr.buffer.write(b"x" * int(sys.argv[1]))' "$FAKE_FAILURE_OUTPUT_PADDING_BYTES"
  : >"$FAKE_FAILURE_OUTPUT_DRAINED"
  exit 91
fi
case "$1:$2" in
  devices:list) cat "$FAKE_DEVICES_STATE" ;;
  devices:approve) ;;
  cron:add) printf '%s\\n' '{"id":"cron-1","name":"admin-cron"}' ;;
  cron:run) printf '%s\\n' "$FAKE_CRON_RUN_OUTPUT"; exit "$FAKE_CRON_RUN_EXIT_CODE" ;;
  *) exit 90 ;;
esac
`,
    { mode: 0o755 },
  );
  const devicesState = adminState("array", requestId);
  const pending = (devicesState.pending as Array<Record<string, unknown>>)[0];
  devicesState.pending = (options.pendingRequestIds ?? [requestId]).map((pendingRequestId) => ({
    ...pending,
    requestId: pendingRequestId,
  }));
  fs.writeFileSync(devicesPath, JSON.stringify(devicesState));
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ""}`,
    FAKE_DEVICES_STATE: devicesPath,
    FAKE_OPENCLAW_FAIL: failureCommand ?? "",
    FAKE_OPENCLAW_LOG: commandLogPath,
    FAKE_CRON_RUN_OUTPUT: options.cronRunOutput ?? JSON.stringify(COMPLETED_CRON_RUN),
    FAKE_CRON_RUN_ERROR: options.cronRunError ?? "request timed out cron=cron-1",
    FAKE_CRON_RUN_EXIT_CODE: String(options.cronRunExitCode ?? 0),
    FAKE_OPENSHELL_ARGV_LOG: openshellArgvLogPath,
    FAKE_FAILURE_OUTPUT_PADDING_BYTES: String(failureOutputPaddingBytes),
    FAKE_FAILURE_OUTPUT_DRAINED: path.join(root, "failure-output-drained"),
    FAKE_MKTEMP_COUNTER: mktempCounterPath,
    FAKE_MKTEMP_ROOT: root,
    NEMOCLAW_OPENCLAW_PAIRING_STATE_HELPER: helperPath,
    OPENCLAW_STATE_DIR: stateRoot,
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "",
    OPENCLAW_GATEWAY_URL: "",
    OPENCLAW_GATEWAY_PORT: "18789",
    OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
    ADMIN_CONNECT_TERMINAL_PROBE: options.terminal ? terminalProbe : "",
    ADMIN_CONNECT_RC: terminalRc,
    ADMIN_TAMPER_SCRIPT: options.tamperScript ? "1" : "0",
    ADMIN_REQUIRE_NONINTERACTIVE_BODY: options.requireNonInteractiveBody ? "1" : "0",
    FAKE_ADMIN_SCRIPT_RECEIPT: stagedScriptReceipt,
    FAKE_ADMIN_CLEANUP_FAIL: options.cleanupFails ? "1" : "0",
    FAKE_REMOVE_CAPTURES: options.removeCaptures ? "1" : "0",
    FAKE_ADMIN_DIAGNOSTIC_FAIL: options.diagnosticFails ? "1" : "0",
    FAKE_REAL_PYTHON: spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
    }).stdout.trim(),
  };
  try {
    const result = spawnSync("bash", [], {
      encoding: "utf-8",
      env: childEnv,
      input: options.selectExpectedRequest
        ? exactRequestAdminApprovalConnectScript(
            cliPath,
            "e2e-issue-4462",
            "admin-cron",
            options.expectedRequestId ?? requestId,
            options.verifyCronConsumer,
            { gatewayName: "nemoclaw", openshellPath },
          )
        : adminApprovalConnectScript(
            cliPath,
            "e2e-issue-4462",
            "admin-cron",
            options.expectedRequestId,
            options.verifyCronConsumer,
          ),
    });
    const commands = fs.existsSync(commandLogPath)
      ? fs.readFileSync(commandLogPath, "utf8").trim().split("\n")
      : [];
    const approvalCapturePath = path.join(root, "capture-5");
    const capturedApprovalBytes = fs.existsSync(approvalCapturePath)
      ? fs.statSync(approvalCapturePath).size
      : 0;
    const openshellArgs = fs.existsSync(openshellArgvLogPath)
      ? fs.readFileSync(openshellArgvLogPath, "utf8").trim().split("\n")
      : [];
    const stagedScriptRetained =
      fs.existsSync(stagedScriptReceipt) &&
      fs.existsSync(fs.readFileSync(stagedScriptReceipt, "utf8"));
    const cronCapturePath = path.join(root, "capture-8");
    const capturedCronBytes = fs.existsSync(cronCapturePath)
      ? fs.statSync(cronCapturePath).size
      : 0;
    const privateCapturesRemaining = fs
      .readdirSync(root)
      .filter((name) => name.startsWith("capture-"));
    const privateCaptureCount = fs.existsSync(mktempCounterPath)
      ? Number(fs.readFileSync(mktempCounterPath, "utf8"))
      : 0;
    const failureOutputDrained = fs.existsSync(path.join(root, "failure-output-drained"));
    return {
      capturedApprovalBytes,
      capturedCronBytes,
      privateCaptureCount,
      privateCapturesRemaining,
      failureOutputDrained,
      commands,
      openshellArgs,
      result,
      stagedScriptRetained,
    };
  } finally {
    removeStagedAdminScript(stagedScriptReceipt);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("prepared connect-shell administrative approval", () => {
  it("refuses approval when the prepared OpenClaw wrapper is missing", () => {
    const { result, commands, stagedScriptRetained } = runAdminApprovalScript(
      undefined,
      0,
      EXPECTED_REQUEST_ID,
      { terminal: true, omitPreparedWrapper: true },
    );
    expect(result.status).toBe(1);
    expect(commands).toEqual([]);
    expect(result.stdout).toContain("ADMIN_CONNECT_BODY_STATUS=1");
    expect(result.stdout).toContain("ADMIN_CONNECT_STATUS=1");
    expect(result.stdout).toContain("ADMIN_CONNECT_SHELL_CLEANED");
    expect(stagedScriptRetained).toBe(false);
  });
  it("runs verified approval in a non-interactive interpreter with the prepared wrapper", () => {
    const { result, commands, stagedScriptRetained } = runAdminApprovalScript(
      undefined,
      0,
      EXPECTED_REQUEST_ID,
      { terminal: true, requireNonInteractiveBody: true },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`.slice(-2_000)).toBe(0);
    expect(commands).toContain(`devices approve ${EXPECTED_REQUEST_ID}`);
    expect(result.stdout).toContain("ADMIN_CONNECT_SHELL_CLEANED");
    expect(stagedScriptRetained).toBe(false);
  });
  it("rejects a replaced script before running approval in the prepared shell", () => {
    const { result, commands, stagedScriptRetained } = runAdminApprovalScript(
      undefined,
      0,
      EXPECTED_REQUEST_ID,
      {
        terminal: true,
        tamperScript: true,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ADMIN_SCRIPT_INTEGRITY_FAILED");
    expect(result.stdout).not.toContain("ADMIN_TAMPER_EXECUTED");
    expect(commands).toEqual([]);
    expect(stagedScriptRetained).toBe(false);
  });
  it("fails when the transferred approval script cannot be removed", () => {
    const { result, stagedScriptRetained } = runAdminApprovalScript(
      undefined,
      0,
      EXPECTED_REQUEST_ID,
      {
        cleanupFails: true,
      },
    );
    expect(result.status).toBe(32);
    expect(result.stdout).toContain("ISSUE_5324_ADMIN_APPROVAL_OK");
    expect(result.stderr).toContain("ADMIN_SCRIPT_CLEANUP_FAILED");
    expect(stagedScriptRetained).toBe(true);
  });
  it.each([
    [undefined, true],
    ["devices:approve", true],
    [undefined, false],
  ] as const)(
    "preserves connect-shell wrappers and approval status through a terminal (%s, cron=%s)",
    (failureCommand, verifyCronConsumer) => {
      const { commands, result, stagedScriptRetained } = runAdminApprovalScript(
        failureCommand,
        0,
        EXPECTED_REQUEST_ID,
        {
          terminal: true,
          verifyCronConsumer,
        },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`.slice(-2_000)).toBe(
        failureCommand ? 27 : 0,
      );
      expect(result.stdout).toContain("ADMIN_CONNECT_SHELL_CLEANED");
      expect(commands).toContain(`devices approve ${EXPECTED_REQUEST_ID}`);
      expect(result.stdout.includes("ISSUE_5324_ADMIN_APPROVAL_OK")).toBe(!failureCommand);
      const stagedScript = result.stdout.match(
        /(\/tmp\/nemoclaw-admin-approval-[a-zA-Z0-9_]+[.]sh)/,
      )?.[1];
      expect(stagedScript).toBeDefined();
      expect(fs.existsSync(stagedScript!)).toBe(false);
      expect(stagedScriptRetained).toBe(false);
    },
  );

  it("approves the captured request when another request remains pending", () => {
    const staleRequestId = "87654321-4321-4321-8321-cba987654321";
    const { commands, openshellArgs, result } = runAdminApprovalScript(
      undefined,
      0,
      EXPECTED_REQUEST_ID,
      {
        expectedRequestId: EXPECTED_REQUEST_ID,
        pendingRequestIds: [staleRequestId, EXPECTED_REQUEST_ID],
        selectExpectedRequest: true,
        verifyCronConsumer: false,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(openshellArgs).toEqual(EXPECTED_OPENSHELL_ARGS);
    expect(commands).toEqual(["devices list --json", `devices approve ${EXPECTED_REQUEST_ID}`]);
    expect(result.stdout).toContain("ISSUE_5324_ADMIN_APPROVAL_OK");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(staleRequestId);
  });
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
    expect(result.stderr).not.toContain("ADMIN_CRON_");
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain(EXPECTED_REQUEST_ID);
    expect(output).not.toContain(EXPECTED_DEVICE_ID);
    expect(output).not.toContain(EXPECTED_PUBLIC_KEY);
    expect(output).not.toContain("cron-1");
    expect(output).not.toContain("test-gateway-token");
    expect(commands).toEqual([
      "devices list --json",
      `devices approve ${EXPECTED_REQUEST_ID}`,
      "cron add --name admin-cron --every 2h --agent main --session isolated --message Respond with a short greeting. --no-deliver",
      "cron run cron-1 --wait --wait-timeout 2m --timeout 10000",
    ]);
  });

  it.each([
    ["enqueue only", { ok: true, enqueued: true, runId: "run-1" }],
    ["legacy run acknowledgement", { ok: true, ran: true }],
    ["unfinished run", { ...COMPLETED_CRON_RUN, completed: false }],
    ["missing run identity", { ...COMPLETED_CRON_RUN, runId: undefined }],
    ["wrong job", { ...COMPLETED_CRON_RUN, run: { ...COMPLETED_CRON_RUN.run, jobId: "other" } }],
    ["wrong run", { ...COMPLETED_CRON_RUN, run: { ...COMPLETED_CRON_RUN.run, runId: "other" } }],
    ["failed completion", { ...COMPLETED_CRON_RUN, completionStatus: "failed" }],
    ["skipped run", { ...COMPLETED_CRON_RUN, status: "skipped" }],
    [
      "nested failed run with outer success",
      { ...COMPLETED_CRON_RUN, run: { ...COMPLETED_CRON_RUN.run, status: "error" } },
    ],
    [
      "nested skipped completion with outer success",
      { ...COMPLETED_CRON_RUN, run: { ...COMPLETED_CRON_RUN.run, completionStatus: "skipped" } },
    ],
    ["missing completion record", { ...COMPLETED_CRON_RUN, run: null }],
  ])("rejects %s before reporting approval success (#13342)", (_case, response) => {
    const { commands, result, stagedScriptRetained } = runAdminApprovalScript(
      undefined,
      0,
      EXPECTED_REQUEST_ID,
      { cronRunOutput: JSON.stringify(response) },
    );
    expect(result.status).toBe(30);
    expect(result.stderr).toContain("ADMIN_CRON_RUN_RESULT_INVALID");
    expect(result.stdout).not.toContain("ISSUE_5324_ADMIN_APPROVAL_OK");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/cron-1|run-1|test-gateway-token/);
    expect(commands.filter((command) => command.startsWith("cron run "))).toHaveLength(1);
    expect(stagedScriptRetained).toBe(false);
  });

  it.each([
    ["wrong job", { ...FAILED_CRON_RUN, run: { ...FAILED_CRON_RUN.run, jobId: "other" } }],
    ["wrong run", { ...FAILED_CRON_RUN, run: { ...FAILED_CRON_RUN.run, runId: "other" } }],
    ["nonterminal", { ...FAILED_CRON_RUN, completed: false }],
    ["contradictory status", { ...FAILED_CRON_RUN, run: { ...FAILED_CRON_RUN.run, status: "ok" } }],
    [
      "contradictory completion",
      { ...FAILED_CRON_RUN, run: { ...FAILED_CRON_RUN.run, completionStatus: "succeeded" } },
    ],
    [
      "unrecognized terminal value",
      {
        ...FAILED_CRON_RUN,
        completionStatus: "private-sentinel",
        run: { ...FAILED_CRON_RUN.run, completionStatus: "private-sentinel" },
      },
    ],
    ["non-string terminal value", { ...FAILED_CRON_RUN, status: ["error"] }],
    ["successful run on CLI failure", COMPLETED_CRON_RUN],
  ])("does not attribute %s output to a terminal cron failure", (_case, response) => {
    const { result, stagedScriptRetained } = runAdminApprovalScript(
      undefined,
      0,
      EXPECTED_REQUEST_ID,
      {
        cronRunOutput: JSON.stringify({
          ...response,
          run: { ...response.run, error: "HTTP 503: private-sentinel" },
        }),
        cronRunExitCode: 1,
      },
    );
    expect(result.status).toBe(29);
    expect(result.stderr).toContain("ADMIN_DIAGNOSTIC=command-failed");
    expect(result.stderr).not.toContain("ADMIN_CRON_ERROR_REASON=");
    expect(result.stderr).not.toContain("ADMIN_CRON_DIAGNOSTIC_SOURCES=");
    expect(result.stderr).not.toContain("ADMIN_CRON_ERROR_SIGNATURES=");
    expect(result.stdout).not.toContain("ISSUE_5324_ADMIN_APPROVAL_OK");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/cron-1|run-1|other|private-sentinel/);
    expect(stagedScriptRetained).toBe(false);
  });

  it.each([
    ["malformed", '{"private-sentinel":'],
    ["deeply nested", `{"private-sentinel":${"[".repeat(2000)}0${"]".repeat(2000)}}`],
  ])("preserves a %s cron command failure without raw output", (_case, cronRunOutput) => {
    const { result, stagedScriptRetained, privateCaptureCount, privateCapturesRemaining } =
      runAdminApprovalScript(undefined, 0, EXPECTED_REQUEST_ID, {
        cronRunOutput,
        cronRunExitCode: 1,
        removeCaptures: true,
      });
    expect(result.status).toBe(29);
    expect(result.stderr).toContain("ADMIN_DIAGNOSTIC=command-failed");
    expect(result.stderr).not.toContain("ADMIN_CRON_ERROR_REASON=");
    expect(result.stderr).not.toContain("ADMIN_CRON_DIAGNOSTIC_SOURCES=");
    expect(result.stderr).not.toContain("ADMIN_CRON_ERROR_SIGNATURES=");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("private-sentinel");
    expect(privateCaptureCount).toBe(8);
    expect(privateCapturesRemaining).toEqual([]);
    expect(stagedScriptRetained).toBe(false);
  });

  it("accepts completed cron output after a CLI banner (#13342)", () => {
    const { result } = runAdminApprovalScript(undefined, 0, EXPECTED_REQUEST_ID, {
      cronRunOutput: `OpenClaw ready\n${JSON.stringify(COMPLETED_CRON_RUN)}`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ISSUE_5324_ADMIN_APPROVAL_OK");
  });

  it.each([
    "auth",
    "auth_permanent",
    "format",
    "rate_limit",
    "overloaded",
    "billing",
    "server_error",
    "timeout",
    "tls_certificate",
    "context_overflow",
    "model_not_found",
    "session_expired",
    "empty_response",
    "no_error_details",
    "unclassified",
    "unknown",
  ])("retains the pinned cron reason %s without private details", (errorReason) => {
    const sources = [
      "cron-preflight",
      "cron-setup",
      "model-preflight",
      "agent-run",
      "tool",
      "exec",
      "delivery",
    ];
    const entries = sources.map((source, index) => ({
      source,
      severity: ["info", "warn", "error"][index % 3],
      message: "PRIVATE_PROMPT",
      toolName: "PRIVATE_TOOL",
      exitCode: 12345,
    }));
    const response = {
      ...FAILED_CRON_RUN,
      run: {
        ...FAILED_CRON_RUN.run,
        errorReason,
        error: "test-gateway-token",
        summary: "PRIVATE_RESPONSE",
        sessionKey: "PRIVATE_SESSION",
        diagnostics: { summary: "https://PRIVATE_URL/?token=PRIVATE_TOKEN", entries },
      },
    };
    const {
      result,
      commands,
      privateCaptureCount,
      privateCapturesRemaining,
      stagedScriptRetained,
    } = runAdminApprovalScript(undefined, 0, EXPECTED_REQUEST_ID, {
      cronRunOutput: JSON.stringify(response),
      cronRunExitCode: 1,
      removeCaptures: true,
    });
    expect(result.status).toBe(29);
    expect(result.stderr).toBe(
      `ADMIN_CRON_RUN_FAILED\nADMIN_DIAGNOSTIC=cron-run-error\nADMIN_CRON_ERROR_REASON=${errorReason}\nADMIN_CRON_DIAGNOSTIC_SOURCES=cron-preflight:info,cron-setup:warn,model-preflight:error,agent-run:info,tool:warn,exec:error,delivery:info\nADMIN_CRON_ERROR_SIGNATURES=unavailable\n`,
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
      /PRIVATE_|test-gateway-token|cron-1|run-1|12345/,
    );
    expect(result.stdout).toContain("ADMIN_CONNECT_BODY_STATUS=29");
    expect(result.stdout).not.toContain("ISSUE_5324_ADMIN_APPROVAL_OK");
    expect(commands.filter((command) => command.startsWith("cron run "))).toHaveLength(1);
    expect(privateCaptureCount).toBe(8);
    expect(privateCapturesRemaining).toEqual([]);
    expect(stagedScriptRetained).toBe(false);
  });

  it.each([
    undefined,
    null,
    42,
    {},
    [],
    "PRIVATE_VALUE",
    "auth\nPRIVATE_VALUE",
    "auth\u001b[0m",
    "аuth",
  ])("omits an invalid cron diagnostic value %j", (value) => {
    const response = {
      ...FAILED_CRON_RUN,
      run: {
        ...FAILED_CRON_RUN.run,
        errorReason: value,
        diagnostics: {
          entries: [
            { source: value, severity: "error" },
            { source: "exec", severity: value },
          ],
        },
      },
    };
    const { result, privateCapturesRemaining } = runAdminApprovalScript(
      undefined,
      0,
      EXPECTED_REQUEST_ID,
      { cronRunOutput: JSON.stringify(response), cronRunExitCode: 1, removeCaptures: true },
    );
    expect(result.status).toBe(29);
    expect(result.stderr).toBe(
      "ADMIN_CRON_RUN_FAILED\nADMIN_DIAGNOSTIC=cron-run-error\nADMIN_CRON_ERROR_REASON=unavailable\nADMIN_CRON_DIAGNOSTIC_SOURCES=unavailable\nADMIN_CRON_ERROR_SIGNATURES=unavailable\n",
    );
    expect(privateCapturesRemaining).toEqual([]);
  });

  it.each([null, [], { entries: "PRIVATE_VALUE" }, { entries: [null, [], {}, 42] }])(
    "omits malformed cron diagnostic entries %j",
    (diagnostics) => {
      const response = { ...FAILED_CRON_RUN, run: { ...FAILED_CRON_RUN.run, diagnostics } };
      const { result } = runAdminApprovalScript(undefined, 0, EXPECTED_REQUEST_ID, {
        cronRunOutput: JSON.stringify(response),
        cronRunExitCode: 1,
      });
      expect(result.status).toBe(29);
      expect(result.stderr).toContain("ADMIN_CRON_DIAGNOSTIC_SOURCES=unavailable\n");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("PRIVATE_VALUE");
    },
  );

  it.each([
    ["LLM request timed out.", "message-llm-timeout"],
    ["LLM request failed.", "message-llm-failed"],
    ["LLM request failed with an unknown error.", "message-llm-unknown"],
    ["LLM request failed: provider returned an internal error.", "message-llm-provider-internal"],
    [
      "The selected model was not found by the provider. Check the model id or choose a different model.",
      "message-model-not-found",
    ],
    ["Code Mode could not resolve a configured MCP tool.", "message-code-mode-catalog-miss"],
    ["Agent couldn't generate a response.", "message-agent-incomplete-turn"],
    [
      "\u26a0\ufe0f Agent couldn't generate a response. Please try again.",
      "message-agent-incomplete-turn",
    ],
    ["Agent couldn't generate a response. PRIVATE_SUFFIX", "unavailable"],
    ["HTTP 503: PRIVATE_PROMPT test-gateway-token https://PRIVATE_HOST/", "error-text-http-503"],
    ["503 PRIVATE_BODY", "error-text-http-503"],
    ["503", "error-text-http-503"],
    ["API error (503): PRIVATE_BODY", "error-text-http-503"],
    ["status code: 503, message: PRIVATE_BODY", "error-text-http-503"],
    ["unexpected status = 503 PRIVATE_BODY", "error-text-http-503"],
    ["http status 503 PRIVATE_BODY", "error-text-http-503"],
    ["Error: HTTP 503: PRIVATE_BODY", "error-text-http-503"],
    ["Error, API error (503): PRIVATE_BODY", "error-text-http-503"],
    ["HTTP 400: PRIVATE_BODY", "error-text-http-400"],
    ["HTTP 599: PRIVATE_BODY", "error-text-http-599"],
    ["HTTP 408: PRIVATE_BODY", "error-text-http-408"],
    ["HTTP 429: PRIVATE_BODY", "error-text-http-429"],
    ["PRIVATE_PREFIX LLM request timed out.", "unavailable"],
    ["LLM request timed out. PRIVATE_SUFFIX", "unavailable"],
    ["PRIVATE_BODY contains 503", "unavailable"],
    ["503123_PRIVATE_ID", "unavailable"],
    ["https://PRIVATE_HOST/503", "unavailable"],
    ["HTTP 399: PRIVATE_BODY", "unavailable"],
    ["HTTP 600: PRIVATE_BODY", "unavailable"],
    ["HTTP ５０３: PRIVATE_BODY", "unavailable"],
    ["Provider API error (503): PRIVATE_BODY", "unavailable"],
    ["Error: Error: HTTP 503: PRIVATE_BODY", "unavailable"],
    [null, "unavailable"],
    [{ message: "HTTP 503: PRIVATE_BODY" }, "unavailable"],
  ])("projects only a fixed cron error-text signature for %j", (message, signature) => {
    const response = {
      ...FAILED_CRON_RUN,
      run: {
        ...FAILED_CRON_RUN.run,
        errorReason: "timeout",
        error: message,
        diagnostics: {
          entries: ["tool", "agent-run"].map((source) => ({ source, severity: "error", message })),
        },
      },
    };
    const { result, privateCaptureCount, privateCapturesRemaining, stagedScriptRetained } =
      runAdminApprovalScript(undefined, 0, EXPECTED_REQUEST_ID, {
        cronRunOutput: JSON.stringify(response),
        cronRunExitCode: 1,
        removeCaptures: true,
      });
    const expected =
      signature === "unavailable"
        ? signature
        : ["run", "tool", "agent-run"].map((source) => `${source}:${signature}`).join(",");
    expect(result.status).toBe(29);
    expect(result.stderr).toContain(`ADMIN_CRON_ERROR_SIGNATURES=${expected}\n`);
    expect(result.stderr).toContain("ADMIN_CRON_ERROR_REASON=timeout\n");
    expect(result.stdout).not.toContain("ISSUE_5324_ADMIN_APPROVAL_OK");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
      /PRIVATE_|test-gateway-token|cron-1|run-1/,
    );
    expect(privateCaptureCount).toBe(8);
    expect(privateCapturesRemaining).toEqual([]);
    expect(stagedScriptRetained).toBe(false);
  });

  it("ignores cron signatures outside the bound error-message fields", () => {
    const message = "HTTP 503: PRIVATE_BODY";
    const response = {
      ...FAILED_CRON_RUN,
      run: {
        ...FAILED_CRON_RUN.run,
        summary: message,
        arbitrary: { error: message },
        diagnostics: {
          summary: message,
          entries: [
            { source: "tool", severity: "warn", message },
            { source: "tool", severity: "info", message },
            { source: "PRIVATE_SOURCE", severity: "error", message },
            ...Array.from({ length: 7 }, () => ({
              source: "tool",
              severity: "error",
              summary: message,
            })),
            { source: "tool", severity: "error", message },
          ],
        },
      },
    };
    const { result, privateCapturesRemaining } = runAdminApprovalScript(
      undefined,
      0,
      EXPECTED_REQUEST_ID,
      {
        cronRunOutput: JSON.stringify(response),
        cronRunExitCode: 1,
        removeCaptures: true,
      },
    );
    expect(result.status).toBe(29);
    expect(result.stderr).toContain("ADMIN_CRON_ERROR_SIGNATURES=unavailable\n");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/PRIVATE_|error-text-http/);
    expect(privateCapturesRemaining).toEqual([]);
  });

  it("limits cron error-text signatures to the run and ten entries", () => {
    const entries = Array.from({ length: 11 }, (_, index) => ({
      source: "tool",
      severity: "error",
      message: `HTTP ${500 + index}: PRIVATE_BODY`,
    }));
    const response = {
      ...FAILED_CRON_RUN,
      run: { ...FAILED_CRON_RUN.run, error: "HTTP 429: PRIVATE_BODY", diagnostics: { entries } },
    };
    const { result, privateCapturesRemaining } = runAdminApprovalScript(
      undefined,
      0,
      EXPECTED_REQUEST_ID,
      {
        cronRunOutput: JSON.stringify(response),
        cronRunExitCode: 1,
        removeCaptures: true,
      },
    );
    const expected = [
      "run:error-text-http-429",
      ...Array.from({ length: 10 }, (_, index) => `tool:error-text-http-${500 + index}`),
    ];
    expect(result.status).toBe(29);
    expect(result.stderr).toContain(`ADMIN_CRON_ERROR_SIGNATURES=${expected.join(",")}\n`);
    expect(result.stderr).not.toMatch(/PRIVATE_|error-text-http-510/);
    expect(privateCapturesRemaining).toEqual([]);
  });

  it("bounds and deduplicates cron diagnostic entries while draining output", () => {
    const response = {
      ...FAILED_CRON_RUN,
      run: {
        ...FAILED_CRON_RUN.run,
        errorReason: "server_error",
        diagnostics: {
          entries: [
            ...Array.from({ length: 10 }, () => ({
              source: "agent-run",
              severity: "error",
              message: "HTTP 503: PRIVATE_BODY",
            })),
            { source: "delivery", severity: "error", message: "HTTP 429: PRIVATE_BODY" },
          ],
        },
      },
    };
    const { result, capturedCronBytes, failureOutputDrained } = runAdminApprovalScript(
      "cron:run",
      256 * 1024,
      EXPECTED_REQUEST_ID,
      { cronRunError: JSON.stringify(response) },
    );
    expect(result.status).toBe(29);
    expect(capturedCronBytes).toBe(65_536);
    expect(failureOutputDrained).toBe(true);
    expect(result.stderr).toContain("ADMIN_CRON_DIAGNOSTIC_SOURCES=agent-run:error\n");
    expect(result.stderr).not.toContain("delivery:error");
    expect(result.stderr).toContain("ADMIN_CRON_ERROR_SIGNATURES=agent-run:error-text-http-503\n");
    expect(result.stderr).not.toMatch(/PRIVATE_|error-text-http-429/);
  });

  it("rejects truncated cron JSON after draining the bounded capture", () => {
    const { result, capturedCronBytes, failureOutputDrained } = runAdminApprovalScript(
      "cron:run",
      256 * 1024,
      EXPECTED_REQUEST_ID,
      { cronRunError: '{"error":"HTTP 503: PRIVATE_VALUE' },
    );
    expect(result.status).toBe(29);
    expect(capturedCronBytes).toBe(65_536);
    expect(failureOutputDrained).toBe(true);
    expect(result.stderr).toBe("ADMIN_CRON_RUN_FAILED\nADMIN_DIAGNOSTIC=command-failed\n");
  });

  it("preserves the cron failure and cleans private files when diagnostics fail", () => {
    const {
      result,
      commands,
      privateCaptureCount,
      privateCapturesRemaining,
      stagedScriptRetained,
    } = runAdminApprovalScript(undefined, 0, EXPECTED_REQUEST_ID, {
      cronRunOutput: JSON.stringify(FAILED_CRON_RUN),
      cronRunExitCode: 1,
      diagnosticFails: true,
      removeCaptures: true,
    });
    expect(result.status).toBe(29);
    expect(result.stderr).toContain("ADMIN_DIAGNOSTIC=unavailable");
    expect(result.stdout).toContain("ADMIN_CONNECT_BODY_STATUS=29");
    expect(commands.filter((command) => command.startsWith("cron run "))).toHaveLength(1);
    expect(privateCaptureCount).toBe(8);
    expect(privateCapturesRemaining).toEqual([]);
    expect(stagedScriptRetained).toBe(false);
  });

  it.each([
    ["error", "failed", "cron-run-error"],
    ["skipped", "failed", "cron-run-skipped"],
    ["ok", "failed", "cron-completion-failed"],
    ["ok", "unknown", "cron-completion-unknown"],
  ])(
    "retains the pinned terminal %s/%s category on CLI exit 1",
    (status, completionStatus, diagnostic) => {
      const response = {
        ...COMPLETED_CRON_RUN,
        status,
        completionStatus,
        run: {
          ...COMPLETED_CRON_RUN.run,
          status,
          completionStatus,
          error: "private generated text test-gateway-token",
        },
      };
      const { commands, result, stagedScriptRetained } = runAdminApprovalScript(
        undefined,
        0,
        EXPECTED_REQUEST_ID,
        { cronRunOutput: `OpenClaw ready\n${JSON.stringify(response)}`, cronRunExitCode: 1 },
      );
      expect(result.status).toBe(29);
      expect(result.stderr).toContain("ADMIN_CRON_RUN_FAILED");
      expect(result.stderr).toContain(`ADMIN_DIAGNOSTIC=${diagnostic}`);
      expect(result.stdout).not.toContain("ISSUE_5324_ADMIN_APPROVAL_OK");
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
        /cron-1|run-1|private generated text|test-gateway-token/,
      );
      expect(commands.filter((command) => command.startsWith("cron run "))).toHaveLength(1);
      expect(stagedScriptRetained).toBe(false);
    },
  );

  it("rejects malformed cron output and removes its staged script (#13342)", () => {
    const { result, stagedScriptRetained } = runAdminApprovalScript(
      undefined,
      0,
      EXPECTED_REQUEST_ID,
      {
        cronRunOutput: "invalid response token=test-gateway-token",
      },
    );
    expect(result.status).toBe(30);
    expect(result.stderr).toContain("ADMIN_CRON_RUN_RESULT_INVALID");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("test-gateway-token");
    expect(stagedScriptRetained).toBe(false);
  });

  it.each([
    [EXPECTED_REQUEST_ID, 0, []],
    [VERSION_ONE_REQUEST_ID, 26, ["ADMIN_DIAGNOSTIC=selection-pending-count"]],
  ] as const)(
    "binds feature approval to request %s without running cron",
    (expectedRequestId, status, diagnostics) => {
      const { commands, openshellArgs, result, stagedScriptRetained } = runAdminApprovalScript(
        "cron:add",
        0,
        EXPECTED_REQUEST_ID,
        {
          expectedRequestId,
          verifyCronConsumer: false,
          selectExpectedRequest: true,
        },
      );

      expect(result.status, result.stderr).toBe(status);
      expect(openshellArgs).toEqual(EXPECTED_OPENSHELL_ARGS);
      expect(commands).toEqual([
        "devices list --json",
        ...(status === 0 ? [`devices approve ${EXPECTED_REQUEST_ID}`] : []),
      ]);
      expect(result.stdout.includes("ISSUE_5324_ADMIN_APPROVAL_OK")).toBe(status === 0);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output.match(/ADMIN_DIAGNOSTIC=[a-z-]+/g) ?? []).toEqual(diagnostics);
      expect(output).not.toContain(EXPECTED_REQUEST_ID);
      expect(output).not.toContain(VERSION_ONE_REQUEST_ID);
      expect(output).not.toContain(EXPECTED_DEVICE_ID);
      expect(output).not.toContain(EXPECTED_PUBLIC_KEY);
      expect(output).not.toContain("test-gateway-token");
      expect(stagedScriptRetained).toBe(false);
    },
  );

  it.each([
    [2, "OpenClawPairingStateRetryableError", 0, 3, EXPECTED_IDENTITY],
    [99, "OpenClawPairingStateRetryableError", 1, 3, EXPECTED_IDENTITY],
    [99, "PermissionError", 1, 1, EXPECTED_IDENTITY],
    [
      1,
      "OpenClawPairingStateRetryableError",
      1,
      2,
      { deviceId: "wrong", publicKey: EXPECTED_PUBLIC_KEY },
    ],
  ] as const)(
    "bounds canonical snapshot recovery after %i failures of %s without bypassing identity",
    (failures, errorType, status, calls, identity) => {
      const helper = `${PAIRING_STATE_HELPER_PY.replace("def read_openclaw_pairing_state", "def fixture_snapshot")}
import sys
class OpenClawPairingStateRetryableError(OSError): pass
snapshot_calls = 0
def read_openclaw_pairing_state(state_dir, timeout=1):
    global snapshot_calls
    snapshot_calls += 1
    print("SNAPSHOT_CALL", file=sys.stderr)
    if snapshot_calls <= ${failures}:
        raise ${errorType}("canonical pairing-state WAL changed while reading")
    return fixture_snapshot(state_dir, timeout=timeout)
`;
      const result = runSelector(adminState(), identity, writeLocalIdentity, helper);
      expect(result.status, result.stderr).toBe(status);
      expect(result.stderr.match(/^SNAPSHOT_CALL$/gm) ?? []).toHaveLength(calls);
      expect(result.stderr.match(/^ADMIN_SNAPSHOT_RETRY=[12]$/gm) ?? []).toHaveLength(calls - 1);
      expect(result.stdout).toBe("");
      expect(result.selectedRequestId).toBe(status === 0 ? EXPECTED_REQUEST_ID : "");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(EXPECTED_PUBLIC_KEY);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(EXPECTED_DEVICE_ID);
    },
  );

  it.each([
    ["during a rejected read", [0, 0, 1.1]],
    ["before the next read", [0, 0, 0.1, 1.1]],
  ] as const)(
    "refuses another snapshot read when its original budget expires %s",
    (_phase, ticks) => {
      const helper = `${PAIRING_STATE_HELPER_PY}
import sys, time
clock_ticks = iter(${JSON.stringify(ticks)})
time.monotonic = lambda: next(clock_ticks)
class OpenClawPairingStateRetryableError(OSError): pass
def read_openclaw_pairing_state(state_dir, timeout=1):
    print("SNAPSHOT_CALL", file=sys.stderr)
    raise OpenClawPairingStateRetryableError("canonical pairing-state WAL changed while reading")
`;
      const result = runSelector(adminState(), EXPECTED_IDENTITY, writeLocalIdentity, helper);
      expect(result.status).toBe(1);
      expect(result.stderr.match(/^SNAPSHOT_CALL$/gm) ?? []).toHaveLength(1);
      expect(result.stderr).toContain("OpenClawPairingStateRetryableError");
      expect(result.selectedRequestId).toBe("");
    },
  );

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

  it("distinguishes pinned cron wait exhaustion without exposing its run identity", () => {
    const { commands, result, stagedScriptRetained } = runAdminApprovalScript(
      "cron:run",
      0,
      EXPECTED_REQUEST_ID,
      {
        cronRunError: "timed out waiting for cron run private-run-id token=test-gateway-token",
      },
    );
    expect(result.status).toBe(29);
    expect(result.stderr).toContain("ADMIN_DIAGNOSTIC=cron-wait-timeout");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/private-run-id|test-gateway-token/);
    expect(commands).toHaveLength(4);
    expect(stagedScriptRetained).toBe(false);
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
