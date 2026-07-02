// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RUNTIME_CONFIG_GUARD = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "runtime-config-guard.py",
);

function runPythonHarness(source: string) {
  return spawnSync("python3", ["-c", source, RUNTIME_CONFIG_GUARD], {
    encoding: "utf-8",
    timeout: 5000,
  });
}

const loadGuardModule = String.raw`
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("runtime_config_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
`;

describe("Hermes runtime config hash refresh race protection", () => {
  it("creates an absent private runtime directory through its pinned parent", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import stat
import tempfile

with tempfile.TemporaryDirectory() as tmp:
    parent = os.path.join(tmp, "run")
    runtime = os.path.join(parent, "nemoclaw")
    os.mkdir(parent, 0o700)
    guard._ensure_private_runtime_directory(runtime, os.geteuid(), os.getegid(), 0o711)
    guard._ensure_private_runtime_directory(runtime, os.geteuid(), os.getegid(), 0o711)
    metadata = os.stat(runtime, follow_symlinks=False)
    print(json.dumps({
        "directory": stat.S_ISDIR(metadata.st_mode),
        "mode": stat.S_IMODE(metadata.st_mode),
        "uid": metadata.st_uid,
        "gid": metadata.st_gid,
    }))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      directory: true,
      mode: 0o711,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0,
    });
  });

  it("provisions only the fixed production state and lock pair", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json

calls = []
guard.os.geteuid = lambda: 0
guard.os.getegid = lambda: 0
guard._ensure_private_runtime_directory = (
    lambda path, uid, gid, mode: calls.append([path, uid, gid, mode])
)
guard._ensure_production_runtime_directory(
    guard.HERMES_MUTATION_LOCK_FILE,
    guard.HERMES_RESTART_STATE_FILE,
)
guard._ensure_production_runtime_directory(
    "/tmp/attacker.lock",
    "/tmp/attacker-state.json",
)
print(json.dumps(calls))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([["/run/nemoclaw", 0, 0, 0o711]]);
  });

  it("refuses unsafe runtime parents, children, symlinks, and non-root production", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile

errors = {}
with tempfile.TemporaryDirectory() as tmp:
    parent = os.path.join(tmp, "run")
    runtime = os.path.join(parent, "nemoclaw")
    os.mkdir(parent, 0o700)
    target = os.path.join(tmp, "target")
    os.mkdir(target, 0o700)
    os.symlink(target, runtime)
    try:
        guard._ensure_private_runtime_directory(
            runtime, os.geteuid(), os.getegid(), 0o711
        )
    except guard.UnsafePathError as exc:
        errors["symlink"] = str(exc)

    os.unlink(runtime)
    os.mkdir(runtime, 0o700)
    os.chmod(runtime, 0o733)
    try:
        guard._ensure_private_runtime_directory(
            runtime, os.geteuid(), os.getegid(), 0o711
        )
    except guard.UnsafePathError as exc:
        errors["writable_child"] = str(exc)

    os.rmdir(runtime)
    os.chmod(parent, 0o733)
    try:
        guard._ensure_private_runtime_directory(
            runtime, os.geteuid(), os.getegid(), 0o711
        )
    except guard.UnsafePathError as exc:
        errors["writable_parent"] = str(exc)

guard.os.geteuid = lambda: 1000
guard.os.getegid = lambda: 1000
try:
    guard._ensure_production_runtime_directory(
        guard.HERMES_MUTATION_LOCK_FILE,
        guard.HERMES_RESTART_STATE_FILE,
    )
except guard.UnsafePathError as exc:
    errors["nonroot"] = str(exc)

print(json.dumps(errors))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      nonroot: "Hermes production runtime state requires root",
      symlink: "Hermes runtime state directory is unavailable",
      writable_child: "refusing unsafe Hermes runtime state directory",
      writable_parent: "refusing unsafe Hermes runtime state parent",
    });
  });

  it("warns once for unsupported directory fsync and propagates real I/O failures", () => {
    const result = runPythonHarness(`${loadGuardModule}
import contextlib
import errno
import io
import json

def unsupported_fsync(_fd):
    raise OSError(errno.EOPNOTSUPP, "directory fsync unsupported")

guard.os.fsync = unsupported_fsync
warnings = io.StringIO()
with contextlib.redirect_stderr(warnings):
    guard._fsync_directory_after_replace(10)
    guard._fsync_directory_after_replace(10)

def failed_fsync(_fd):
    raise OSError(errno.EIO, "storage I/O failed")

guard.os.fsync = failed_fsync
try:
    guard._fsync_directory_after_replace(10)
except OSError as exc:
    failure_errno = exc.errno
else:
    failure_errno = None

print(json.dumps({
    "warning_lines": warnings.getvalue().strip().splitlines(),
    "failure_errno": failure_errno,
}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      failure_errno: 5,
      warning_lines: [
        "[security] directory fsync is unsupported; the atomic Hermes config rename completed without a directory durability barrier",
      ],
    });
  });

  it("streams SHA-256 without materializing the entire file", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile

with tempfile.TemporaryDirectory() as tmp:
    path = os.path.join(tmp, "config.yaml")
    with open(path, "wb") as handle:
        handle.write(b"streamed hash input\\n")
    original = guard.OpenFile.read_bytes
    guard.OpenFile.read_bytes = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("hash path materialized bytes")
    )
    try:
        entry, snapshot = guard._sha256_entry(path, guard.MAX_CONFIG_INPUT_BYTES)
    finally:
        guard.OpenFile.read_bytes = original
    print(json.dumps({
        "digest": entry.split()[0],
        "size": snapshot.size,
    }))
`);

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.size).toBe(20);
    expect(proof.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects an oversized sparse input before issuing a read", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile

with tempfile.TemporaryDirectory() as tmp:
    path = os.path.join(tmp, "config.yaml")
    with open(path, "wb") as handle:
        handle.truncate(guard.MAX_CONFIG_INPUT_BYTES + 1)
    opened = guard._open_regular(path)
    reads = 0
    original_read = guard.os.read
    def counted_read(*args, **kwargs):
        global reads
        reads += 1
        return original_read(*args, **kwargs)
    guard.os.read = counted_read
    try:
        try:
            opened.read_bytes(guard.MAX_CONFIG_INPUT_BYTES)
        except guard.UnsafePathError as exc:
            error = str(exc)
        else:
            error = ""
    finally:
        guard.os.read = original_read
        opened.close()
    print(json.dumps({"error": error, "reads": reads}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reads: 0,
    });
    expect(JSON.parse(result.stdout).error).toContain("oversized runtime config path");
  });

  it("bounds restart journals before publishing them", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile

with tempfile.TemporaryDirectory() as tmp:
    os.chmod(tmp, 0o700)
    state = os.path.join(tmp, "state.json")
    guard.MAX_RESTART_STATE_BYTES = 128
    try:
        guard._write_restart_state(
            state,
            {"version": 1, "payload": "x" * 512},
            create=True,
        )
    except guard.UnsafePathError as exc:
        error = str(exc)
    else:
        error = ""
    print(json.dumps({"error": error, "exists": os.path.exists(state)}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      error: "refusing oversized Hermes restart seal state",
      exists: false,
    });
  });

  it("rejects a same-inode, same-size config rewrite between snapshots", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile

with tempfile.TemporaryDirectory() as tmp:
    hermes_dir = os.path.join(tmp, ".hermes")
    os.mkdir(hermes_dir)
    config_path = os.path.join(hermes_dir, "config.yaml")
    env_path = os.path.join(hermes_dir, ".env")
    hash_path = os.path.join(tmp, "hermes.config-hash")
    with open(config_path, "wb") as handle:
        handle.write(b"model: one\\n")
    with open(env_path, "wb") as handle:
        handle.write(b"API_SERVER_PORT=18642\\n")

    before = os.stat(config_path)
    original_write_hash = guard._write_hash

    def racing_write_hash(path, text):
        original_write_hash(path, text)
        if path == hash_path:
            with open(config_path, "r+b", buffering=0) as handle:
                handle.write(b"model: two\\n")
            # Make the metadata transition deterministic even on filesystems
            # whose natural timestamp granularity is too coarse for this race.
            after_write = os.stat(config_path)
            os.utime(
                config_path,
                ns=(after_write.st_atime_ns, before.st_mtime_ns + 1_000_000_000),
            )

    guard._write_hash = racing_write_hash
    try:
        guard.refresh_hashes(hermes_dir, hash_path, "strict")
    except guard.UnsafePathError as exc:
        rejected = True
        error = str(exc)
    else:
        rejected = False
        error = ""

    after = os.stat(config_path)
    print(json.dumps({
        "rejected": rejected,
        "error": error,
        "same_inode": before.st_ino == after.st_ino,
        "same_size": before.st_size == after.st_size,
        "content": open(config_path, "rb").read().decode("utf-8"),
    }))
`);

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof).toMatchObject({
      rejected: true,
      same_inode: true,
      same_size: true,
      content: "model: two\n",
    });
    expect(proof.error).toContain("refusing raced Hermes config/env path before hash refresh");
  });

  it("writes strict and compatibility hashes from one stable input snapshot", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile

with tempfile.TemporaryDirectory() as tmp:
    hermes_dir = os.path.join(tmp, ".hermes")
    os.mkdir(hermes_dir)
    config_path = os.path.join(hermes_dir, "config.yaml")
    env_path = os.path.join(hermes_dir, ".env")
    strict_hash_path = os.path.join(tmp, "hermes.config-hash")
    compat_hash_path = os.path.join(hermes_dir, ".config-hash")
    with open(config_path, "w", encoding="utf-8") as handle:
        handle.write("model:\\n  default: test-model\\n")
    with open(env_path, "w", encoding="utf-8") as handle:
        handle.write("API_SERVER_PORT=18642\\n")

    original_hash_text = guard._hash_text
    original_write_hash = guard._write_hash
    hash_text_calls = 0
    writes = []

    def counted_hash_text(config, env):
        global hash_text_calls
        hash_text_calls += 1
        return original_hash_text(config, env)

    def captured_write_hash(path, text):
        writes.append({"path": path, "text": text})
        original_write_hash(path, text)

    guard._hash_text = counted_hash_text
    guard._write_hash = captured_write_hash
    guard.refresh_hashes(hermes_dir, strict_hash_path, "both")

    with open(strict_hash_path, encoding="utf-8") as handle:
        strict_text = handle.read()
    with open(compat_hash_path, encoding="utf-8") as handle:
        compat_text = handle.read()
    print(json.dumps({
        "hash_text_calls": hash_text_calls,
        "write_paths": [entry["path"] for entry in writes],
        "write_texts_match": len(writes) == 2 and writes[0]["text"] == writes[1]["text"],
        "files_match": strict_text == compat_text,
        "config_entry_count": strict_text.count(config_path),
        "env_entry_count": strict_text.count(env_path),
    }))
`);

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof).toMatchObject({
      hash_text_calls: 1,
      write_texts_match: true,
      files_match: true,
      config_entry_count: 1,
      env_entry_count: 1,
    });
    expect(proof.write_paths).toHaveLength(2);
    expect(proof.write_paths[0]).toMatch(/\.hermes\/\.config-hash$/);
    expect(proof.write_paths[1]).toMatch(/\/hermes\.config-hash$/);
  });

  it("leaves the strict trust anchor uncommitted if compatibility refresh is interrupted", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile

with tempfile.TemporaryDirectory() as tmp:
    hermes_dir = os.path.join(tmp, ".hermes")
    os.mkdir(hermes_dir)
    config_path = os.path.join(hermes_dir, "config.yaml")
    env_path = os.path.join(hermes_dir, ".env")
    strict_hash_path = os.path.join(tmp, "hermes.config-hash")
    compat_hash_path = os.path.join(hermes_dir, ".config-hash")
    with open(config_path, "w", encoding="utf-8") as handle:
        handle.write("model:\\n  default: old-model\\n")
    with open(env_path, "w", encoding="utf-8") as handle:
        handle.write("API_SERVER_PORT=18642\\n")

    guard.refresh_hashes(hermes_dir, strict_hash_path, "both")
    with open(strict_hash_path, encoding="utf-8") as handle:
        old_strict = handle.read()
    with open(config_path, "w", encoding="utf-8") as handle:
        handle.write("model:\\n  default: new-model\\n")

    original_write_hash = guard._write_hash
    writes = []

    def interrupt_after_write(path, text):
        writes.append(path)
        original_write_hash(path, text)
        if path == compat_hash_path:
            raise RuntimeError("simulated crash before strict commit")

    guard._write_hash = interrupt_after_write
    try:
        guard.refresh_hashes(hermes_dir, strict_hash_path, "both")
    except RuntimeError as exc:
        interrupted = str(exc)
    else:
        interrupted = ""

    with open(strict_hash_path, encoding="utf-8") as handle:
        strict_after = handle.read()
    with open(compat_hash_path, encoding="utf-8") as handle:
        compat_after = handle.read()
    try:
        guard._verify_strict_hash(hermes_dir, strict_hash_path)
    except guard.UnsafePathError:
        strict_rejects = True
    else:
        strict_rejects = False

    print(json.dumps({
        "interrupted": interrupted,
        "writes": writes,
        "strict_unchanged": strict_after == old_strict,
        "anchors_differ": strict_after != compat_after,
        "strict_rejects": strict_rejects,
    }))
`);

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.interrupted).toBe("simulated crash before strict commit");
    expect(proof.writes).toHaveLength(1);
    expect(proof.writes[0]).toMatch(/\.hermes\/\.config-hash$/);
    expect(proof).toMatchObject({
      strict_unchanged: true,
      anchors_differ: true,
      strict_rejects: true,
    });
  });
});

describe("Hermes provider placeholder diagnostics", () => {
  it("logs only validated environment keys, never runtime-plan message content", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile

with tempfile.TemporaryDirectory() as tmp:
    env_path = os.path.join(tmp, ".env")
    plan_path = os.path.join(tmp, "runtime-plan.json")
    with open(env_path, "w", encoding="utf-8") as handle:
        handle.write("SLACK_BOT_TOKEN=old-placeholder\\n")
    with open(plan_path, "w", encoding="utf-8") as handle:
        json.dump({
            "channels": [{"channelId": "slack", "active": True}],
            "runtimeSetup": {
                "envAliases": [{
                    "channelId": "slack",
                    "envKey": "SLACK_BOT_TOKEN",
                    "match": "^openshell:resolve:env:SLACK_BOT_TOKEN$",
                    "value": "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
                    "message": "Authorization: Bearer should-never-be-logged",
                }],
            },
        }, handle)

    os.environ["SLACK_BOT_TOKEN"] = "openshell:resolve:env:SLACK_BOT_TOKEN"
    guard._validate_env_text_with_boundary = lambda *_args: None
    guard.refresh_hashes = lambda *_args: None
    guard.provider_placeholders(
        tmp,
        os.path.join(tmp, ".config-hash"),
        "compat",
        plan_path,
        "unused-boundary-validator",
    )
    with open(env_path, "r", encoding="utf-8") as handle:
        print(handle.read(), end="")
`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("SLACK_BOT_TOKEN=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN\n");
    expect(result.stderr).toContain(
      "[config] Refreshed Hermes provider placeholder for SLACK_BOT_TOKEN",
    );
    expect(result.stderr).not.toContain("Authorization");
    expect(result.stderr).not.toContain("should-never-be-logged");
  });
});

