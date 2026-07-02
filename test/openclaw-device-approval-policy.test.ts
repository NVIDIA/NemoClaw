// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const POLICY_PATH = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "lib",
  "openclaw_device_approval_policy.py",
);

const COMPAT_APPROVE_OUTPUT =
  "GatewayClientRequestError: scope upgrade pending approval for requestId request-1";
const INITIAL_PAIRING_APPROVE_OUTPUT =
  "GatewayClientRequestError: device pairing required (requestId: request-1)";
const CLI_DEVICE_ID = "45ca1f45e4a98f7f43cf36bb6bfb3542992eb98a9a5f2a527af767f62192b4b8";
const CLI_PUBLIC_KEY = "GBEmagaIvyPrVvist7yrKlIMpdTDxbwXaUPFJtp-AwQ";
const CLI_PUBLIC_KEY_PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGBEmagaIvyPrVvist7yrKlIMpdTDxbwXaUPFJtp+AwQ=\n-----END PUBLIC KEY-----\n";

function runRecovery(
  stateDir: string,
  requestId = "request-1",
  approveOutput = COMPAT_APPROVE_OUTPUT,
) {
  const script = `
import importlib.util
import json
import sys

policy_path, state_dir, request_id, approve_output = sys.argv[1:5]
spec = importlib.util.spec_from_file_location("openclaw_device_approval_policy", policy_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
result = module.recover_failed_scope_approval(request_id, state_dir, approve_output, None)
print(json.dumps(result, sort_keys=True))
`;
  return spawnSync("python3", ["-", POLICY_PATH, stateDir, requestId, approveOutput], {
    encoding: "utf-8",
    input: script,
    timeout: 10_000,
  });
}

function writeOriginalPendingState(stateDir: string) {
  const devicesDir = path.join(stateDir, "devices");
  fs.mkdirSync(devicesDir, { recursive: true });
  fs.writeFileSync(
    path.join(devicesDir, "pending.json"),
    JSON.stringify({
      original: {
        requestId: "request-1",
        deviceId: "device-1",
        clientId: "openclaw-cli",
        clientMode: "cli",
        scopes: ["operator.write"],
      },
    }),
  );
  fs.writeFileSync(
    path.join(devicesDir, "paired.json"),
    JSON.stringify({
      "device-1": {
        deviceId: "device-1",
        scopes: ["operator.pairing"],
        approvedScopes: ["operator.pairing"],
        tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
      },
    }),
  );
}

function writeInitialCliPairingState(stateDir: string) {
  const devicesDir = path.join(stateDir, "devices");
  const identityDir = path.join(stateDir, "identity");
  fs.mkdirSync(devicesDir, { recursive: true });
  fs.mkdirSync(identityDir, { recursive: true });
  fs.writeFileSync(
    path.join(devicesDir, "pending.json"),
    JSON.stringify({
      "request-1": {
        requestId: "request-1",
        deviceId: CLI_DEVICE_ID,
        publicKey: CLI_PUBLIC_KEY,
        platform: "linux",
        clientId: "cli",
        clientMode: "cli",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.pairing", "operator.write"],
      },
    }),
  );
  fs.writeFileSync(path.join(devicesDir, "paired.json"), "{}");
  fs.writeFileSync(
    path.join(identityDir, "device.json"),
    JSON.stringify({
      version: 1,
      deviceId: CLI_DEVICE_ID,
      publicKeyPem: CLI_PUBLIC_KEY_PEM,
    }),
  );
}

describe("openclaw device approval policy (#4462)", () => {
  it("recovers initial CLI pairing when the failed approve leaves a safe same-device request", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeInitialCliPairingState(stateDir);
      const devicesDir = path.join(stateDir, "devices");
      const pendingFile = path.join(devicesDir, "pending.json");
      const pairedFile = path.join(devicesDir, "paired.json");
      const authFile = path.join(stateDir, "identity", "device-auth.json");

      const result = runRecovery(stateDir, "request-1", INITIAL_PAIRING_APPROVE_OUTPUT);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).compatibility).toBe(
        "openclaw-approve-recovered-initial-cli",
      );
      expect(JSON.parse(fs.readFileSync(pendingFile, "utf-8"))).toEqual({});
      const paired = JSON.parse(fs.readFileSync(pairedFile, "utf-8"));
      const expectedScopes = ["operator.pairing", "operator.read", "operator.write"];
      expect(paired[CLI_DEVICE_ID].publicKey).toBe(CLI_PUBLIC_KEY);
      expect(paired[CLI_DEVICE_ID].clientId).toBe("cli");
      expect(paired[CLI_DEVICE_ID].approvedScopes).toEqual(expectedScopes);
      expect(paired[CLI_DEVICE_ID].tokens.operator.scopes).toEqual(expectedScopes);
      expect(paired[CLI_DEVICE_ID].tokens.operator.token).toBeTruthy();
      const auth = JSON.parse(fs.readFileSync(authFile, "utf-8"));
      expect(auth.deviceId).toBe(CLI_DEVICE_ID);
      expect(auth.tokens.operator.scopes).toEqual(expectedScopes);
      expect(auth.tokens.operator.token).toBe(paired[CLI_DEVICE_ID].tokens.operator.token);
      expect(JSON.stringify(paired)).not.toContain("operator.admin");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not recover initial CLI pairing when the identity key does not match", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeInitialCliPairingState(stateDir);
      const identityFile = path.join(stateDir, "identity", "device.json");
      fs.writeFileSync(identityFile, JSON.stringify({ version: 1, deviceId: "wrong" }));

      const result = runRecovery(stateDir, "request-1", INITIAL_PAIRING_APPROVE_OUTPUT);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("recovers allowlisted upgrades when the failed approve leaves the original request pending", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeOriginalPendingState(stateDir);
      const devicesDir = path.join(stateDir, "devices");
      const pendingFile = path.join(devicesDir, "pending.json");
      const pairedFile = path.join(devicesDir, "paired.json");

      const result = runRecovery(stateDir);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).compatibility).toBe("openclaw-approve-recovered-original");
      expect(JSON.parse(fs.readFileSync(pendingFile, "utf-8"))).toEqual({});
      const paired = JSON.parse(fs.readFileSync(pairedFile, "utf-8"));
      const expectedScopes = ["operator.pairing", "operator.read", "operator.write"];
      expect(paired["device-1"].approvedScopes).toEqual(expectedScopes);
      expect(paired["device-1"].tokens.operator.scopes).toEqual(expectedScopes);
      expect(JSON.stringify(paired)).not.toContain("operator.admin");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not recover original pending requests after unrelated approve errors", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      return;
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-policy-"));
    try {
      const stateDir = path.join(tmpDir, "state");
      writeOriginalPendingState(stateDir);
      const devicesDir = path.join(stateDir, "devices");
      const pendingFile = path.join(devicesDir, "pending.json");
      const pairedFile = path.join(devicesDir, "paired.json");
      const pendingBefore = fs.readFileSync(pendingFile, "utf-8");
      const pairedBefore = fs.readFileSync(pairedFile, "utf-8");

      const result = runRecovery(stateDir, "request-1", "authorization denied");

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toBeNull();
      expect(fs.readFileSync(pendingFile, "utf-8")).toBe(pendingBefore);
      expect(fs.readFileSync(pairedFile, "utf-8")).toBe(pairedBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
