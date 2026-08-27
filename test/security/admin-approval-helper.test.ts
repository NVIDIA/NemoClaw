// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ADMIN_REQUEST_SELECTOR_PY,
  adminApprovalConnectScript,
} from "../e2e/live/issue-4462-admin-approval-helper.ts";

const EXPECTED_REQUEST_ID = "12345678-1234-4123-8123-123456789abc";

function adminState(tokenShape: "array" | "object" = "array"): Record<string, unknown> {
  const operatorToken = {
    role: "operator",
    scopes: ["operator.pairing", "operator.read", "operator.write"],
  };
  return {
    pending: [
      {
        requestId: EXPECTED_REQUEST_ID,
        deviceId: "device-1",
        publicKey: "public-key-1",
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.pairing", "operator.read", "operator.write", "operator.admin"],
      },
    ],
    paired: [
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
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

function runSelector(state: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-admin-selector-"));
  const statePath = path.join(root, "devices.json");
  const requestIdPath = path.join(root, "selected-request-id");
  fs.writeFileSync(statePath, JSON.stringify(state));
  try {
    const result = spawnSync("python3", ["-", statePath, requestIdPath], {
      encoding: "utf-8",
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
  gatewayUrl: string,
  insecurePrivateWs?: string,
): { commands: string[]; result: SpawnSyncReturns<string> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-admin-script-"));
  const cliPath = path.join(root, "nemoclaw");
  const openclawPath = path.join(root, "openclaw");
  const devicesPath = path.join(root, "devices.json");
  const commandLogPath = path.join(root, "openclaw.log");
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
    openclawPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_OPENCLAW_LOG"
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
  fs.writeFileSync(devicesPath, JSON.stringify(adminState()));
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ""}`,
    FAKE_DEVICES_STATE: devicesPath,
    FAKE_OPENCLAW_LOG: commandLogPath,
    NEMOCLAW_OPENCLAW_GATEWAY_URL: gatewayUrl,
    NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: insecurePrivateWs ?? "",
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
    return { commands, result };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("prepared connect-shell administrative approval", () => {
  it.each([
    ["loopback ws", "ws://127.0.0.1:18789", undefined],
    ["marked private ws", "ws://10.200.0.2:18789", "1"],
    ["private wss", "wss://192.168.1.2:18789", undefined],
  ])("executes the explicit approval sequence over %s (#5324)", (_case, gatewayUrl, marker) => {
    const { commands, result } = runAdminApprovalScript(gatewayUrl, marker);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ISSUE_5324_ADMIN_APPROVAL_OK");
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
      /12345678-1234-4123-8123-123456789abc|device-1|public-key-1|cron-1|test-gateway-token/u,
    );
    expect(commands).toEqual([
      "devices list --json",
      `devices approve ${EXPECTED_REQUEST_ID}`,
      "cron add --name admin-cron --every 2h --agent main --session isolated --message hello",
      "cron run cron-1",
    ]);
  });

  it.each([
    ["public ws", "ws://example.com:18789", "1"],
    ["public wss", "wss://example.com:18789", undefined],
    ["unmarked private ws", "ws://10.200.0.2:18789", undefined],
  ])("rejects %s before invoking OpenClaw (#5324)", (_case, gatewayUrl, marker) => {
    const { commands, result } = runAdminApprovalScript(gatewayUrl, marker);

    expect(result.status).toBe(22);
    expect(result.stderr).toContain("PRIVATE_GATEWAY_ALIAS_REJECTED");
    expect(commands).toEqual([]);
  });

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
