// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const runtime = resolve("agents/langchain-deepagents-code/managed-dcode-runtime.py");

const harness = String.raw`
import hashlib
import importlib.util
import json
import os
import stat
import tempfile
import fcntl
from pathlib import Path

for index, name in enumerate(("F_SEAL_WRITE", "F_SEAL_GROW", "F_SEAL_SHRINK", "F_SEAL_SEAL")):
    if not hasattr(fcntl, name):
        setattr(fcntl, name, 1 << index)

spec = importlib.util.spec_from_file_location("managed", ${JSON.stringify(runtime)})
managed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(managed)

root = Path(tempfile.mkdtemp(prefix="nemoclaw-validation-runtime-")).resolve()
executables = {
    "echo": "/bin/echo",
    "sleep": "/bin/sleep",
    "yes": "/usr/bin/yes",
}

commands = [
    {
        "id": "echo",
        "argv": [executables["echo"], "managed"],
        "workingDirectory": str(root),
        "environment": ["HOME", "LANG"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "timeout",
        "argv": [executables["sleep"], "2"],
        "workingDirectory": str(root),
        "environment": ["HOME"],
        "timeoutSeconds": 1,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "output",
        "argv": [executables["yes"], "bounded"],
        "workingDirectory": str(root),
        "environment": ["HOME"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 64,
        "maxInvocations": 1,
    },
]
content = {
    "schemaVersion": "nemoclaw.dcode.validation-profile.v1",
    "sandboxName": "validation-test",
    "taskIdentity": "issue-7774",
    "sourceIdentity": "sha256:" + ("a" * 64),
    "workingDirectoryRoots": [str(root)],
    "commands": commands,
}
digest = "sha256:" + hashlib.sha256(
    json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
).hexdigest()
profile = {**content, "contentDigest": digest}

def profile_is_rejected_with_secret(field):
    secret_content = json.loads(json.dumps(content))
    secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890"
    if field == "taskIdentity":
        secret_content[field] = secret
    else:
        secret_content["commands"][0][field] = secret
    secret_digest = "sha256:" + hashlib.sha256(
        json.dumps(
            secret_content, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ).encode()
    ).hexdigest()
    secret_profile = {**secret_content, "contentDigest": secret_digest}
    try:
        managed._canonical_validation_profile(
            json.dumps(secret_profile, separators=(",", ":")).encode()
        )
    except RuntimeError:
        return True
    return False

profile_path = root / "profile.json"
profile_path.write_text(
    json.dumps(profile, sort_keys=True, separators=(",", ":")),
    encoding="utf-8",
)
profile_path.chmod(0o444)
managed._VALIDATION_PROFILE_FILE = root / "absent-profile.json"
disabled = managed.managed_validation_profile_enabled()
managed._VALIDATION_PROFILE_FILE = profile_path
managed._MANAGED_FILE_OWNER_UID = os.getuid()

def run(command):
    receipt, succeeded = managed.execute_managed_validation_command(command)
    assert "managed" not in json.dumps(receipt)
    return {
        "status": receipt["terminalStatus"],
        "success": succeeded,
        "stdoutBytes": receipt["stdoutBytes"],
        "stderrBytes": receipt["stderrBytes"],
        "commandId": receipt["commandId"],
        "exitCode": receipt["exitCode"],
    }

results = {
    "allowed": run(f'{executables["echo"]} managed'),
    "extraArgument": run(f'{executables["echo"]} managed extra'),
    "metacharacter": run(f'{executables["echo"]} managed; touch {root / "escaped"}'),
    "environmentInjection": run(f'LANG=unsafe {executables["echo"]} managed'),
    "alternateExecutable": run(f'/usr/bin/printf managed'),
    "invocationExhausted": run(f'{executables["echo"]} managed'),
    "timeout": run(f'{executables["sleep"]} 2'),
    "output": run(f'{executables["yes"]} bounded'),
    "escaped": (root / "escaped").exists(),
    "disabled": disabled,
    "secretTaskIdentityRejected": profile_is_rejected_with_secret("taskIdentity"),
    "secretCommandIdRejected": profile_is_rejected_with_secret("id"),
}
print(json.dumps(results))
`;

describe("managed DCode validation-command runtime", () => {
  it("admits only exact argv and returns bounded content-free receipts (#7774)", () => {
    const result = spawnSync("python3", ["-c", harness], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const receipts = JSON.parse(result.stdout) as Record<
      string,
      { status: string; success: boolean; stdoutBytes: number }
    > & { disabled: boolean; escaped: boolean };
    expect(receipts.disabled).toBe(false);
    expect(receipts.allowed, JSON.stringify(receipts)).toMatchObject({
      status: "succeeded",
      success: true,
      commandId: "echo",
    });
    expect(receipts.extraArgument.status).toBe("rejected");
    expect(receipts.metacharacter.status).toBe("rejected");
    expect(receipts.environmentInjection.status).toBe("rejected");
    expect(receipts.alternateExecutable.status).toBe("rejected");
    expect(receipts.invocationExhausted.status).toBe("invocation_limit_exceeded");
    expect(receipts.timeout.status).toBe("timed_out");
    expect(receipts.output.status).toBe("output_limit_exceeded");
    expect(receipts.output.stdoutBytes).toBeLessThanOrEqual(64);
    expect(receipts.escaped).toBe(false);
    expect(receipts.secretTaskIdentityRejected).toBe(true);
    expect(receipts.secretCommandIdRejected).toBe(true);
  });
});
