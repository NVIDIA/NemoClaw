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
    expect(module).toContain("def gateway_approval_env");
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
          requestId: "deny-unknown",
          clientId: "evil",
          clientMode: "unknown",
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

      expect(approvals).toEqual(["ok-webchat", "ok-cli"]);
      // Gateway env stripped on the approve subprocess (#4462 workaround).
      expect(approveEnv).toEqual(["unset:unset:unset", "unset:unset:unset"]);
      expect(result.stdout).toContain(`${SUMMARY_MARKER}=2`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
