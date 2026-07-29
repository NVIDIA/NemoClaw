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
import multiprocessing
import os
import shutil
import stat
import subprocess
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
workspace = (root / "workspace").resolve()
workspace.mkdir()
unicode_root = (workspace / "café路径").resolve()
unicode_root.mkdir()
(workspace / "tracked.txt").write_text("immutable source\n", encoding="utf-8")
(unicode_root / ".keep").write_text("tracked unicode path\n", encoding="utf-8")
git_executable = str(Path(shutil.which("git")).resolve(strict=True))
for arguments in (
    ("init", "-q"),
    ("config", "user.name", "NemoClaw Test"),
    ("config", "user.email", "nemoclaw-test@example.invalid"),
    ("add", "."),
    ("commit", "-qm", "fixture"),
):
    subprocess.run(
        [git_executable, "-C", str(workspace), *arguments],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
object_format = subprocess.run(
    [git_executable, "-C", str(workspace), "rev-parse", "--show-object-format"],
    check=True,
    capture_output=True,
    text=True,
).stdout.strip()
object_id = subprocess.run(
    [git_executable, "-C", str(workspace), "rev-parse", "--verify", "HEAD^{commit}"],
    check=True,
    capture_output=True,
    text=True,
).stdout.strip()
source_identity = "sha256:" + hashlib.sha256(
    f"git:{object_format}:{object_id}".encode("ascii")
).hexdigest()
retry_executable = (root / "retry-executable").resolve()
retry_executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
retry_executable.chmod(0o777)
popen_retry_executable = (root / "popen-retry-executable").resolve()
popen_retry_executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
popen_retry_executable.chmod(0o755)
delayed_executable = (root / "delayed-executable").resolve()
delayed_executable.write_text(
    "#!/bin/sh\nexec >/dev/null 2>&1\nsleep 1.25\nexit 0\n",
    encoding="utf-8",
)
delayed_executable.chmod(0o755)
race_executable = (root / "race-executable").resolve()
race_executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
race_executable.chmod(0o755)
race_replacement = (root / "race-replacement").resolve()
race_replacement.write_text(
    f"#!/bin/sh\ntouch {root / 'race-escaped'}\nexit 7\n",
    encoding="utf-8",
)
race_replacement.chmod(0o755)
executables = {
    name: str(Path(shutil.which(name)).resolve(strict=True))
    for name in ("echo", "sleep", "yes")
}

commands = [
    {
        "id": "echo",
        "argv": [executables["echo"], "managed"],
        "workingDirectory": str(workspace),
        "environment": ["HOME", "LANG"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "timeout",
        "argv": [executables["sleep"], "2"],
        "workingDirectory": str(workspace),
        "environment": ["HOME"],
        "timeoutSeconds": 1,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "output",
        "argv": [executables["yes"], "bounded"],
        "workingDirectory": str(workspace),
        "environment": ["HOME"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 64,
        "maxInvocations": 1,
    },
    {
        "id": "unicode",
        "argv": [executables["echo"], "café/路径"],
        "workingDirectory": str(unicode_root),
        "environment": ["HOME"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "retry-after-rejection",
        "argv": [str(retry_executable)],
        "workingDirectory": str(workspace),
        "environment": ["HOME"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "delayed-exit",
        "argv": [str(delayed_executable)],
        "workingDirectory": str(workspace),
        "environment": ["HOME"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "popen-retry",
        "argv": [str(popen_retry_executable)],
        "workingDirectory": str(workspace),
        "environment": ["HOME"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "concurrent",
        "argv": [str(delayed_executable), "concurrent"],
        "workingDirectory": str(workspace),
        "environment": ["HOME"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "descriptor-bound",
        "argv": [str(race_executable)],
        "workingDirectory": str(workspace),
        "environment": ["HOME"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "dirty-source",
        "argv": [executables["echo"], "dirty-source"],
        "workingDirectory": str(workspace),
        "environment": ["HOME"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "source-race",
        "argv": [executables["echo"], "source-race"],
        "workingDirectory": str(workspace),
        "environment": ["HOME"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "unsafe-git-config",
        "argv": [executables["echo"], "unsafe-git-config"],
        "workingDirectory": str(workspace),
        "environment": ["HOME"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "malformed-source",
        "argv": [executables["echo"], "malformed-source"],
        "workingDirectory": str(workspace),
        "environment": ["HOME"],
        "timeoutSeconds": 2,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
    {
        "id": "spawn-deadline",
        "argv": [executables["echo"], "spawn-deadline"],
        "workingDirectory": str(workspace),
        "environment": ["HOME"],
        "timeoutSeconds": 1,
        "maxOutputBytes": 1024,
        "maxInvocations": 1,
    },
]
content = {
    "schemaVersion": "nemoclaw.dcode.validation-profile.v1",
    "sandboxName": "validation-test",
    "taskIdentity": "issue-7774",
    "sourceIdentity": source_identity,
    "workingDirectoryRoots": [str(workspace)],
    "commands": commands,
}
digest = "sha256:" + hashlib.sha256(
    json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
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
            secret_content, sort_keys=True, separators=(",", ":"), ensure_ascii=False
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

def profile_is_rejected_with_process_control_environment(name):
    unsafe_content = json.loads(json.dumps(content))
    unsafe_content["commands"][0]["environment"].append(name)
    unsafe_digest = "sha256:" + hashlib.sha256(
        json.dumps(
            unsafe_content, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
    ).hexdigest()
    unsafe_profile = {**unsafe_content, "contentDigest": unsafe_digest}
    try:
        managed._canonical_validation_profile(
            json.dumps(unsafe_profile, separators=(",", ":")).encode()
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
managed._VALIDATION_GIT_EXECUTABLE = Path(git_executable)
managed._VALIDATION_GIT_OWNER_UID = Path(git_executable).stat().st_uid
managed._VALIDATION_INVOCATION_BUDGET_ROOT = root / "invocation-budget"
managed._VALIDATION_INVOCATION_BUDGET_OWNER_UID = os.getuid()
managed._VALIDATION_INVOCATION_BUDGET_GROUP_GID = os.getgid()
managed.initialize_managed_validation_invocation_budget()
for command in profile["commands"]:
    command_directory = managed._validation_invocation_command_path(profile, command)
    os.link(
        command_directory / managed._VALIDATION_INVOCATION_ANCHOR,
        command_directory
        / managed._VALIDATION_INVOCATION_CLAIMS
        / managed._VALIDATION_INVOCATION_SANDBOX_PROBE,
    )
managed.finalize_managed_validation_invocation_budget()

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
        "sourceVerified": receipt["verifiedSourceIdentity"] == source_identity,
    }

def run_concurrent(queue):
    queue.put(run(f'{delayed_executable} concurrent')["status"])

process_control_names = (
    "LD_PRELOAD",
    "PYTHONPATH",
    "NODE_OPTIONS",
    "GIT_CONFIG_GLOBAL",
)
previous_process_control = {
    name: os.environ.get(name) for name in process_control_names
}
for name in process_control_names:
    os.environ[name] = "hostile-validation-control"
original_popen = managed.subprocess.Popen
allowed_child_environment = {}
def capture_allowed_child_environment(*args, **kwargs):
    if args[0] == [executables["echo"], "managed"]:
        allowed_child_environment.update(kwargs["env"])
    return original_popen(*args, **kwargs)
managed.subprocess.Popen = capture_allowed_child_environment
allowed_result = run(f'{executables["echo"]} managed')
managed.subprocess.Popen = original_popen
for name, previous in previous_process_control.items():
    if previous is None:
        os.environ.pop(name, None)
    else:
        os.environ[name] = previous

results = {
    "allowed": allowed_result,
    "processControlProfileRejected": {
        name: profile_is_rejected_with_process_control_environment(name)
        for name in process_control_names
    },
    "processControlEnvironmentExcluded": all(
        name not in allowed_child_environment for name in process_control_names
    ),
    "extraArgument": run(f'{executables["echo"]} managed extra'),
    "metacharacter": run(f'{executables["echo"]} managed; touch {root / "escaped"}'),
    "environmentInjection": run(f'LANG=unsafe {executables["echo"]} managed'),
    "alternateExecutable": run(f'/usr/bin/printf managed'),
    "invocationExhausted": run(f'{executables["echo"]} managed'),
    "timeout": run(f'{executables["sleep"]} 2'),
    "output": run(f'{executables["yes"]} bounded'),
    "unicode": run(f'{executables["echo"]} café/路径'),
    "escaped": (root / "escaped").exists(),
    "disabled": disabled,
    "secretTaskIdentityRejected": profile_is_rejected_with_secret("taskIdentity"),
    "secretCommandIdRejected": profile_is_rejected_with_secret("id"),
}
managed._VALIDATION_EXECUTABLE_OWNER_UID = os.getuid()
results["unsafeExecutable"] = run(str(retry_executable))
retry_executable.chmod(0o755)
results["successfulAfterRejection"] = run(str(retry_executable))
results["delayedExit"] = run(str(delayed_executable))
def fail_target_spawn(*args, **kwargs):
    if args[0][0] == str(popen_retry_executable):
        raise OSError("simulated process creation failure")
    return original_popen(*args, **kwargs)
managed.subprocess.Popen = fail_target_spawn
results["popenFailure"] = run(str(popen_retry_executable))
managed.subprocess.Popen = original_popen
results["successfulAfterPopenFailure"] = run(str(popen_retry_executable))
def replace_executable_before_spawn(*args, **kwargs):
    if args[0][0] == str(race_executable):
        os.replace(race_replacement, race_executable)
    return original_popen(*args, **kwargs)
managed.subprocess.Popen = replace_executable_before_spawn
try:
    results["descriptorBound"] = run(str(race_executable))
finally:
    managed.subprocess.Popen = original_popen
results["raceEscaped"] = (root / "race-escaped").exists()
def mutate_source_before_spawn(*args, **kwargs):
    if args[0] == [executables["echo"], "source-race"]:
        (workspace / "tracked.txt").write_text(
            "changed after source verification\n", encoding="utf-8"
        )
    return original_popen(*args, **kwargs)
managed.subprocess.Popen = mutate_source_before_spawn
try:
    results["sourceRace"] = run(f'{executables["echo"]} source-race')
finally:
    managed.subprocess.Popen = original_popen
subprocess.run(
    [git_executable, "-C", str(workspace), "checkout", "--", "tracked.txt"],
    check=True,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
context = multiprocessing.get_context("fork")
queue = context.Queue()
workers = [context.Process(target=run_concurrent, args=(queue,)) for _index in range(2)]
for worker in workers:
    worker.start()
for worker in workers:
    worker.join(timeout=10)
results["concurrent"] = sorted(queue.get(timeout=1) for _index in workers)
managed._VALIDATION_EXECUTABLE_OWNER_UID = Path(executables["echo"]).stat().st_uid
subprocess.run(
    [
        git_executable,
        "-C",
        str(workspace),
        "config",
        "filter.attacker.clean",
        f"touch {root / 'filter-escaped'}",
    ],
    check=True,
)
results["unsafeGitConfig"] = run(f'{executables["echo"]} unsafe-git-config')
subprocess.run(
    [
        git_executable,
        "-C",
        str(workspace),
        "config",
        "--unset-all",
        "filter.attacker.clean",
    ],
    check=True,
)
results["filterEscaped"] = (root / "filter-escaped").exists()
original_run_validation_git = managed._run_validation_git
def return_malformed_object_format(working_directory, arguments, pass_descriptors):
    status, output = original_run_validation_git(
        working_directory, arguments, pass_descriptors
    )
    if arguments == ["rev-parse", "--show-object-format"]:
        return status, b"\xff"
    return status, output
managed._run_validation_git = return_malformed_object_format
try:
    results["malformedSource"] = run(f'{executables["echo"]} malformed-source')
finally:
    managed._run_validation_git = original_run_validation_git
original_verify_source = managed._verified_validation_source_identity
def verify_source_after_delay(working_directory, pass_descriptors):
    import time
    time.sleep(1.05)
    return original_verify_source(working_directory, pass_descriptors)
managed._verified_validation_source_identity = verify_source_after_delay
try:
    results["spawnDeadline"] = run(f'{executables["echo"]} spawn-deadline')
finally:
    managed._verified_validation_source_identity = original_verify_source
(workspace / "dirty.txt").write_text("changed\n", encoding="utf-8")
results["dirtySource"] = run(f'{executables["echo"]} dirty-source')
print(json.dumps(results))
`;

describe("managed DCode validation-command runtime", () => {
  it.skipIf(process.platform !== "linux")(
    "admits only exact argv and returns bounded content-free receipts (#7774)",
    () => {
      const result = spawnSync("python3", ["-c", harness], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(result.status, result.stderr).toBe(0);
      const receipts = JSON.parse(result.stdout) as Record<
        string,
        { status: string; success: boolean; sourceVerified: boolean; stdoutBytes: number }
      > & {
        concurrent: string[];
        disabled: boolean;
        escaped: boolean;
        filterEscaped: boolean;
        raceEscaped: boolean;
      };
      expect(receipts.disabled).toBe(false);
      expect(receipts.allowed, JSON.stringify(receipts)).toMatchObject({
        status: "succeeded",
        success: true,
        commandId: "echo",
        sourceVerified: true,
      });
      expect(receipts.processControlProfileRejected).toEqual({
        GIT_CONFIG_GLOBAL: true,
        LD_PRELOAD: true,
        NODE_OPTIONS: true,
        PYTHONPATH: true,
      });
      expect(receipts.processControlEnvironmentExcluded).toBe(true);
      expect(receipts.extraArgument.status).toBe("rejected");
      expect(receipts.metacharacter.status).toBe("rejected");
      expect(receipts.environmentInjection.status).toBe("rejected");
      expect(receipts.alternateExecutable.status).toBe("rejected");
      expect(receipts.invocationExhausted.status).toBe("invocation_limit_exceeded");
      expect(receipts.timeout.status).toBe("timed_out");
      expect(receipts.output.status).toBe("output_limit_exceeded");
      expect(receipts.output.stdoutBytes).toBeLessThanOrEqual(64);
      expect(receipts.unicode.status).toBe("succeeded");
      expect(receipts.unsafeExecutable.status).toBe("rejected");
      expect(receipts.successfulAfterRejection.status).toBe("succeeded");
      expect(receipts.delayedExit.status).toBe("succeeded");
      expect(receipts.popenFailure.status).toBe("rejected");
      expect(receipts.successfulAfterPopenFailure.status).toBe("succeeded");
      expect(receipts.descriptorBound.status).toBe("succeeded");
      expect(receipts.raceEscaped).toBe(false);
      expect(receipts.sourceRace.status).toBe("source_identity_mismatch");
      expect(receipts.concurrent).toEqual(["invocation_limit_exceeded", "succeeded"]);
      expect(receipts.unsafeGitConfig.status).toBe("source_identity_mismatch");
      expect(receipts.filterEscaped).toBe(false);
      expect(receipts.malformedSource.status).toBe("source_identity_mismatch");
      expect(receipts.spawnDeadline.status).toBe("succeeded");
      expect(receipts.dirtySource.status).toBe("source_identity_mismatch");
      expect(receipts.escaped).toBe(false);
      expect(receipts.secretTaskIdentityRejected).toBe(true);
      expect(receipts.secretCommandIdRejected).toBe(true);
    },
  );
});
