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
  readAutoPairApprovalPolicyModule,
  wrapSandboxShellScript,
} from "./auto-pair-approval";

const SUMMARY_MARKER = "__NEMOCLAW_AUTO_PAIR_APPROVED__";

describe("buildAutoPairApprovalScript (#4263/#4616)", () => {
  it("builds the bounded allowlisted approval pass", () => {
    const script = buildAutoPairApprovalScript("UE9MSUNZ");
    expect(script).toContain("/tmp/nemoclaw-proxy-env.sh");
    expect(script).toContain("command -v python3");
    expect(script).toContain("local_pairing_list(STATE_DIR)");
    expect(script).toContain("approve_allowlisted_request(request_id, STATE_DIR, device)");
    expect(script).toContain("prune_cli_pairing_only_devices(STATE_DIR)");
    expect(script).toContain("approval_request_decision(device, paired)");
    expect(script).toContain("if not decision['allowed']:");
    expect(script).toContain(`MAX_APPROVALS = ${AUTO_PAIR_MAX_APPROVALS}`);
    expect(script).toContain("'UE9MSUNZ'");
    expect(script).not.toContain("'devices', 'list'");
    expect(script).not.toContain("'devices', 'approve'");
  });

  it("omits the summary marker by default and appends it when requested", () => {
    const silent = buildAutoPairApprovalScript("UE9MSUNZ");
    const reporting = buildAutoPairApprovalScript("UE9MSUNZ", { emitSummary: true });
    expect(silent).not.toContain(SUMMARY_MARKER);
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
    expect(module).toContain("def local_pairing_list");
    expect(module).toContain("def approve_allowlisted_request");
    expect(module).toContain("def prune_cli_pairing_only_devices");
  });
});

describe("wrapSandboxShellScript (#4616)", () => {
  it("encodes a multi-line payload onto a single newline-free line", () => {
    const wrapped = wrapSandboxShellScript("echo one\necho two\n");
    expect(wrapped).not.toMatch(/[\n\r]/);
    expect(wrapped).toContain("base64 -d");
    expect(wrapped).toContain("mktemp");
  });

  it("round-trips and preserves the inner exit status when run", () => {
    const inner = "echo line-one\nprintf 'exit-then\\n'\nexit 3\n";
    const wrapped = wrapSandboxShellScript(inner);
    const result = spawnSync("sh", ["-c", wrapped], { encoding: "utf-8", timeout: 10_000 });
    expect(result.stdout).toContain("line-one");
    expect(result.stdout).toContain("exit-then");
    expect(result.status).toBe(3);
  });
});

