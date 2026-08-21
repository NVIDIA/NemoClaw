// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildAutoPairApprovalScript,
  readAutoPairApprovalPolicyModule,
} from "./auto-pair-approval";

const SUMMARY_MARKER = "__NEMOCLAW_AUTO_PAIR_APPROVED__";
const python3Available =
  spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status === 0;

describe("ordinary auto-pair approval pass behaviour (#4616)", () => {
  it.runIf(python3Available)(
    "drops shared gateway overrides so OpenClaw can select its stored CLI credential (#9844)",
    () => {
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
      process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING || "unset",
      process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING || "unset",
      process.env.OPENCLAW_STATE_DIR || "unset",
      process.env.OPENCLAW_CONFIG_PATH || "unset",
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
      process.env.NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING || "unset",
      process.env.NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING || "unset",
      process.env.OPENCLAW_STATE_DIR || "unset",
      process.env.OPENCLAW_CONFIG_PATH || "unset",
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
            NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING: "1",
            NEMOCLAW_OPENCLAW_RESTORED_CLONE_PAIRING: "1",
            OPENCLAW_STATE_DIR: "/sandbox/.openclaw",
            OPENCLAW_CONFIG_PATH: "/sandbox/.openclaw/openclaw.json",
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
        // Both children drop shared gateway and compatibility overrides while
        // retaining the state/config paths OpenClaw needs to select its stored
        // CLI device credential (#9844).
        const expectedAuthEnv =
          "unset:unset:unset:unset:unset:/sandbox/.openclaw:/sandbox/.openclaw/openclaw.json";
        expect(listEnv).toEqual([expectedAuthEnv]);
        expect(approveEnv).toEqual([expectedAuthEnv, expectedAuthEnv, expectedAuthEnv]);
        expect(result.stdout).toContain(`${SUMMARY_MARKER}=3`);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
