// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildMessagingRuntimePlanArtifact,
  type MessagingBuildPlan,
} from "../../../src/lib/messaging/applier/build/messaging-build-applier.mts";

const RUNTIME_CONFIG_GUARD = path.join(
  import.meta.dirname,
  "../../..",
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

describe("Hermes candidate schema validation (#8614)", () => {
  it("rejects an incomplete home_channel before a sealed write transaction starts", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import types

guard.seal_restart = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not seal"))
guard.os.path.exists = lambda value: value.endswith("config.yaml")
class GatewayConfig:
    @classmethod
    def from_dict(cls, value):
        home_channel = value["platforms"]["teams"]["home_channel"]
        if "platform" not in home_channel:
            raise KeyError("platforms.teams.home_channel.platform")
sys.modules["gateway.config"] = types.SimpleNamespace(GatewayConfig=GatewayConfig)
try:
    guard.write_config_transaction(
        "/unused", "/unused-hash", "/unused-state", "a" * 64,
        b"platforms:\\n  teams:\\n    home_channel:\\n      chat_id: 19:triage8614\\n",
    )
except guard.UnsafePathError as exc:
    print(json.dumps(str(exc)))
`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toContain("platforms.teams.home_channel.platform");
  });
});

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

    initial_hash, _config_snapshot, _env_snapshot = guard._hash_text(config_path, env_path)
    guard._write_hash(hash_path, initial_hash)
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

    initial_hash, _config_snapshot, _env_snapshot = guard._hash_text(config_path, env_path)
    guard._write_hash(strict_hash_path, initial_hash)
    original_hash_text = guard._hash_text
    original_write_hash = guard._write_hash
    hash_text_calls = 0
    writes = []

    def counted_hash_text(config, env, *args):
        global hash_text_calls
        hash_text_calls += 1
        return original_hash_text(config, env, *args)

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

  it("rejects stale compatibility state before an applied-state commit without leaking secrets", () => {
    const result = runPythonHarness(`${loadGuardModule}
import contextlib
import io
import json
import os
import tempfile

secret = "SECRET_CANARY_DO_NOT_LEAK"
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
        handle.write(f"API_SERVER_KEY={secret}\\n")

    initial_hash, _config_snapshot, _env_snapshot = guard._hash_text(config_path, env_path)
    guard._write_hash(strict_hash_path, initial_hash)
    guard._write_hash(compat_hash_path, initial_hash)
    with open(config_path, "w", encoding="utf-8") as handle:
        handle.write(
            "model:\\n  default: test-model\\n"
            "mcp_servers:\\n"
            "  alpha:\\n"
            "    url: https://alpha.example/mcp\\n"
        )
    guard.refresh_hashes(hermes_dir, strict_hash_path, "both", mcp_transition="intend")
    with open(strict_hash_path, encoding="utf-8") as handle:
        pending_hash = handle.read()
    guard._write_hash(compat_hash_path, initial_hash)

    logs = io.StringIO()
    error = ""
    with contextlib.redirect_stdout(logs), contextlib.redirect_stderr(logs):
        try:
            guard.refresh_hashes(hermes_dir, strict_hash_path, "both", mcp_transition="apply")
        except guard.UnsafePathError as exc:
            error = str(exc)

    with open(strict_hash_path, encoding="utf-8") as handle:
        strict_after = handle.read()
    with open(compat_hash_path, encoding="utf-8") as handle:
        compat_after = handle.read()
    output = logs.getvalue()
    print(json.dumps({
        "error": error,
        "strict_unchanged": strict_after == pending_hash,
        "compat_unchanged": compat_after == initial_hash,
        "secret_in_error": secret in error,
        "secret_in_logs": secret in output,
    }))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      error: "Hermes strict and compatibility MCP state differ before applied-state commit",
      strict_unchanged: true,
      compat_unchanged: true,
      secret_in_error: false,
      secret_in_logs: false,
    });
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

    initial_hash, _config_snapshot, _env_snapshot = guard._hash_text(config_path, env_path)
    guard._write_hash(strict_hash_path, initial_hash)
    guard._write_hash(compat_hash_path, initial_hash)
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
  it("carries image-artifact credential aliases into Hermes-native env keys (#10079)", () => {
    const plan = {
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "hermes",
      channels: [
        { channelId: "wechat", active: true, disabled: false },
        { channelId: "teams", active: true, disabled: false },
      ],
      disabledChannels: [],
      credentialBindings: [
        { channelId: "wechat", providerEnvKey: "WECHAT_BOT_TOKEN" },
        { channelId: "teams", providerEnvKey: "MSTEAMS_APP_PASSWORD" },
      ],
      agentRender: [],
      buildSteps: [],
      runtimeSetup: {
        nodePreloads: [],
        envAliases: [
          {
            channelId: "wechat",
            envKey: "WECHAT_BOT_TOKEN",
            targetEnvKey: "WEIXIN_TOKEN",
            match: "^openshell:resolve:env:v[0-9]+_WECHAT_BOT_TOKEN$",
            value: "openshell:resolve:env:WECHAT_BOT_TOKEN",
          },
          {
            channelId: "teams",
            envKey: "MSTEAMS_APP_PASSWORD",
            targetEnvKey: "TEAMS_CLIENT_SECRET",
            match: "^openshell:resolve:env:v[0-9]+_MSTEAMS_APP_PASSWORD$",
            value: "openshell:resolve:env:MSTEAMS_APP_PASSWORD",
          },
        ],
        secretScans: [],
      },
    } satisfies MessagingBuildPlan;
    const runtimeArtifact = buildMessagingRuntimePlanArtifact(plan);
    expect(runtimeArtifact).toBeTruthy();

    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile

with tempfile.TemporaryDirectory() as tmp:
    env_path = os.path.join(tmp, ".env")
    plan_path = os.path.join(tmp, "runtime-plan.json")
    with open(env_path, "w", encoding="utf-8") as handle:
        handle.write("WEIXIN_TOKEN=openshell:resolve:env:WECHAT_BOT_TOKEN\\n")
        handle.write("TEAMS_CLIENT_SECRET=openshell:resolve:env:MSTEAMS_APP_PASSWORD\\n")
    with open(plan_path, "w", encoding="utf-8") as handle:
        json.dump(json.loads(${JSON.stringify(JSON.stringify(runtimeArtifact))}), handle)

    os.environ["WECHAT_BOT_TOKEN"] = "openshell:resolve:env:v222_WECHAT_BOT_TOKEN"
    os.environ["MSTEAMS_APP_PASSWORD"] = "openshell:resolve:env:v333_MSTEAMS_APP_PASSWORD"
    guard._validate_env_text_with_boundary = lambda *_args: None
    guard._write_existing = lambda path, text, *_args: open(path, "w", encoding="utf-8").write(text)
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
    print("SOURCE_WECHAT_BOT_TOKEN=" + os.environ["WECHAT_BOT_TOKEN"])
    print("SOURCE_MSTEAMS_APP_PASSWORD=" + os.environ["MSTEAMS_APP_PASSWORD"])
`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("WEIXIN_TOKEN=openshell:resolve:env:v222_WECHAT_BOT_TOKEN\n");
    expect(result.stdout).toContain(
      "TEAMS_CLIENT_SECRET=openshell:resolve:env:v333_MSTEAMS_APP_PASSWORD\n",
    );
    expect(result.stdout).toContain(
      "SOURCE_WECHAT_BOT_TOKEN=openshell:resolve:env:v222_WECHAT_BOT_TOKEN\n",
    );
    expect(result.stdout).toContain(
      "SOURCE_MSTEAMS_APP_PASSWORD=openshell:resolve:env:v333_MSTEAMS_APP_PASSWORD\n",
    );
    expect(result.stderr).toContain(
      "[config] Refreshed Hermes provider placeholder for WEIXIN_TOKEN",
    );
    expect(result.stderr).toContain(
      "[config] Refreshed Hermes provider placeholder for TEAMS_CLIENT_SECRET",
    );
  });

  it.each([
    ["wechat", "WECHAT_BOT_TOKEN", "WEIXIN_TOKEN"],
    ["teams", "MSTEAMS_APP_PASSWORD", "TEAMS_CLIENT_SECRET"],
  ] as const)(
    "copies the %s revision-scoped provider placeholder and logs only validated keys (#10079)",
    (channelId, envKey, targetEnvKey) => {
      const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile

with tempfile.TemporaryDirectory() as tmp:
    env_path = os.path.join(tmp, ".env")
    plan_path = os.path.join(tmp, "runtime-plan.json")
    with open(env_path, "w", encoding="utf-8") as handle:
        handle.write(${JSON.stringify(`${targetEnvKey}=openshell:resolve:env:${envKey}\n`)})
    with open(plan_path, "w", encoding="utf-8") as handle:
        json.dump({
            "channels": [{"channelId": ${JSON.stringify(channelId)}, "active": True}],
            "credentialBindings": [{
                "channelId": ${JSON.stringify(channelId)},
                "providerEnvKey": ${JSON.stringify(envKey)},
            }],
            "runtimeSetup": {
                "envAliases": [{
                    "channelId": ${JSON.stringify(channelId)},
                    "envKey": ${JSON.stringify(envKey)},
                    "targetEnvKey": ${JSON.stringify(targetEnvKey)},
                    "match": ${JSON.stringify(`^openshell:resolve:env:v[0-9]+_${envKey}$`)},
                    "value": ${JSON.stringify(`openshell:resolve:env:${envKey}`)},
                    "message": "Authorization: Bearer should-never-be-logged",
                }],
            },
        }, handle)

    os.environ[${JSON.stringify(envKey)}] = ${JSON.stringify(`openshell:resolve:env:v222_${envKey}`)}
    guard._validate_env_text_with_boundary = lambda *_args: None
    guard._write_existing = lambda path, text, *_args: open(path, "w", encoding="utf-8").write(text)
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
    os.environ[${JSON.stringify(envKey)}] = "raw-test-value"
    raw_replacements, _provider_keys, _loaded = (
        guard._runtime_plan_replacements_and_provider_keys(plan_path)
    )
    print("raw_replacements=" + json.dumps(raw_replacements, sort_keys=True))
    os.environ[${JSON.stringify(envKey)}] = ${JSON.stringify(`openshell:resolve:env:${envKey}`)}
    canonical_replacements, _provider_keys, _loaded = (
        guard._runtime_plan_replacements_and_provider_keys(plan_path)
    )
    print("canonical_replacements=" + json.dumps(canonical_replacements, sort_keys=True))
`);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`${targetEnvKey}=openshell:resolve:env:v222_${envKey}\n`);
      expect(result.stdout).toContain(`${envKey}=openshell:resolve:env:v222_${envKey}\n`);
      expect(result.stdout).toContain("raw_replacements={}");
      expect(result.stdout).toContain("canonical_replacements={}");
      expect(result.stderr).toContain(
        `[config] Refreshed Hermes provider placeholder for ${targetEnvKey}`,
      );
      expect(result.stderr).not.toContain("Authorization");
      expect(result.stderr).not.toContain("should-never-be-logged");
    },
  );
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