describe("Hermes shields outer namespace containment", () => {
  it("keeps the exact state worker PID alive as the in-container timeout owner", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json

captured = {}
guard._claim_transition_worker = lambda state, token, purpose: {
    "shields_transition": {"mode": "locked"}
}
guard.os.path.isfile = lambda _path: True
guard.signal.alarm = lambda seconds: captured.update({"alarm": seconds})
def capture_exec(program, argv):
    captured.update({"program": program, "argv": argv})
    raise RuntimeError("exec captured")
guard.os.execvp = capture_exec
try:
    guard.run_state_dir_transition(
        "/sandbox/.hermes",
        "/run/nemoclaw/hermes-restart-seal.json",
        "a" * 64,
        "lock",
    )
except RuntimeError as exc:
    captured["error"] = str(exc)
print(json.dumps(captured))
`);

    expect(result.status, result.stderr).toBe(0);
    const captured = JSON.parse(result.stdout);
    expect(captured).toMatchObject({
      alarm: 0,
      program: "timeout",
      error: "exec captured",
    });
    expect(captured.argv.slice(0, 5)).toEqual([
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "12m",
      expect.stringMatching(/python(?:3(?:\.\d+)?)?$/),
    ]);
    expect(captured.argv.slice(5)).toEqual([
      "/usr/local/lib/nemoclaw/state-dir-guard.py",
      "lock",
      "--config-dir",
      "/sandbox/.hermes",
    ]);
  });

  it("refuses mutable takeover while the exact claimed worker is live", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile
import time

with tempfile.TemporaryDirectory() as tmp:
    os.chmod(tmp, 0o700)
    token = "b" * 64
    state_path = os.path.join(tmp, "state.json")
    lock_path = os.path.join(tmp, "hermes-config-mutation.lock")
    state = {
        "version": 1,
        "phase": "shields-transition-applied",
        "mutation_lock_token": token,
        "mutation_lock_path": lock_path,
        "hermes_dir": "/sandbox/.hermes",
        "hash_file": "/etc/nemoclaw/hermes.config-hash",
        "parent": {"dev": 1, "ino": 1},
        "hermes": {"dev": 1, "ino": 2},
        "shields_transition": {
            "mode": "mutable",
            "lease_expires_ns": 1,
        },
    }
    with open(state_path, "w", encoding="utf-8") as handle:
        json.dump(state, handle)
    os.chmod(state_path, 0o600)
    with open(lock_path, "w", encoding="utf-8") as handle:
        json.dump({
            "version": 1,
            "token": token,
            "purpose": "state-dir-unlock",
            "pid": 1234,
            "pid_start_time": "99",
        }, handle)
    os.chmod(lock_path, 0o600)
    guard._mutation_lock_owner_is_live = lambda _owner: True
    try:
        guard._takeover_expired_mutable_transition(
            "/sandbox/.hermes",
            "/etc/nemoclaw/hermes.config-hash",
            state_path,
        )
    except guard.UnsafePathError as exc:
        error = str(exc)
    else:
        error = ""
    print(json.dumps({"error": error, "state_exists": os.path.exists(state_path)}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      error: "Hermes mutable transition worker is still active; retry locked takeover",
      state_exists: true,
    });
  });

  it("claims the expired mutable owner before freezing its namespace", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile

with tempfile.TemporaryDirectory() as tmp:
    os.chmod(tmp, 0o700)
    token = "c" * 64
    state_path = os.path.join(tmp, "state.json")
    lock_path = os.path.join(tmp, "hermes-config-mutation.lock")
    state = {
        "version": 1,
        "phase": "shields-transition-applied",
        "mutation_lock_token": token,
        "mutation_lock_path": lock_path,
        "hermes_dir": "/sandbox/.hermes",
        "hash_file": "/etc/nemoclaw/hermes.config-hash",
        "parent": {"dev": 1, "ino": 1},
        "hermes": {"dev": 1, "ino": 2},
        "shields_transition": {"mode": "mutable", "lease_expires_ns": 1},
    }
    with open(state_path, "w", encoding="utf-8") as handle:
        json.dump(state, handle)
    os.chmod(state_path, 0o600)
    with open(lock_path, "w", encoding="utf-8") as handle:
        json.dump({
            "version": 1,
            "token": token,
            "purpose": "apply-shields-transition",
            "pid": 1234,
            "pid_start_time": "99",
        }, handle)
    os.chmod(lock_path, 0o600)
    guard._mutation_lock_owner_is_live = lambda _owner: False
    events = []
    def lose_claim(_state_path, _token, _purpose):
        events.append("claim")
        raise guard.UnsafePathError("simulated competing worker claim")
    guard._claim_transition_worker = lose_claim
    guard._open_directory = lambda _path: events.append("freeze")
    try:
        guard._takeover_expired_mutable_transition(
            "/sandbox/.hermes",
            "/etc/nemoclaw/hermes.config-hash",
            state_path,
        )
    except guard.UnsafePathError as exc:
        error = str(exc)
    else:
        error = ""
    print(json.dumps({"error": error, "events": events}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      error: "simulated competing worker claim",
      events: ["claim"],
    });
  });

  it("freezes the parent before opening .hermes", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile

with tempfile.TemporaryDirectory() as tmp:
    os.chmod(tmp, 0o700)
    sandbox = os.path.join(tmp, "sandbox")
    hermes = os.path.join(sandbox, ".hermes")
    os.makedirs(hermes)
    os.chmod(sandbox, 0o770)
    os.chmod(hermes, 0o3770)
    with open(os.path.join(hermes, "config.yaml"), "wb") as handle:
        handle.write(b"model: test\\n")
    with open(os.path.join(hermes, ".env"), "wb") as handle:
        handle.write(b"SAFE=1\\n")
    with open(os.path.join(hermes, ".config-hash"), "wb") as handle:
        handle.write(b"stale\\n")
    strict = os.path.join(tmp, "strict.hash")
    with open(strict, "wb") as handle:
        handle.write(b"stale\\n")
    state = os.path.join(tmp, "state.json")

    original_open_child = guard._open_child_directory
    observed = []
    def checked_open_child(parent_fd, name, path):
        if name == ".hermes":
            parent = os.fstat(parent_fd)
            observed.append({
                "mode": oct(parent.st_mode & 0o7777),
                "uid": parent.st_uid,
            })
        return original_open_child(parent_fd, name, path)
    guard._open_child_directory = checked_open_child
    try:
        guard._seal_shields_locked(hermes, strict, state, "mutable")
    finally:
        guard._open_child_directory = original_open_child
    print(json.dumps({
        "observed": observed,
        "parent_mode": oct(os.stat(sandbox).st_mode & 0o7777),
        "hermes_mode": oct(os.stat(hermes).st_mode & 0o7777),
    }))
    os.chmod(hermes, 0o700)
    os.chmod(sandbox, 0o700)
`);

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.observed[0]).toMatchObject({ mode: "0o700" });
    expect(proof).toMatchObject({
      parent_mode: "0o700",
      hermes_mode: "0o500",
    });
  });

  it("rejects a cross-device .hermes without mutating the mounted child", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import stat
import tempfile
from types import SimpleNamespace

with tempfile.TemporaryDirectory() as tmp:
    os.chmod(tmp, 0o700)
    sandbox = os.path.join(tmp, "sandbox")
    hermes = os.path.join(sandbox, ".hermes")
    os.makedirs(hermes)
    os.chmod(sandbox, 0o770)
    os.chmod(hermes, 0o3770)
    strict = os.path.join(tmp, "strict.hash")
    with open(strict, "wb") as handle:
        handle.write(b"stale\\n")
    state = os.path.join(tmp, "state.json")
    original_stat = guard.os.stat
    child_before = original_stat(hermes)
    def cross_device_stat(path, *args, **kwargs):
        result = original_stat(path, *args, **kwargs)
        if path == ".hermes" and kwargs.get("dir_fd") is not None and kwargs.get("follow_symlinks") is False:
            return SimpleNamespace(
                st_mode=result.st_mode,
                st_dev=result.st_dev + 1,
                st_ino=result.st_ino,
                st_uid=result.st_uid,
                st_gid=result.st_gid,
                st_nlink=result.st_nlink,
                st_size=result.st_size,
                st_mtime_ns=result.st_mtime_ns,
                st_ctime_ns=result.st_ctime_ns,
            )
        return result
    guard.os.stat = cross_device_stat
    try:
        try:
            guard._seal_shields_locked(hermes, strict, state, "mutable")
        except guard.UnsafePathError as exc:
            error = str(exc)
        else:
            error = ""
    finally:
        guard.os.stat = original_stat
    child_after = original_stat(hermes)
    print(json.dumps({
        "error": error,
        "parent_mode": oct(original_stat(sandbox).st_mode & 0o7777),
        "child_mode_unchanged": (child_before.st_mode & 0o7777) == (child_after.st_mode & 0o7777),
        "child_inode_unchanged": child_before.st_ino == child_after.st_ino,
    }))
    os.chmod(sandbox, 0o700)
`);

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.error).toContain("cross-device Hermes config root");
    expect(proof).toMatchObject({
      parent_mode: "0o700",
      child_mode_unchanged: true,
      child_inode_unchanged: true,
    });
  });
});

describe("Hermes startup readiness lease", () => {
  it("rejects a supervisor argv polluted with the appended startup command (#6110)", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json

polluted_supervisor = (
    b"/opt/openshell/bin/openshell-sandbox\\0"
    b"env\\0CHAT_UI_URL=http://127.0.0.1:18789\\0nemoclaw-start\\0"
)
guard.__file__ = guard.INSTALLED_RUNTIME_CONFIG_GUARD
guard._open_proc_root = lambda: 101
guard._open_proc_pid = lambda _root, _pid: 102
guard._read_proc_pid_file = lambda _fd, _name, _display: polluted_supervisor
guard.os.close = lambda _fd: None
guard.os.getppid = lambda: 1
guard.pwd.getpwnam = lambda _name: type("User", (), {"pw_uid": 1000})()
guard._startup_ready_marker_absent = lambda: True
guard._openshell_supervised_nonroot_start_is_live = lambda *_args: False

classification = guard._pid1_is_nemoclaw_start()

try:
    guard._validate_action_readiness("ensure-api-key", True)
    error = None
except guard.UnsafePathError as exc:
    error = str(exc)

print(json.dumps({
    "classification": classification,
    "error": error,
}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      classification: false,
      error: "Hermes runtime config guard refuses mutation under a foreign PID 1",
    });
  });

  it("fails closed under foreign PID 1 only for the installed guard entrypoint", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json

guard._pid1_is_nemoclaw_start = lambda: False
source_entrypoint = guard.__file__
try:
    guard._validate_action_readiness("seal-restart", False)
except guard.UnsafePathError:
    source_allowed = False
else:
    source_allowed = True

guard.__file__ = guard.INSTALLED_RUNTIME_CONFIG_GUARD
try:
    guard._validate_action_readiness("seal-restart", False)
except guard.UnsafePathError as exc:
    installed_error = str(exc)
else:
    installed_error = ""
guard._startup_ready_for_current_pid1 = lambda: True
try:
    guard._validate_action_readiness("seal-restart", False)
except guard.UnsafePathError:
    remapped_allowed = False
else:
    remapped_allowed = True
finally:
    guard.__file__ = source_entrypoint
print(json.dumps({
    "source_allowed": source_allowed,
    "installed_error": installed_error,
    "remapped_allowed": remapped_allowed,
}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      source_allowed: true,
      installed_error: "Hermes runtime config guard refuses mutation under a foreign PID 1",
      remapped_allowed: true,
    });
  });

  it("permits degraded host actions only when NemoClaw PID 1 is non-root", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json

guard._pid1_is_nemoclaw_start = lambda: True
guard._startup_ready_for_current_pid1 = lambda: False
guard._process_effective_uid = lambda pid: 1000 if pid == 1 else None
try:
    guard._validate_action_readiness("seal-restart", False)
except guard.UnsafePathError:
    nonroot_allowed = False
else:
    nonroot_allowed = True

guard._process_effective_uid = lambda pid: 0 if pid == 1 else None
try:
    guard._validate_action_readiness("seal-restart", False)
except guard.UnsafePathError as exc:
    root_error = str(exc)
else:
    root_error = ""
print(json.dumps({"nonroot_allowed": nonroot_allowed, "root_error": root_error}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      nonroot_allowed: true,
      root_error: "Hermes startup is not ready for host config or gateway mutations",
    });
  });

  it("authenticates the markerless OpenShell supervisor topology narrowly", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json

guard.__file__ = guard.INSTALLED_RUNTIME_CONFIG_GUARD
guard._pid1_is_nemoclaw_start = lambda: False
guard._startup_ready_for_current_pid1 = lambda: False
guard._startup_ready_marker_absent = lambda: True
guard.pwd.getpwnam = lambda _name: type("User", (), {"pw_uid": 1000})()
guard.os.getppid = lambda: 4242
guard._openshell_supervised_nonroot_start_is_live = lambda root_uid, sandbox_uid, required_pid=None: (
    root_uid == 0
    and sandbox_uid == 1000
    and required_pid in {None, 4242}
)

try:
    guard._validate_action_readiness("seal-restart", False)
except guard.UnsafePathError:
    host_allowed = False
else:
    host_allowed = True

try:
    guard._validate_action_readiness("ensure-api-key", True)
except guard.UnsafePathError:
    startup_allowed = False
else:
    startup_allowed = True

try:
    guard._validate_action_readiness("ensure-api-key", False)
except guard.UnsafePathError:
    startup_without_owner_allowed = False
else:
    startup_without_owner_allowed = True

guard._startup_ready_marker_absent = lambda: False
try:
    guard._validate_action_readiness("seal-restart", False)
except guard.UnsafePathError as exc:
    stale_marker_error = str(exc)
else:
    stale_marker_error = ""

print(json.dumps({
    "host_allowed": host_allowed,
    "startup_allowed": startup_allowed,
    "startup_without_owner_allowed": startup_without_owner_allowed,
    "stale_marker_error": stale_marker_error,
}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      host_allowed: true,
      startup_allowed: true,
      startup_without_owner_allowed: false,
      stale_marker_error: "Hermes runtime config guard refuses mutation under a foreign PID 1",
    });
  });

  it("accepts direct legacy and namespace-remapped markers only for their live startup identity", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
from types import SimpleNamespace

class FakeOpen:
    def __init__(self, payload):
        self.payload = payload
        self.snapshot = SimpleNamespace(uid=0, gid=0, mode=0o600, nlink=1)
    def read_bytes(self, _max_bytes=None):
        return self.payload
    def close(self):
        pass

guard._process_start_time = lambda pid: "424242" if pid == 1 else None
guard._pid1_is_nemoclaw_start = lambda: True
payload = b"v1 111111\\n"
guard._open_regular = lambda _path: FakeOpen(payload)
stale = guard._startup_ready_for_current_pid1()
payload = b"v1 424242\\n"
legacy_current = guard._startup_ready_for_current_pid1()
payload = b"v1 424242\\nextra"
malformed = guard._startup_ready_for_current_pid1()
guard._pid1_is_nemoclaw_start = lambda: False
guard._startup_process_identity_is_live = lambda start_time, namespace_inode: (
    start_time == "424242" and namespace_inode == 515151
)
payload = b"v2 424242 515151\\n"
remapped_current = guard._startup_ready_for_current_pid1()
payload = b"v2 424242 616161\\n"
remapped_stale = guard._startup_ready_for_current_pid1()
print(json.dumps({
    "stale": stale,
    "legacy_current": legacy_current,
    "malformed": malformed,
    "remapped_current": remapped_current,
    "remapped_stale": remapped_stale,
}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      stale: false,
      legacy_current: true,
      malformed: false,
      remapped_current: true,
      remapped_stale: false,
    });
  });

  it("publishes a root-only marker containing the current PID 1 start time", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json

captured = {}
guard._process_start_time = lambda pid: "987654" if pid == 1 else None
guard._process_namespace_inode = lambda pid: 424242 if pid == 1 else None
guard._open_regular = lambda _path: (_ for _ in ()).throw(FileNotFoundError())

def capture(path, data, **kwargs):
    captured.update({
        "path": path,
        "data": data.decode("ascii"),
        "mode": kwargs["mode"],
        "uid": kwargs["uid"],
        "gid": kwargs["gid"],
        "create": kwargs["expected"] is None,
    })

guard._atomic_replace = capture
guard.publish_startup_ready()
print(json.dumps(captured))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: "v2 987654 424242\n",
      mode: 0o600,
      uid: 0,
      gid: 0,
      create: true,
    });
  });
});
