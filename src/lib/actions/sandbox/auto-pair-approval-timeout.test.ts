// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildAutoPairApprovalScript,
  parseAutoPairApprovalReceipt,
  readAutoPairApprovalPolicyModule,
} from "./auto-pair-approval";

describe("restored-clone approval timeout", () => {
  const pyIt =
    spawnSync("sh", ["-c", "command -v python3"], { stdio: "ignore" }).status === 0 ? it : it.skip;

  pyIt(
    "synchronizes the clone credential when the agent gateway commits after the approval child process times out (#7818)",
    () => {
      const policy = readAutoPairApprovalPolicyModule();
      expect(policy).toBeTruthy();
      const tmpDir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pair-timeout-")),
      );
      try {
        const stateDir = path.join(tmpDir, "openclaw-state");
        const devicesDir = path.join(stateDir, "devices");
        const identityDir = path.join(stateDir, "identity");
        const pendingPath = path.join(devicesDir, "pending.json");
        const pairedPath = path.join(devicesDir, "paired.json");
        const authPath = path.join(identityDir, "device-auth.json");
        const callsPath = path.join(tmpDir, "approve-calls.log");
        fs.mkdirSync(devicesDir, { recursive: true });
        fs.mkdirSync(identityDir, { recursive: true });

        const deviceId = "04a4c561c730435e9f6a2e38d2e7b929bcbec2ea1c37d3dd053f3341ecce4e47";
        const publicKey = "y3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8";
        const request = {
          requestId: "clone-write-upgrade",
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.pairing", "operator.write"],
          isRepair: true,
        };
        const pairedDevice = {
          deviceId,
          publicKey,
          clientId: "cli",
          clientMode: "cli",
          role: "operator",
          roles: ["operator"],
          scopes: ["operator.pairing"],
          approvedScopes: ["operator.pairing"],
          tokens: {
            operator: {
              token: "clone-device-token",
              role: "operator",
              scopes: ["operator.pairing"],
            },
          },
        };
        fs.writeFileSync(
          path.join(identityDir, "device.json"),
          JSON.stringify({
            deviceId,
            publicKeyPem:
              "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAy3vjb9p8tAecivI1l5f1Hdc9QdZJSt3BmLkJMM7wZD8=\n-----END PUBLIC KEY-----\n",
          }),
        );
        fs.writeFileSync(pendingPath, JSON.stringify({ [request.requestId]: request }));
        fs.writeFileSync(pairedPath, JSON.stringify({ [deviceId]: pairedDevice }));
        fs.writeFileSync(
          authPath,
          JSON.stringify({
            version: 1,
            deviceId,
            tokens: pairedDevice.tokens,
          }),
        );
        fs.writeFileSync(
          path.join(tmpDir, "openclaw"),
          `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== "devices" || args[1] !== "approve") process.exit(2);
process.stderr.write("raw timed-out approval output must stay private\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
`,
          { mode: 0o755 },
        );

        const delayedCommitPolicy = `${policy}
import json as _nemoclaw_test_json
import subprocess as _nemoclaw_test_subprocess
import threading as _nemoclaw_test_threading
import time as _nemoclaw_test_time
_nemoclaw_test_original_run = _nemoclaw_test_subprocess.run

def _nemoclaw_test_publish_delayed_approval():
    _nemoclaw_test_time.sleep(0.5)
    with open(${JSON.stringify(pendingPath)}, encoding='utf-8') as handle:
        pending_after = _nemoclaw_test_json.load(handle)
    with open(${JSON.stringify(pairedPath)}, encoding='utf-8') as handle:
        paired_after = _nemoclaw_test_json.load(handle)
    request_after = pending_after.pop(${JSON.stringify(request.requestId)})
    paired_after[${JSON.stringify(deviceId)}] = {
        **paired_after[${JSON.stringify(deviceId)}],
        'scopes': request_after['scopes'],
        'approvedScopes': request_after['scopes'],
        'tokens': {
            'operator': {
                'token': 'rotated-clone-device-token',
                'role': 'operator',
                'scopes': ['operator.pairing', 'operator.read', 'operator.write'],
            },
        },
    }
    with open(${JSON.stringify(pairedPath)}, 'w', encoding='utf-8') as handle:
        _nemoclaw_test_json.dump(paired_after, handle)
    with open(${JSON.stringify(pendingPath)}, 'w', encoding='utf-8') as handle:
        _nemoclaw_test_json.dump(pending_after, handle)

def _nemoclaw_test_delay_commit(*args, **kwargs):
    command = args[0] if args else kwargs.get('args', [])
    if isinstance(command, list) and command[1:3] == ['devices', 'approve']:
        with open(${JSON.stringify(callsPath)}, 'a', encoding='utf-8') as handle:
            handle.write('called\\n')
        _nemoclaw_test_threading.Thread(
            target=_nemoclaw_test_publish_delayed_approval,
            daemon=True,
        ).start()
    return _nemoclaw_test_original_run(*args, **kwargs)

_nemoclaw_test_subprocess.run = _nemoclaw_test_delay_commit
`;
        const script = buildAutoPairApprovalScript(
          Buffer.from(delayedCommitPolicy, "utf-8").toString("base64"),
          {
            emitReceipt: true,
            localDeviceOnly: true,
            budget: { maxApprovals: 1, approveTimeoutS: 0.25 },
          },
        );
        const result = spawnSync("sh", ["-c", script], {
          encoding: "utf-8",
          env: {
            ...process.env,
            PATH: `${tmpDir}:/usr/bin:/bin`,
            OPENCLAW_GATEWAY_PORT: "18789",
            OPENCLAW_STATE_DIR: stateDir,
          },
          timeout: 10_000,
        });

        expect(result.status).toBe(0);
        expect(parseAutoPairApprovalReceipt(result.stdout)).toBe("approved-one");
        expect(fs.readFileSync(callsPath, "utf-8").trim().split("\n")).toEqual(["called"]);
        expect(`${result.stdout}${result.stderr}`).not.toContain("raw timed-out approval output");
        expect(JSON.parse(fs.readFileSync(authPath, "utf-8"))).toMatchObject({
          version: 1,
          deviceId,
          tokens: {
            operator: {
              token: "rotated-clone-device-token",
              role: "operator",
              scopes: ["operator.pairing", "operator.read", "operator.write"],
            },
          },
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    10_000,
  );
});
