// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ADMIN_REQUEST_SELECTOR_PY,
  adminApprovalConnectScript,
  extractPendingRequestId,
} from "./e2e/live/issue-4462-admin-approval-helper.ts";

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

function runSelector(state: Record<string, unknown>, requestId = EXPECTED_REQUEST_ID) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-admin-selector-"));
  const statePath = path.join(root, "devices.json");
  fs.writeFileSync(statePath, JSON.stringify(state));
  try {
    return spawnSync("python3", ["-", statePath, requestId], {
      encoding: "utf-8",
      input: ADMIN_REQUEST_SELECTOR_PY,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("prepared connect-shell administrative approval", () => {
  it("is valid shell and keeps admin approval explicit (#5324)", () => {
    const script = adminApprovalConnectScript(
      "/path with spaces/nemoclaw",
      "e2e-issue-4462",
      EXPECTED_REQUEST_ID,
      "admin-cron",
      "admin-session",
    );
    const syntax = spawnSync("bash", ["-n"], { encoding: "utf-8", input: script });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(script).toContain("openclaw devices list --json");
    expect(script).toContain('openclaw devices approve "$request_id"');
    expect(script).toContain("norm(request.get('requestId')) == expected_request_id");
    expect(script).toContain("request_scopes.issubset(allowed_scopes)");
    expect(script).toContain("operator.admin was already granted before explicit approval");
    expect(script).toContain("openclaw cron add");
    expect(script).toContain('openclaw cron run "$cron_id"');
    expect(script).toContain("value.get('enqueued') is True");
    expect(script).toContain("value.get('runId')");
    expect(script).toContain("value.get('name') == want");
    expect(script.indexOf('openclaw devices approve "$request_id"')).toBeLessThan(
      script.indexOf('openclaw cron run "$cron_id"'),
    );
    expect(script).toContain("def _load_agent_json_docs");
    expect(script).toContain('[ "$agent_reply" = "42" ]');
    expect(script).not.toContain("pending.json");
    expect(script).not.toContain("paired.json");
  });

  it("extracts one exact requestId even when the gateway repeats it (#5324)", () => {
    expect(
      extractPendingRequestId(
        `scope upgrade pending (requestId: ${EXPECTED_REQUEST_ID})\npairing required requestId=${EXPECTED_REQUEST_ID}`,
      ),
    ).toBe(EXPECTED_REQUEST_ID);
    expect(() => extractPendingRequestId("pairing required without an id")).toThrow("found 0");
    expect(() =>
      extractPendingRequestId(
        `requestId: ${EXPECTED_REQUEST_ID}\nrequestId: 87654321-4321-4321-8321-cba987654321`,
      ),
    ).toThrow("found 2");
  });

  it("ignores a truncated diagnostic copy of the same canonical request UUID (#5324)", () => {
    expect(
      extractPendingRequestId(
        `scope upgrade pending (requestId: ${EXPECTED_REQUEST_ID})\n` +
          `gateway closed (1008): pairing required (requestId: ${EXPECTED_REQUEST_ID.slice(0, -2)}`,
      ),
    ).toBe(EXPECTED_REQUEST_ID);
    expect(() => extractPendingRequestId("requestId: not-a-canonical-uuid")).toThrow("found 0");
  });

  it("selects only the cron requestId on its exact paired CLI device and bounded scopes (#5324)", () => {
    for (const tokenShape of ["array", "object"] as const) {
      const result = runSelector(adminState(tokenShape));
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(EXPECTED_REQUEST_ID);
    }
  });

  it("accepts compact device grants when the active token includes implied read scope (#5324)", () => {
    const state = adminState("object");
    const device = (
      state.paired as Array<{
        approvedScopes: string[];
        scopes: string[];
        tokens: { operator: { scopes: string[] } };
      }>
    )[0];

    expect(device.scopes).toEqual(["operator.pairing", "operator.write"]);
    expect(device.tokens.operator.scopes).toEqual([
      "operator.pairing",
      "operator.read",
      "operator.write",
    ]);
    const result = runSelector(state);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(EXPECTED_REQUEST_ID);
  });

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

  it("rejects unrelated IDs, contradictory roles, unrequested admin, broad scopes, or pre-approved admin (#5324)", () => {
    const unrelated = runSelector(adminState(), "87654321-4321-4321-8321-cba987654321");
    expect(unrelated.status).not.toBe(0);

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