try:
    guard._validate_action_readiness("inspect-mcp-integrity", True)
except guard.UnsafePathError:
    inspect_allowed = False
else:
    inspect_allowed = True

try:
    guard._validate_action_readiness("inspect-mcp-integrity", False)
except guard.UnsafePathError:
    inspect_without_owner_allowed = False
else:
    inspect_without_owner_allowed = True

try:
    guard._validate_action_readiness("commit-mcp-applied", True)
except guard.UnsafePathError:
    commit_allowed = False
else:
    commit_allowed = True

try:
    guard._validate_action_readiness("commit-mcp-applied", False)
except guard.UnsafePathError:
    commit_without_owner_allowed = False
else:
    commit_without_owner_allowed = True

guard._startup_ready_marker_absent = lambda: False
try:
    guard._validate_action_readiness("seal-restart", False)
except guard.UnsafePathError as exc:
    stale_marker_error = str(exc)
else:
    stale_marker_error = ""

print(json.dumps({
    "commit_allowed": commit_allowed,
    "commit_without_owner_allowed": commit_without_owner_allowed,
    "host_allowed": host_allowed,
    "inspect_allowed": inspect_allowed,
    "inspect_without_owner_allowed": inspect_without_owner_allowed,
    "startup_allowed": startup_allowed,
    "startup_without_owner_allowed": startup_without_owner_allowed,
    "stale_marker_error": stale_marker_error,
}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      commit_allowed: true,
      commit_without_owner_allowed: false,
      host_allowed: true,
      inspect_allowed: true,
      inspect_without_owner_allowed: false,
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
