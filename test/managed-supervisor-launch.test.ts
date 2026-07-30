// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HELPER = path.join(import.meta.dirname, "..", "scripts", "managed-gateway-control.py");
const NONCE = "a".repeat(64);
const MERGED_CA = "/tmp/nemoclaw-ca-bundle.pem";

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
environment = control._supervisor_launch_environment(
    runtime, "/tmp/nemoclaw-ca-bundle.pem"
)
print(json.dumps({
    "action": action,
    "nonce": nonce,
    "runtime": runtime,
    "identity": {
        key: environment.get(key)
        for key in ("HOME", "LOGNAME", "PATH", "SHELL", "USER")
    },
    "python_no_user_site": environment.get("PYTHONNOUSERSITE"),
    "ca": {
        key: environment.get(key)
        for key in control.CA_ENV_KEYS
    },
    "stripped": {
        key: key in environment
        for key in ("LD_PRELOAD", "NODE_OPTIONS", "NEMOCLAW_TEST_ESCAPE")
    },
    "container_credential": environment.get("NVIDIA_INFERENCE_API_KEY"),
}, sort_keys=True))
`;

const SUPERVISOR_CA_REFRESH_HARNESS = String.raw`
import importlib.util
import json
import os
import stat
import sys
import tempfile

spec = importlib.util.spec_from_file_location("managed_control_ca", sys.argv[1])
control = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = control
spec.loader.exec_module(control)

with tempfile.TemporaryDirectory() as root:
    system_root = os.path.join(root, "system")
    openshell = os.path.join(system_root, "etc", "openshell-tls", "ca-bundle.pem")
    corporate = os.path.join(
        system_root, "usr", "local", "share", "nemoclaw", "corporate-ca.pem"
    )
    merged = os.path.join(system_root, "tmp", "nemoclaw-ca-bundle.pem")
    for directory in (os.path.dirname(openshell), os.path.dirname(corporate), os.path.dirname(merged)):
        os.makedirs(directory, exist_ok=True)
    for path, contents in (
        (openshell, b"CURRENT-OPENSHELL-CA\n"),
        (corporate, b"CORPORATE-CA\n"),
        (merged, b"STALE-OPENSHELL-CA\nCORPORATE-CA\n"),
    ):
        with open(path, "wb") as stream:
            stream.write(contents)
        os.chmod(path, 0o444)

    os.environ["NEMOCLAW_MANAGED_CONTROL_ALLOW_NONROOT_TEST"] = "1"
    os.environ["NEMOCLAW_MANAGED_CONTROL_SYSTEM_ROOT"] = system_root
    selected = control._refresh_supervisor_ca_bundle()
    with open(merged, "rb") as stream:
        contents = stream.read().decode("ascii")
    metadata = os.stat(merged, follow_symlinks=False)

    print(json.dumps({
        "selected": selected,
        "contents": contents,
        "mode": stat.S_IMODE(metadata.st_mode),
    }, sort_keys=True))
`;

describe("managed supervisor launch", () => {
  it("allowlists launch inputs without inherited credentials or loader hooks", () => {
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
      ca: {
        CURL_CA_BUNDLE: MERGED_CA,
        GIT_SSL_CAINFO: MERGED_CA,
        NODE_EXTRA_CA_CERTS: MERGED_CA,
        REQUESTS_CA_BUNDLE: MERGED_CA,
        SSL_CERT_FILE: MERGED_CA,
      },
      stripped: {
        LD_PRELOAD: false,
        NEMOCLAW_TEST_ESCAPE: false,
        NODE_OPTIONS: false,
      },
      container_credential: null,
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

  it("replaces the stale merged CA with the current OpenShell and corporate roots", () => {
    const result = spawnSync("python3", ["-c", SUPERVISOR_CA_REFRESH_HARNESS, HELPER], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      selected: MERGED_CA,
      contents: "CURRENT-OPENSHELL-CA\nCORPORATE-CA\n",
      mode: 0o444,
    });
  });
});
