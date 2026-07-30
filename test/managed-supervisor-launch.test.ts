// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HELPER = path.join(import.meta.dirname, "..", "scripts", "managed-gateway-control.py");
const NONCE = "a".repeat(64);

const SUPERVISOR_LAUNCH_ENV_HARNESS = String.raw`
import importlib.util
import json
import os
import sys

spec = importlib.util.spec_from_file_location("managed_control_launch", sys.argv[1])
control = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = control
spec.loader.exec_module(control)

os.environ.update({
    "LD_PRELOAD": "/attacker/preload.so",
    "NODE_OPTIONS": "--require=/attacker/hook.js",
    "NEMOCLAW_TEST_ESCAPE": "attacker",
    "NVIDIA_INFERENCE_API_KEY": "container-owned-placeholder",
})
action, nonce, runtime = control._validate_request([
    "launch-supervisor",
    "a" * 64,
    "CHAT_UI_URL=http://127.0.0.1:18789",
    "NEMOCLAW_DASHBOARD_PORT=18789",
    "HTTPS_PROXY=https://proxy.example/path?token=a=b",
])
environment = control._supervisor_launch_environment(runtime)
print(json.dumps({
    "action": action,
    "nonce": nonce,
    "runtime": runtime,
    "identity": {
        key: environment.get(key)
        for key in ("HOME", "LOGNAME", "PATH", "SHELL", "USER")
    },
    "python_no_user_site": environment.get("PYTHONNOUSERSITE"),
    "stripped": {
        key: key in environment
        for key in ("LD_PRELOAD", "NODE_OPTIONS", "NEMOCLAW_TEST_ESCAPE")
    },
    "container_environment": environment.get("NVIDIA_INFERENCE_API_KEY"),
}, sort_keys=True))
`;

describe("managed supervisor launch", () => {
  it("allowlists launch inputs and strips loader hooks before sandbox UID launch", () => {
    const result = spawnSync("python3", ["-c", SUPERVISOR_LAUNCH_ENV_HARNESS, HELPER], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      action: "launch-supervisor",
      nonce: NONCE,
      runtime: {
        CHAT_UI_URL: "http://127.0.0.1:18789",
        HTTPS_PROXY: "https://proxy.example/path?token=a=b",
        NEMOCLAW_DASHBOARD_PORT: "18789",
      },
      identity: {
        HOME: "/sandbox",
        LOGNAME: "sandbox",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        SHELL: "/bin/bash",
        USER: "sandbox",
      },
      python_no_user_site: "1",
      stripped: {
        LD_PRELOAD: false,
        NEMOCLAW_TEST_ESCAPE: false,
        NODE_OPTIONS: false,
      },
      container_environment: "container-owned-placeholder",
    });
  });

  it.each([
    [["launch-supervisor", NONCE, "UNREVIEWED=value"], "SUPERVISOR_INVALID_REQUEST"],
    [
      [
        "launch-supervisor",
        NONCE,
        "CHAT_UI_URL=http://127.0.0.1:18789",
        "CHAT_UI_URL=http://127.0.0.1:18790",
      ],
      "SUPERVISOR_INVALID_REQUEST",
    ],
    [["restart", NONCE, "CHAT_UI_URL=http://127.0.0.1:18789"], "SUPERVISOR_INVALID_REQUEST"],
  ])("rejects disallowed or duplicate request arguments before privilege use", (args, marker) => {
    const result = spawnSync("python3", [HELPER, ...args], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe(marker);
  });
});