describe("auto-pair approval pass behaviour (#4616)", () => {
  it("approves allowlisted local-state requests, skips unknown clients, and reports the count", () => {
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
      const stateDir = path.join(tmpDir, "openclaw-state");
      const devicesDir = path.join(stateDir, "devices");
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.writeFileSync(
        path.join(devicesDir, "pending.json"),
        JSON.stringify({
          "ok-webchat": {
            requestId: "ok-webchat",
            deviceId: "web-1",
            publicKey: "web-key",
            clientId: "openclaw-control-ui",
            clientMode: "webchat",
            role: "operator",
            scopes: ["operator.read", "operator.write"],
          },
          "ok-cli": {
            requestId: "ok-cli",
            deviceId: "cli-1",
            publicKey: "cli-key",
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            scopes: ["operator.write"],
          },
          "deny-unknown": {
            requestId: "deny-unknown",
            deviceId: "evil-1",
            publicKey: "evil-key",
            clientId: "evil",
            clientMode: "unknown",
            role: "operator",
            scopes: ["operator.read"],
          },
          "deny-admin": {
            requestId: "deny-admin",
            deviceId: "admin-1",
            publicKey: "admin-key",
            clientId: "openclaw-control-ui",
            clientMode: "webchat",
            role: "operator",
            scopes: ["operator.admin"],
          },
          "deny-cli-first": {
            requestId: "deny-cli-first",
            deviceId: "cli-new",
            publicKey: "cli-new-key",
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            scopes: ["operator.write"],
          },
        }),
      );
      fs.writeFileSync(
        path.join(devicesDir, "paired.json"),
        JSON.stringify({
          "cli-1": {
            deviceId: "cli-1",
            publicKey: "cli-key",
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.pairing"],
            approvedScopes: ["operator.pairing"],
            tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
            createdAtMs: 1,
            approvedAtMs: 1,
          },
        }),
      );

      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `/usr/bin:/bin`,
          OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_GATEWAY_TOKEN: "secret-token",
          OPENCLAW_STATE_DIR: stateDir,
        },
        timeout: 10_000,
      });

      const pending = JSON.parse(fs.readFileSync(path.join(devicesDir, "pending.json"), "utf-8"));
      const paired = JSON.parse(fs.readFileSync(path.join(devicesDir, "paired.json"), "utf-8"));

      expect(result.stdout).toContain(`${SUMMARY_MARKER}=2`);
      expect([...Object.keys(pending)].sort()).toEqual([
        "deny-admin",
        "deny-cli-first",
        "deny-unknown",
      ]);
      expect(paired["web-1"].approvedScopes).toEqual(["operator.read", "operator.write"]);
      expect(paired["cli-1"].approvedScopes).toEqual(["operator.pairing", "operator.write"]);
      expect(paired["cli-1"].tokens.operator.scopes).toEqual([
        "operator.pairing",
        "operator.write",
      ]);
      expect(JSON.stringify(paired)).not.toContain("operator.admin");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("removes stale CLI pairing-only devices so user agent commands can first-pair with write", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      return;
    }
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const policyB64 = Buffer.from(policy as string, "utf-8").toString("base64");
    const script = buildAutoPairApprovalScript(policyB64, { emitSummary: true });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-prune-"));
    try {
      const stateDir = path.join(tmpDir, "openclaw-state");
      const devicesDir = path.join(stateDir, "devices");
      const identityDir = path.join(stateDir, "identity");
      const pendingFile = path.join(devicesDir, "pending.json");
      const pairedFile = path.join(devicesDir, "paired.json");
      fs.mkdirSync(devicesDir, { recursive: true });
      fs.mkdirSync(identityDir, { recursive: true });
      fs.writeFileSync(pendingFile, JSON.stringify({}));
      fs.writeFileSync(
        pairedFile,
        JSON.stringify({
          "cli-1": {
            deviceId: "cli-1",
            clientId: "cli",
            clientMode: "cli",
            role: "operator",
            roles: ["operator"],
            scopes: ["operator.pairing"],
            approvedScopes: ["operator.pairing"],
            tokens: { operator: { role: "operator", scopes: ["operator.pairing"] } },
          },
        }),
      );
      fs.writeFileSync(
        path.join(identityDir, "device-auth.json"),
        JSON.stringify({
          version: 1,
          deviceId: "cli-1",
          tokens: { operator: { token: "old", role: "operator", scopes: ["operator.pairing"] } },
        }),
      );

      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `/usr/bin:/bin`,
          OPENCLAW_STATE_DIR: stateDir,
        },
        timeout: 10_000,
      });

      const pending = JSON.parse(fs.readFileSync(pendingFile, "utf-8"));
      const paired = JSON.parse(fs.readFileSync(pairedFile, "utf-8"));
      const identity = JSON.parse(
        fs.readFileSync(path.join(identityDir, "device-auth.json"), "utf-8"),
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`${SUMMARY_MARKER}=0`);
      expect(pending).toEqual({});
      expect(paired).toEqual({});
      expect(identity.tokens).toEqual({});
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not approve first-time CLI requests from NemoClaw's background pass", () => {
    if (spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status !== 0) {
      return;
    }
    const policy = readAutoPairApprovalPolicyModule();
    expect(policy).toBeTruthy();
    const policyB64 = Buffer.from(policy as string, "utf-8").toString("base64");
    const script = buildAutoPairApprovalScript(policyB64, { emitSummary: true });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-cli-first-"));
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
          publicKey: "cli-key",
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          scopes: ["operator.write"],
        },
      };
      const pairedState = {};
      fs.writeFileSync(pendingFile, JSON.stringify(pendingState));
      fs.writeFileSync(pairedFile, JSON.stringify(pairedState));

      const result = spawnSync("sh", ["-c", script], {
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `/usr/bin:/bin`,
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
