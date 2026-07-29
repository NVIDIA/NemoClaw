// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  AUTO_PAIR_MAX_APPROVALS,
  buildAutoPairApprovalScript,
  parseAutoPairApprovalReceipt,
  readAutoPairApprovalPolicyModule,
} from "./auto-pair-approval";

const SUMMARY_MARKER = "__NEMOCLAW_AUTO_PAIR_APPROVED__";
const RECEIPT_MARKER = "__NEMOCLAW_AUTO_PAIR_RECEIPT__";

describe("buildAutoPairApprovalScript (#4263/#4616)", () => {
  it("builds the bounded allowlisted approval pass", () => {
    const script = buildAutoPairApprovalScript("UE9MSUNZ");
    expect(script).toContain("/tmp/nemoclaw-proxy-env.sh");
    expect(script).toContain("command -v openclaw");
    expect(script).toContain("command -v python3");
    expect(script).toContain("'devices', 'list', '--json'");
    expect(script).toContain("'devices', 'approve'");
    expect(script).toContain("approval_request_decision(device)");
    expect(script).toContain("if not decision['allowed']:");
    expect(script).toContain("approve_env = gateway_approval_env(os.environ)");
    expect(script).toContain(`MAX_APPROVALS = ${AUTO_PAIR_MAX_APPROVALS}`);
    expect(script).toContain("'UE9MSUNZ'");
  });

  it("adds local-device filtering only for restored-clone approval", () => {
    const ordinary = buildAutoPairApprovalScript("UE9MSUNZ");
    const restoredClone = buildAutoPairApprovalScript("UE9MSUNZ", {
      emitReceipt: true,
      localDeviceOnly: true,
      budget: { maxApprovals: 1 },
    });

    expect(ordinary).not.toContain("local_identity_public_key");
    expect(ordinary).toContain("env=None");
    expect(ordinary).not.toContain("NEMOCLAW_OPENCLAW_USE_STORED_DEVICE_LIST_AUTH");
    expect(ordinary).not.toContain("NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING");
    expect(ordinary).not.toContain("NEMOCLAW_OPENCLAW_REQUIRE_STORED_DEVICE_APPROVAL");
    expect(restoredClone).toContain("local_identity_public_key");
    expect(restoredClone.match(/\[OPENCLAW, 'devices', 'list', '--json'\]/g)).toHaveLength(2);
    expect(restoredClone).toContain("env['NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING'] = '1'");
    expect(restoredClone).toContain(
      "env['NEMOCLAW_OPENCLAW_REQUIRE_STORED_DEVICE_APPROVAL'] = '1'",
    );
    expect(restoredClone).toContain("env=local_device_list_env(os.environ)");
    expect(restoredClone).toContain("env['NEMOCLAW_OPENCLAW_USE_STORED_DEVICE_LIST_AUTH'] = '1'");
    expect(restoredClone).toContain("if not related_pending:");
    expect(restoredClone).toContain("len(related_pending) > 1");
    expect(restoredClone).toContain("pending = related_pending");
    expect(restoredClone).toContain("MAX_APPROVALS = 1");
    expect(restoredClone).toContain(RECEIPT_MARKER);
  });

  it("omits the summary marker by default and appends it when requested", () => {
    const silent = buildAutoPairApprovalScript("UE9MSUNZ");
    const reporting = buildAutoPairApprovalScript("UE9MSUNZ", { emitSummary: true });
    expect(silent).not.toContain(SUMMARY_MARKER);
    expect(silent).not.toContain(RECEIPT_MARKER);
    expect(reporting).toContain(`print(f'${SUMMARY_MARKER}={approved_count}')`);
    // The reporting script is the silent script with exactly the summary line
    // inserted before the heredoc terminator — nothing else changes.
    const stripped = reporting.replace(`print(f'${SUMMARY_MARKER}={approved_count}')\n`, "");
    expect(stripped).toBe(silent);
  });

  it("reads the real policy module from disk", () => {
    const module = readAutoPairApprovalPolicyModule();
    expect(module).toBeTruthy();
    expect(module).toContain("def approval_request_decision");
    expect(module).toContain("def gateway_approval_env");
    expect(module).not.toContain("recover_failed_scope_approval");
  });

  it("accepts exactly one terminal fixed receipt", () => {
    for (const receipt of [
      "credential-list-timeout",
      "credential-list-failed",
      "list-timeout",
      "list-exec-failed",
      "list-command-failed",
      "list-empty-output",
      "list-invalid-output",
      "approved-one",
    ] as const) {
      expect(
        parseAutoPairApprovalReceipt(`ignored setup output\n${RECEIPT_MARKER}=${receipt}\n`),
      ).toBe(receipt);
    }
    for (const output of [
      `${RECEIPT_MARKER}=approved-one\nlater output\n`,
      `${RECEIPT_MARKER}=approve-failed\n${RECEIPT_MARKER}=approved-one\n`,
      `${RECEIPT_MARKER}=raw-request-id\n`,
    ]) {
      expect(parseAutoPairApprovalReceipt(output)).toBeNull();
    }
  });
});

describe("auto-pair approval pass behaviour (#4616)", () => {
  it("approves allowlisted upgrades, skips unknown clients, and reports the count", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      // No python3 — the in-sandbox script can't run; skip the behavioural check.
      return;
    }
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const policyB64 = Buffer.from(policy as string, "utf-8").toString("base64");
    const script = buildAutoPairApprovalScript(policyB64, { emitSummary: true });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-"));
    try {
      const approvalsFile = path.join(tmpDir, "approvals.log");
      const approveEnvFile = path.join(tmpDir, "approve-env.log");
      const listEnvFile = path.join(tmpDir, "list-env.log");
      const pending = [
        {
          requestId: "ok-webchat",
          clientId: "openclaw-control-ui",
          clientMode: "webchat",
          scopes: ["operator.read", "operator.write"],
        },
        {
          requestId: "ok-cli",
          clientId: "openclaw-cli",
          clientMode: "cli",
          requestedScopes: ["operator.pairing"],
        },
        {
          requestId: "ok-agent-cli",
          clientId: "cli",
          clientMode: "cli",
          requestedScopes: ["operator.pairing"],
        },
        {
          requestId: "deny-unknown",
          clientId: "evil",
          clientMode: "unknown",
          scopes: ["operator.read"],
        },
        {
          requestId: "deny-spoofed-cli-mode",
          clientId: "evil",
          clientMode: "cli",
          scopes: ["operator.write"],
        },
        {
          requestId: "deny-spoofed-webchat-mode",
          clientId: "evil",
          clientMode: "webchat",
          scopes: ["operator.read"],
        },
        {
          requestId: "deny-admin",
          clientId: "openclaw-control-ui",
          clientMode: "webchat",
          scopes: ["operator.admin"],
        },
      ];
      const listResponse = JSON.stringify({ pending, paired: [] });
      fs.writeFileSync(
        path.join(tmpDir, "openclaw"),
        `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "devices" && args[1] === "list") {
  fs.appendFileSync(
    ${JSON.stringify(listEnvFile)},
    [
      process.env.OPENCLAW_GATEWAY_URL || "unset",
      process.env.OPENCLAW_GATEWAY_PORT || "unset",
      process.env.OPENCLAW_GATEWAY_TOKEN || "unset",
      process.env.NEMOCLAW_OPENCLAW_USE_STORED_DEVICE_LIST_AUTH || "unset",
    ].join(":") + "\\n",
  );
  process.stdout.write(${JSON.stringify(`${listResponse}\n`)});
  process.exit(0);
}
if (args[0] === "devices" && args[1] === "approve") {
  fs.appendFileSync(${JSON.stringify(approvalsFile)}, args[2] + "\\n");
  fs.appendFileSync(
    ${JSON.stringify(approveEnvFile)},
    [
      process.env.OPENCLAW_GATEWAY_URL || "unset",
      process.env.OPENCLAW_GATEWAY_PORT || "unset",
      process.env.OPENCLAW_GATEWAY_TOKEN || "unset",
      process.env.NEMOCLAW_OPENCLAW_USE_STORED_DEVICE_LIST_AUTH || "unset",
    ].join(":") + "\\n",
  );
  process.stdout.write("{}\\n");
  process.exit(0);
}
process.exit(2);
`,
        { mode: 0o755 },
      );

      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${tmpDir}:/usr/bin:/bin`,
          OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_GATEWAY_TOKEN: "secret-token",
        },
        timeout: 10_000,
      });

      const approvals = fs.existsSync(approvalsFile)
        ? fs.readFileSync(approvalsFile, "utf-8").trim().split("\n").filter(Boolean)
        : [];
      const approveEnv = fs.existsSync(approveEnvFile)
        ? fs.readFileSync(approveEnvFile, "utf-8").trim().split("\n").filter(Boolean)
        : [];
      const listEnv = fs.existsSync(listEnvFile)
        ? fs.readFileSync(listEnvFile, "utf-8").trim().split("\n").filter(Boolean)
        : [];

      expect(approvals).toEqual(["ok-webchat", "ok-cli", "ok-agent-cli"]);
      expect(listEnv).toEqual(["ws://127.0.0.1:18789:18789:secret-token:unset"]);
      // Gateway env stripped on the approve subprocess (#4462 workaround).
      expect(approveEnv).toEqual([
        "unset:unset:unset:unset",
        "unset:unset:unset:unset",
        "unset:unset:unset:unset",
      ]);
      expect(result.stdout).toContain(`${SUMMARY_MARKER}=3`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  const pyIt =
    spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status === 0 ? it : it.skip;

  const approveOnlyOneLocalClonePairing = () => {
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const script = buildAutoPairApprovalScript(
      Buffer.from(policy as string, "utf-8").toString("base64"),
      {
        emitSummary: true,
        emitReceipt: true,
        localDeviceOnly: true,
        budget: { maxApprovals: 1 },
      },
    );
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-restored-clone-pair-"));
    try {
      const stateDir = path.join(tmpDir, "openclaw-state");
      const identityDir = path.join(stateDir, "identity");
      const approvalsFile = path.join(tmpDir, "approvals.log");
      const approveEnvFile = path.join(tmpDir, "approve-env.log");
      const listEnvFile = path.join(tmpDir, "list-env.log");
      const deviceAuthReadyFile = path.join(tmpDir, "device-auth-ready");
      fs.mkdirSync(identityDir, { recursive: true });
      const publicKey = "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8";
      const deviceId = "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47";
      fs.writeFileSync(
        path.join(identityDir, "device.json"),
        JSON.stringify({
          deviceId,
          publicKeyPem:
            "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAy3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8=\n-----END PUBLIC KEY-----\n",
        }),
      );
      fs.writeFileSync(
        path.join(tmpDir, "openclaw"),
        `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "devices" && args[1] === "list") {
  fs.appendFileSync(
    ${JSON.stringify(listEnvFile)},
    [
      process.env.OPENCLAW_GATEWAY_URL || "unset",
      process.env.OPENCLAW_GATEWAY_PORT || "unset",
      process.env.OPENCLAW_GATEWAY_TOKEN || "unset",
      process.env.NEMOCLAW_OPENCLAW_USE_STORED_DEVICE_LIST_AUTH || "unset",
      process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING || "unset",
      process.env.NEMOCLAW_OPENCLAW_REQUIRE_STORED_DEVICE_APPROVAL || "unset",
    ].join(":") + "\\n",
  );
  if (process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING === "1") {
    if (
      !process.env.OPENCLAW_GATEWAY_URL ||
      !process.env.OPENCLAW_GATEWAY_PORT ||
      !process.env.OPENCLAW_GATEWAY_TOKEN ||
      process.env.NEMOCLAW_OPENCLAW_USE_STORED_DEVICE_LIST_AUTH
    ) {
      process.stderr.write("credential convergence environment was not bounded\\n");
      process.exit(4);
    }
    if (process.env.NEMOCLAW_CREDENTIAL_LIST_FAIL === "1") {
      process.stderr.write("raw credential list output must stay private\\n");
      process.exit(5);
    }
    fs.writeFileSync(${JSON.stringify(deviceAuthReadyFile)}, "ready");
    process.stdout.write(process.env.NEMOCLAW_CREDENTIAL_LIST_RESPONSE + "\\n");
    process.exit(0);
  }
  if (
    process.env.OPENCLAW_GATEWAY_URL ||
    process.env.OPENCLAW_GATEWAY_PORT ||
    process.env.OPENCLAW_GATEWAY_TOKEN
  ) {
    process.stderr.write("restored clone list retained shared gateway credentials\\n");
    process.exit(3);
  }
  if (!fs.existsSync(${JSON.stringify(deviceAuthReadyFile)})) {
    process.stderr.write("stored device auth did not converge\\n");
    process.exit(6);
  }
  process.stdout.write(process.env.NEMOCLAW_LIST_RESPONSE + "\\n");
  process.exit(0);
}
if (args[0] === "devices" && args[1] === "approve") {
  if (
    process.env.OPENCLAW_GATEWAY_URL ||
    process.env.OPENCLAW_GATEWAY_PORT ||
    process.env.OPENCLAW_GATEWAY_TOKEN ||
    process.env.NEMOCLAW_OPENCLAW_USE_STORED_DEVICE_LIST_AUTH ||
    process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING ||
    process.env.NEMOCLAW_OPENCLAW_REQUIRE_STORED_DEVICE_APPROVAL !== "1"
  ) {
    process.stderr.write("restored clone approval environment was not fail closed\\n");
    process.exit(7);
  }
  if (process.env.NEMOCLAW_APPROVE_FAIL === "1") {
    process.stderr.write("raw approval output must stay private\\n");
    process.exit(1);
  }
  fs.appendFileSync(${JSON.stringify(approvalsFile)}, args[2] + "\\n");
  fs.appendFileSync(
    ${JSON.stringify(approveEnvFile)},
    [
      process.env.OPENCLAW_GATEWAY_URL || "unset",
      process.env.OPENCLAW_GATEWAY_PORT || "unset",
      process.env.OPENCLAW_GATEWAY_TOKEN || "unset",
      process.env.NEMOCLAW_OPENCLAW_USE_STORED_DEVICE_LIST_AUTH || "unset",
      process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING || "unset",
      process.env.NEMOCLAW_OPENCLAW_REQUIRE_STORED_DEVICE_APPROVAL || "unset",
    ].join(":") + "\\n",
  );
  process.stdout.write("{}\\n");
  process.exit(0);
}
process.exit(2);
`,
        { mode: 0o755 },
      );
      const run = (
        pending: unknown[],
        options: {
          rawListResponse?: string;
          failApproval?: boolean;
          failCredentialList?: boolean;
        } = {},
      ) => {
        fs.rmSync(deviceAuthReadyFile, { force: true });
        return spawnSync("sh", ["-c", script], {
          encoding: "utf-8",
          env: {
            ...process.env,
            PATH: `${tmpDir}:/usr/bin:/bin`,
            NEMOCLAW_CREDENTIAL_LIST_RESPONSE: JSON.stringify({ pending: [], paired: [] }),
            NEMOCLAW_CREDENTIAL_LIST_FAIL: options.failCredentialList ? "1" : "0",
            NEMOCLAW_LIST_RESPONSE:
              options.rawListResponse ?? JSON.stringify({ pending, paired: [] }),
            NEMOCLAW_APPROVE_FAIL: options.failApproval ? "1" : "0",
            OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
            OPENCLAW_GATEWAY_PORT: "18789",
            OPENCLAW_GATEWAY_TOKEN: "secret-token",
            OPENCLAW_STATE_DIR: stateDir,
          },
          timeout: 10_000,
        });
      };
      const readApprovals = () =>
        fs.existsSync(approvalsFile)
          ? fs.readFileSync(approvalsFile, "utf-8").trim().split("\n").filter(Boolean)
          : [];
      const resetLogs = () => {
        fs.rmSync(approvalsFile, { force: true });
        fs.rmSync(approveEnvFile, { force: true });
        fs.rmSync(listEnvFile, { force: true });
      };
      const localRequest = {
        requestId: "clone-pairing",
        deviceId,
        publicKey,
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.pairing"],
      };
      const foreignRequest = {
        ...localRequest,
        requestId: "primary-pairing",
        deviceId: "f".repeat(64),
        publicKey: "foreign-public-key",
      };

      const initial = run([foreignRequest, localRequest]);
      expect(initial.status).toBe(0);
      expect(initial.stdout).toContain(`${SUMMARY_MARKER}=1`);
      expect(initial.stdout).toContain(`${RECEIPT_MARKER}=approved-one`);
      expect(readApprovals()).toEqual(["clone-pairing"]);
      expect(fs.readFileSync(listEnvFile, "utf-8").trim().split("\n")).toEqual([
        "ws://127.0.0.1:18789:18789:secret-token:unset:1:unset",
        "unset:unset:unset:1:unset:unset",
      ]);
      expect(fs.readFileSync(approveEnvFile, "utf-8").trim()).toBe(
        "unset:unset:unset:unset:unset:1",
      );

      resetLogs();
      const repairRequest = {
        ...localRequest,
        requestId: "clone-write-upgrade",
        isRepair: true,
        scopes: ["operator.pairing", "operator.write"],
      };
      const repair = run([foreignRequest, repairRequest]);
      expect(repair.status).toBe(0);
      expect(repair.stdout).toContain(`${SUMMARY_MARKER}=1`);
      expect(readApprovals()).toEqual(["clone-write-upgrade"]);
      resetLogs();
      const combinedInitialRequest = {
        ...localRequest,
        requestId: "clone-pairing-with-write",
        isRepair: false,
        scopes: ["operator.pairing", "operator.write"],
      };
      const combinedInitial = run([foreignRequest, combinedInitialRequest]);
      expect(combinedInitial.status).toBe(0);
      expect(combinedInitial.stdout).toContain(`${SUMMARY_MARKER}=1`);
      expect(readApprovals()).toEqual(["clone-pairing-with-write"]);
      resetLogs();
      const writeOnlyInitialRequest = {
        ...localRequest,
        requestId: "clone-write-only",
        isRepair: false,
        scopes: ["operator.write"],
      };
      const writeOnlyInitial = run([foreignRequest, writeOnlyInitialRequest]);
      expect(writeOnlyInitial.status).toBe(0);
      expect(writeOnlyInitial.stdout).toContain(`${SUMMARY_MARKER}=1`);
      expect(readApprovals()).toEqual(["clone-write-only"]);

      resetLogs();
      const listFailed = run([], { rawListResponse: "raw list output must stay private" });
      expect(listFailed.stdout).toContain(`${RECEIPT_MARKER}=list-invalid-output`);
      expect(`${listFailed.stdout}${listFailed.stderr}`).not.toContain("raw list output");

      resetLogs();
      const credentialListFailed = run([], { failCredentialList: true });
      expect(credentialListFailed.stdout).toContain(`${RECEIPT_MARKER}=credential-list-failed`);
      expect(`${credentialListFailed.stdout}${credentialListFailed.stderr}`).not.toContain(
        "raw credential list output",
      );

      resetLogs();
      const noMatch = run([foreignRequest]);
      expect(noMatch.stdout).toContain(`${RECEIPT_MARKER}=clone-no-match`);

      resetLogs();
      const ambiguous = run([
        repairRequest,
        { ...repairRequest, requestId: "second-clone-upgrade" },
      ]);
      expect(ambiguous.stdout).toContain(`${RECEIPT_MARKER}=clone-ambiguous`);

      resetLogs();
      const rejected = run([{ ...repairRequest, publicKey: "mismatched-public-key" }]);
      expect(rejected.stdout).toContain(`${RECEIPT_MARKER}=request-rejected`);

      resetLogs();
      const approveFailed = run([repairRequest], { failApproval: true });
      expect(approveFailed.stdout).toContain(`${RECEIPT_MARKER}=approve-failed`);
      expect(`${approveFailed.stdout}${approveFailed.stderr}`).not.toContain("raw approval output");

      const { scopes: _ignoredScopes, ...repairWithoutScopes } = repairRequest;
      for (const rejected of [
        [foreignRequest],
        [{ ...repairRequest, publicKey: "mismatched-public-key" }],
        [repairRequest, { ...repairRequest, requestId: "second-clone-upgrade" }],
        [repairRequest, { ...foreignRequest, requestId: repairRequest.requestId }],
        [{ ...repairRequest, requestedScopes: ["operator.admin"] }],
        [{ ...repairRequest, requestedScopes: repairRequest.scopes }],
        [{ ...repairRequest, scopes: [] }],
        [{ ...localRequest, requestId: "unpaired-read-only", scopes: ["operator.read"] }],
        [repairWithoutScopes],
      ]) {
        resetLogs();
        const result = run(rejected);
        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain(`${SUMMARY_MARKER}=1`);
        expect(readApprovals()).toEqual([]);
      }

      resetLogs();
      const hashMismatchedDeviceId = "0".repeat(64);
      fs.writeFileSync(
        path.join(identityDir, "device.json"),
        JSON.stringify({ deviceId: hashMismatchedDeviceId, publicKey }),
      );
      const invalidIdentity = run([{ ...localRequest, deviceId: hashMismatchedDeviceId }]);
      expect(invalidIdentity.status).toBe(0);
      expect(invalidIdentity.stdout).not.toContain(`${SUMMARY_MARKER}=1`);
      expect(readApprovals()).toEqual([]);
      expect(fs.existsSync(approveEnvFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
  pyIt(
    "approves only one exact local clone pairing transition on a shared gateway",
    approveOnlyOneLocalClonePairing,
    30_000,
  );

  it("leaves a failed compatibility-shaped approval retryable without editing device state", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      return;
    }
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const policyB64 = Buffer.from(policy as string, "utf-8").toString("base64");
    const script = buildAutoPairApprovalScript(policyB64, { emitSummary: true });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-recover-"));
    try {
      const stateDir = path.join(tmpDir, "openclaw-state");
      const devicesDir = path.join(stateDir, "devices");
      const pendingFile = path.join(devicesDir, "pending.json");
      const pairedFile = path.join(devicesDir, "paired.json");
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.writeFileSync(
        pendingFile,
        JSON.stringify({
          original: {
            requestId: "upgrade-1",
            deviceId: "device-1",
            publicKey: "public-key-1",
            clientId: "openclaw-cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.write"],
          },
        }),
      );
      fs.writeFileSync(
        pairedFile,
        JSON.stringify({
          "device-1": {
            deviceId: "device-1",
            publicKey: "public-key-1",
            clientId: "openclaw-cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.pairing"],
            approvedScopes: ["operator.pairing"],
            tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
          },
        }),
      );
      const listResponse = JSON.stringify({
        pending: [
          {
            requestId: "upgrade-1",
            deviceId: "device-1",
            publicKey: "public-key-1",
            clientId: "openclaw-cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.write"],
          },
        ],
        paired: [],
      });
      fs.writeFileSync(
        path.join(tmpDir, "openclaw"),
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "devices" && args[1] === "list") {
  process.stdout.write(${JSON.stringify(`${listResponse}\n`)});
  process.exit(0);
}
if (args[0] === "devices" && args[1] === "approve") {
  process.stderr.write("GatewayClientRequestError: scope upgrade pending approval for requestId upgrade-1\\n");
  process.exit(1);
}
process.exit(2);
`,
        { mode: 0o755 },
      );

      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${tmpDir}:/usr/bin:/bin`,
          OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_GATEWAY_TOKEN: "secret-token",
          OPENCLAW_STATE_DIR: stateDir,
        },
        timeout: 10_000,
      });

      const pending = JSON.parse(fs.readFileSync(pendingFile, "utf-8"));
      const paired = JSON.parse(fs.readFileSync(pairedFile, "utf-8"));
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`${SUMMARY_MARKER}=0`);
      expect(pending).toEqual({
        original: {
          requestId: "upgrade-1",
          deviceId: "device-1",
          publicKey: "public-key-1",
          clientId: "openclaw-cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.write"],
        },
      });
      expect(paired["device-1"].approvedScopes).toEqual(["operator.pairing"]);
      expect(paired["device-1"].tokens.operator.scopes).toEqual(["operator.pairing"]);
      expect(JSON.stringify(paired)).not.toContain("operator.admin");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not recover approval failures without the compatibility signature (#4462)", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      return;
    }
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const policyB64 = Buffer.from(policy as string, "utf-8").toString("base64");
    const script = buildAutoPairApprovalScript(policyB64, { emitSummary: true });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-denied-"));
    try {
      const stateDir = path.join(tmpDir, "openclaw-state");
      const devicesDir = path.join(stateDir, "devices");
      const pendingFile = path.join(devicesDir, "pending.json");
      const pairedFile = path.join(devicesDir, "paired.json");
      fs.mkdirSync(devicesDir, { recursive: true });
      const pendingState = {
        original: {
          requestId: "upgrade-1",
          deviceId: "device-1",
          clientId: "openclaw-cli",
          clientMode: "cli",
          scopes: ["operator.write"],
        },
      };
      const pairedState = {
        "device-1": {
          deviceId: "device-1",
          scopes: ["operator.pairing"],
          approvedScopes: ["operator.pairing"],
          tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
        },
      };
      fs.writeFileSync(pendingFile, JSON.stringify(pendingState));
      fs.writeFileSync(pairedFile, JSON.stringify(pairedState));
      const listResponse = JSON.stringify({ pending: [pendingState.original], paired: [] });
      fs.writeFileSync(
        path.join(tmpDir, "openclaw"),
        `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "devices" && args[1] === "list") {
  process.stdout.write(${JSON.stringify(`${listResponse}\n`)});
  process.exit(0);
}
if (args[0] === "devices" && args[1] === "approve") {
  process.stderr.write("authorization denied\\n");
  process.exit(1);
}
process.exit(2);
`,
        { mode: 0o755 },
      );

      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${tmpDir}:/usr/bin:/bin`,
          OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_GATEWAY_TOKEN: "secret-token",
          OPENCLAW_STATE_DIR: stateDir,
        },
        timeout: 10_000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`${SUMMARY_MARKER}=0`);
      expect(JSON.parse(fs.readFileSync(pendingFile, "utf-8"))).toEqual(pendingState);
      expect(JSON.parse(fs.readFileSync(pairedFile, "utf-8"))).toEqual(pairedState);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
