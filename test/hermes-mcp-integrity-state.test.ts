// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { bashPrintfQ, extractShellFunction } from "./support/hermes-shell-harness";

const GUARD = path.join(import.meta.dirname, "..", "agents", "hermes", "runtime-config-guard.py");
const BUILD_DIGEST = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "build-mcp-digest.py",
);
const TRANSACTION = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "mcp-config-transaction.py",
);
const START = path.join(import.meta.dirname, "..", "agents", "hermes", "start.sh");

function runHermesRootMcpStartup(commitStatus: 0 | 1) {
  const source = fs.readFileSync(START, "utf-8");
  const startupBlock = source.match(
    /^launch_hermes_gateway\nstart_gateway_log_stream\nwait_for_hermes_gateway_internal "\$GATEWAY_PID"\nensure_hermes_supervised_auxiliaries\nif ! commit_hermes_mcp_applied_if_pending; then\n[\s\S]*?^restore_hermes_config_permissions_after_dashboard_start$/m,
  )?.[0];
  expect(startupBlock).toBeDefined();
  const startupScript = startupBlock as string;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-root-start-"));
  const scriptPath = path.join(tempDir, "run.sh");
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'trace() { printf "%s\\n" "$*"; }',
      'launch_hermes_gateway() { GATEWAY_PID=4242; trace "launch:$GATEWAY_PID"; }',
      "start_gateway_log_stream() { trace log-stream; }",
      'wait_for_hermes_gateway_internal() { trace "health:$1"; }',
      "ensure_hermes_supervised_auxiliaries() { trace auxiliaries; }",
      `commit_hermes_mcp_applied_if_pending() { trace commit-applied; return ${commitStatus}; }`,
      "stop_hermes_gateway_fail_closed() { trace stop-fail-closed; }",
      "restore_hermes_config_permissions_after_dashboard_start() { trace restore-permissions; }",
      startupScript,
      "trace startup-complete",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    return spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      timeout: 5000,
      env: process.env,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("Hermes MCP intended/applied integrity state", () => {
  it("uses the runtime canonicalizer for the build-time MCP seal", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-build-seal-"));
    const config = path.join(tempDir, "config.yaml");
    fs.writeFileSync(
      config,
      "mcp_servers:\n  zed:\n    url: https://zed.example/mcp\n  alpha:\n    url: https://alpha.example/mcp\n",
    );

    try {
      const buildDigest = spawnSync(
        "python3",
        ["-I", BUILD_DIGEST, "--guard", GUARD, "--config", config],
        { encoding: "utf-8", timeout: 5000 },
      );
      const runtimeDigest = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("hermes_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
print(guard._canonical_mcp_servers_digest(open(sys.argv[2], encoding="utf-8").read()))
`,
          GUARD,
          config,
        ],
        { encoding: "utf-8", timeout: 5000 },
      );

      expect(buildDigest.status, buildDigest.stderr).toBe(0);
      expect(runtimeDigest.status, runtimeDigest.stderr).toBe(0);
      expect(buildDigest.stdout).toMatch(/^[0-9a-f]{64}\n$/u);
      expect(buildDigest.stdout).toBe(runtimeDigest.stdout);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("omits authenticated config bytes from integrity snapshot representations", () => {
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("hermes_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
metadata = guard.FileSnapshot(
    dev=1,
    ino=2,
    mode=0o600,
    uid=1000,
    gid=1000,
    nlink=1,
    size=64,
    mtime_ns=3,
    ctime_ns=4,
)
secret = "API_SERVER_KEY=must-not-appear"
snapshot = guard.McpIntegritySnapshot(
    state="current",
    config_text=secret,
    config_path="/sandbox/.hermes/config.yaml",
    config_snapshot=metadata,
    env_path="/sandbox/.hermes/.env",
    env_snapshot=metadata,
    hash_snapshots=(),
)
rendered = repr(snapshot)
print(json.dumps({
    "contains_config_field": "config_text=" in rendered,
    "contains_secret": secret in rendered,
    "is_snapshot_repr": rendered.startswith("McpIntegritySnapshot("),
}))
`,
        GUARD,
      ],
      { encoding: "utf-8", timeout: 5000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      contains_config_field: false,
      contains_secret: false,
      is_snapshot_repr: true,
    });
  });

  it("returns current and pending through the guarded CLI status protocol", () => {
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        String.raw`
import importlib.util, json, os, sys, tempfile
spec = importlib.util.spec_from_file_location("hermes_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
root = tempfile.mkdtemp(prefix="hermes-mcp-cli-status-")
hermes = os.path.join(root, ".hermes")
os.mkdir(hermes)
config = os.path.join(hermes, "config.yaml")
env = os.path.join(hermes, ".env")
anchor = os.path.join(root, "hermes.config-hash")
open(config, "w", encoding="utf-8").write("model: test\n")
open(env, "w", encoding="utf-8").write("SAFE=1\n")
hash_text, _config_snapshot, _env_snapshot = guard._hash_text(config, env)
guard._write_hash(anchor, hash_text)

def inspect_status():
    sys.argv = [
        "runtime-config-guard.py",
        "inspect-mcp-integrity",
        "--hermes-dir", hermes,
        "--hash-file", anchor,
        "--startup-owner",
        "--mcp-state-exit-code",
    ]
    return guard.main()

current = inspect_status()
open(config, "w", encoding="utf-8").write(
    "model: test\nmcp_servers:\n  alpha:\n    url: https://alpha.example/mcp\n"
)
guard.refresh_hashes(hermes, anchor, "strict", mcp_transition="intend")
pending = inspect_status()
sys.argv = [
    "runtime-config-guard.py",
    "ensure-api-key",
    "--hermes-dir", hermes,
    "--mcp-state-exit-code",
]
try:
    guard.main()
except SystemExit as error:
    misuse = error.code
else:
    misuse = 0
print(json.dumps({"current": current, "pending": pending, "misuse": misuse}))
`,
        GUARD,
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ current: 0, pending: 10, misuse: 1 });
  });

  it("uses the atomic write outcome for compat applied-state commits", () => {
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        String.raw`
import importlib.util, json, os, sys, tempfile
spec = importlib.util.spec_from_file_location("hermes_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
root = tempfile.mkdtemp(prefix="hermes-mcp-compat-apply-")
hermes = os.path.join(root, ".hermes")
os.mkdir(hermes)
config = os.path.join(hermes, "config.yaml")
env = os.path.join(hermes, ".env")
anchor = os.path.join(hermes, ".config-hash")
open(config, "w", encoding="utf-8").write("model: test\n")
open(env, "w", encoding="utf-8").write("SAFE=1\n")
hash_text, _config_snapshot, _env_snapshot = guard._hash_text(config, env)
guard._write_hash(anchor, hash_text)
open(config, "w", encoding="utf-8").write(
    "model: test\nmcp_servers:\n  alpha:\n    url: https://alpha.example/mcp\n"
)
guard.refresh_hashes(hermes, anchor, "compat", mcp_transition="intend")
original_access = guard.os.access
guard.os.access = lambda *_args: False
guard.refresh_hashes(hermes, anchor, "compat", mcp_transition="apply")
false_negative_state = guard.inspect_mcp_integrity(hermes, anchor)
guard.os.access = original_access
open(config, "w", encoding="utf-8").write(
    "model: test\nmcp_servers:\n  beta:\n    url: https://beta.example/mcp\n"
)
guard.refresh_hashes(hermes, anchor, "compat", mcp_transition="intend")
pending_text = open(anchor, encoding="utf-8").read()
guard._write_hash = lambda *_args: (_ for _ in ()).throw(
    PermissionError(13, "permission denied")
)
try:
    guard.refresh_hashes(hermes, anchor, "compat", mcp_transition="apply")
except PermissionError:
    write_denied = True
else:
    write_denied = False
print(json.dumps({
    "false_negative_state": false_negative_state,
    "write_denied": write_denied,
    "unchanged": open(anchor, encoding="utf-8").read() == pending_text,
}))
`,
        GUARD,
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      false_negative_state: "current",
      write_denied: true,
      unchanged: true,
    });
  });

  it("runs startup-owned MCP inspection as a direct child", () => {
    const source = fs.readFileSync(START, "utf-8");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-parent-"));
    const helper = path.join(tempDir, "guard-helper.sh");
    const parentFile = path.join(tempDir, "guard-parent");
    fs.writeFileSync(
      helper,
      [
        "#!/bin/bash",
        "set -euo pipefail",
        'printf "%s\\n" "$PPID" >"$NEMOCLAW_TEST_GUARD_PARENT_FILE"',
        'printf "%s\\n" "mcp_state=current"',
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -euo pipefail",
            extractShellFunction(source, "inspect_hermes_mcp_integrity"),
            `_HERMES_PYTHON=${bashPrintfQ(helper)}`,
            "_HERMES_RUNTIME_CONFIG_GUARD=/test/runtime-config-guard.py",
            "HERMES_DIR=/test/.hermes",
            "HERMES_HASH_FILE=/test/hermes.config-hash",
            `NEMOCLAW_TEST_GUARD_PARENT_FILE=${bashPrintfQ(parentFile)}`,
            "export NEMOCLAW_TEST_GUARD_PARENT_FILE",
            "HERMES_MCP_RECONCILE_PENDING=9",
            "caller_pid=$BASHPID",
            "inspect_hermes_mcp_integrity",
            'IFS= read -r guard_parent <"$NEMOCLAW_TEST_GUARD_PARENT_FILE"',
            '[ "$guard_parent" = "$caller_pid" ]',
            'printf "pending=%s\\n" "$HERMES_MCP_RECONCILE_PENDING"',
          ].join("\n"),
        ],
        { encoding: "utf-8", timeout: 5000 },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("pending=0\n");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    { status: 0, expected: "rc=0 pending=0 failed=0\n" },
    { status: 10, expected: "rc=0 pending=1 failed=0\n" },
    { status: 1, expected: "rc=1 pending=9 failed=1\n" },
  ])("uses only the authenticated guard exit status ($status)", ({ status, expected }) => {
    const source = fs.readFileSync(START, "utf-8");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-status-"));
    const helper = path.join(tempDir, "guard-helper.sh");
    fs.writeFileSync(
      helper,
      [
        "#!/bin/bash",
        "set -euo pipefail",
        "printf 'mcp_state=current\\0attacker\\nmcp_state=pending'",
        `exit ${status}`,
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -uo pipefail",
            extractShellFunction(source, "inspect_hermes_mcp_integrity"),
            `_HERMES_PYTHON=${bashPrintfQ(helper)}`,
            "_HERMES_RUNTIME_CONFIG_GUARD=/test/runtime-config-guard.py",
            "HERMES_DIR=/test/.hermes",
            "HERMES_HASH_FILE=/test/hermes.config-hash",
            "HERMES_MCP_RECONCILE_PENDING=9",
            "HERMES_MCP_INTEGRITY_FAILED=0",
            "if inspect_hermes_mcp_integrity; then rc=0; else rc=$?; fi",
            'printf "rc=%s pending=%s failed=%s\\n" "$rc" "$HERMES_MCP_RECONCILE_PENDING" "$HERMES_MCP_INTEGRITY_FAILED"',
          ].join("\n"),
        ],
        { encoding: "utf-8", timeout: 5000 },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(expected);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unmanaged fields in the host inspection projection", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
candidate = module._managed_candidate({
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:SAFE_MCP_TOKEN"},
})
rejected = []
for field, value in (
    ("command", "touch /tmp/pwned"),
    ("transport", "stdio"),
    ("extra", True),
):
    payload = {"present": {"safe": {**candidate, field: value}}, "absent": []}
    try:
        module._validate_inspection_payload(payload)
    except ValueError as error:
        rejected.append(str(error))
print(json.dumps(rejected))
`,
        TRANSACTION,
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      "Hermes MCP inspection expected config has invalid fields",
      "Hermes MCP inspection expected config has invalid fields",
      "Hermes MCP inspection expected config has invalid fields",
    ]);
  });

  it("reports a managed config match only after the gateway-applied state is current", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util, json, sys, types, yaml
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.HERMES_DIR = "/tmp/.hermes"
module.CONFIG_PATH = "/tmp/.hermes/config.yaml"
module.os.geteuid = lambda: 1000
candidate = module._managed_candidate({
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:SAFE_MCP_TOKEN"},
})
payload = {"present": {"safe": candidate}, "absent": []}
outcomes = {}
for integrity_state in ("current", "pending"):
    module._load_guard = lambda state=integrity_state: types.SimpleNamespace(
        inspect_mcp_integrity_snapshot=lambda *_args: types.SimpleNamespace(
            state=state,
            config_text=yaml.safe_dump(
                {"mcp_servers": {"safe": candidate}}, sort_keys=False
            ),
        ),
        assert_mcp_integrity_snapshot_current=lambda *_args: None,
    )
    try:
        outcomes[integrity_state] = module.inspect_managed_config(payload)
    except RuntimeError as error:
        outcomes[integrity_state] = str(error)
print(json.dumps(outcomes))
`,
        TRANSACTION,
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      current: { ok: true, state: "matched" },
      pending: "Hermes MCP config does not match applied gateway state",
    });
  });

  it("refuses diverged root anchors and config races after integrity verification", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util, json, os, sys, tempfile, yaml

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

transaction = load("mcp_tx", sys.argv[1])
guard = load("hermes_guard", sys.argv[2])
root = tempfile.mkdtemp(prefix="hermes-mcp-inspect-race-")
hermes = os.path.join(root, ".hermes")
os.mkdir(hermes)
config = os.path.join(hermes, "config.yaml")
env = os.path.join(hermes, ".env")
strict = os.path.join(root, "strict-hash")
compat = os.path.join(hermes, ".config-hash")
candidate = transaction._managed_candidate({
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:SAFE_MCP_TOKEN"},
})
with open(config, "w", encoding="utf-8") as handle:
    handle.write(yaml.safe_dump({"mcp_servers": {"safe": candidate}}, sort_keys=False))
with open(env, "w", encoding="utf-8") as handle:
    handle.write("SAFE=1\n")
hash_text, _config_snapshot, _env_snapshot = guard._hash_text(config, env)
guard._write_hash(strict, hash_text)
guard._write_hash(compat, "diverged\n")

transaction.HERMES_DIR = hermes
transaction.CONFIG_PATH = config
transaction.STRICT_HASH_PATH = strict
transaction.os.geteuid = lambda: 0
transaction._load_guard = lambda: guard
try:
    transaction.inspect_managed_config({"present": {"safe": candidate}, "absent": []})
except Exception as error:
    diverged = str(error)
guard._write_hash(compat, hash_text)
original_inspect = guard.inspect_mcp_integrity_snapshot
def race_after_authentication(*args):
    inspection = original_inspect(*args)
    changed = {**candidate, "url": "https://attacker.example.test/mcp"}
    with open(config, "w", encoding="utf-8") as handle:
        handle.write(yaml.safe_dump({"mcp_servers": {"safe": changed}}, sort_keys=False))
    return inspection
guard.inspect_mcp_integrity_snapshot = race_after_authentication

try:
    raced = transaction.inspect_managed_config(
        {"present": {"safe": candidate}, "absent": []}
    )
except Exception as error:
    raced = str(error)
print(json.dumps({"diverged": diverged, "raced": raced}))
`,
        TRANSACTION,
        GUARD,
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      diverged: "Hermes strict and compatibility MCP integrity anchors differ",
      raced: "refusing raced Hermes MCP integrity snapshot",
    });
  });

  it("derives the full config hash and MCP digest from one config snapshot", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util, json, os, sys, tempfile
spec = importlib.util.spec_from_file_location("hermes_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
root = tempfile.mkdtemp(prefix="hermes-mcp-single-read-")
hermes = os.path.join(root, ".hermes")
os.mkdir(hermes)
config = os.path.join(hermes, "config.yaml")
env = os.path.join(hermes, ".env")
strict = os.path.join(root, "hash")
open(config, "w", encoding="utf-8").write("model: test\nmcp_servers: {}\n")
open(env, "w", encoding="utf-8").write("SAFE=1\n")
initial, _config_snapshot, _env_snapshot = guard._hash_text(config, env)
guard._write_hash(strict, initial)
original_read_text = guard._read_text
config_reads = 0
def counted_read_text(path, *args, **kwargs):
    global config_reads
    if path == config:
        config_reads += 1
    return original_read_text(path, *args, **kwargs)
guard._read_text = counted_read_text
state = guard.inspect_mcp_integrity(hermes, strict)
print(json.dumps({"state": state, "config_reads": config_reads}))
`,
        GUARD,
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ state: "current", config_reads: 1 });
  });

  it("commits pending state after root gateway health before continuing startup", () => {
    const success = runHermesRootMcpStartup(0);
    expect(success.status, success.stderr).toBe(0);
    expect(success.stdout.trim().split("\n")).toEqual([
      "launch:4242",
      "log-stream",
      "health:4242",
      "auxiliaries",
      "commit-applied",
      "restore-permissions",
      "startup-complete",
    ]);
  });

  it("fails root startup closed when the applied-state commit fails after gateway health", () => {
    const failure = runHermesRootMcpStartup(1);
    expect(failure.status).toBe(1);
    expect(failure.stdout.trim().split("\n")).toEqual([
      "launch:4242",
      "log-stream",
      "health:4242",
      "auxiliaries",
      "commit-applied",
      "stop-fail-closed",
    ]);
    expect(failure.stderr).toContain("HERMES_MCP_APPLIED_COMMIT_FAILED");
    expect(failure.stdout).not.toContain("restore-permissions");
    expect(failure.stdout).not.toContain("startup-complete");
  });

  it("tracks add and removal as pending until the gateway-applied commit", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util, json, os, sys, tempfile

spec = importlib.util.spec_from_file_location("hermes_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
root = tempfile.mkdtemp(prefix="hermes-mcp-integrity-")
hermes = os.path.join(root, ".hermes")
os.mkdir(hermes)
config = os.path.join(hermes, "config.yaml")
env = os.path.join(hermes, ".env")
strict = os.path.join(root, "hermes.config-hash")
compat = os.path.join(hermes, ".config-hash")
open(config, "w", encoding="utf-8").write("model: test\n")
open(env, "w", encoding="utf-8").write("SAFE=1\n")
initial_hash, _config_snapshot, _env_snapshot = guard._hash_text(config, env)
guard._write_hash(strict, initial_hash)
guard._write_hash(compat, initial_hash)
states = [guard.inspect_mcp_integrity(hermes, strict)]

managed = """model: test
mcp_servers:
  fake:
    url: https://mcp.example.test/mcp
    enabled: true
    timeout: 120
    connect_timeout: 60
    tools: {resources: true, prompts: true}
    headers:
      Authorization: Bearer openshell:resolve:env:FAKE_TOKEN
"""
open(config, "w", encoding="utf-8").write(managed)
guard.refresh_hashes(hermes, strict, "strict", mcp_transition="intend")
guard.refresh_hashes(hermes, strict, "compat", mcp_transition="intend")
states.append(guard.inspect_mcp_integrity(hermes, strict))
guard.refresh_hashes(hermes, strict, "strict", mcp_transition="apply")
guard.refresh_hashes(hermes, strict, "compat", mcp_transition="apply")
states.append(guard.inspect_mcp_integrity(hermes, strict))

open(config, "w", encoding="utf-8").write("model: test\n")
guard.refresh_hashes(hermes, strict, "strict", mcp_transition="intend")
guard.refresh_hashes(hermes, strict, "compat", mcp_transition="intend")
states.append(guard.inspect_mcp_integrity(hermes, strict))
guard.refresh_hashes(hermes, strict, "strict", mcp_transition="apply")
guard.refresh_hashes(hermes, strict, "compat", mcp_transition="apply")
states.append(guard.inspect_mcp_integrity(hermes, strict))
hash_text = open(strict, encoding="utf-8").read()
print(json.dumps({"states": states, "hash": hash_text}))
`,
        GUARD,
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout) as { states: string[]; hash: string };
    expect(proof.states).toEqual(["current", "pending", "current", "pending", "current"]);
    expect(proof.hash).toMatch(
      /# nemoclaw-hermes-mcp-state-v1 intended=[0-9a-f]{64} applied=[0-9a-f]{64}/u,
    );
    expect(proof.hash).not.toContain("FAKE_TOKEN");
  });

  it("refuses a second intent while a prior MCP transaction is incomplete", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util, json, os, sys, tempfile
spec = importlib.util.spec_from_file_location("hermes_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
root = tempfile.mkdtemp(prefix="hermes-mcp-incomplete-intent-")
hermes = os.path.join(root, ".hermes")
os.mkdir(hermes)
config = os.path.join(hermes, "config.yaml")
env = os.path.join(hermes, ".env")
strict = os.path.join(root, "hash")
open(config, "w", encoding="utf-8").write("model: test\n")
open(env, "w", encoding="utf-8").write("SAFE=1\n")
initial, _config_snapshot, _env_snapshot = guard._hash_text(config, env)
guard._write_hash(strict, initial)
open(config, "w", encoding="utf-8").write(
    "model: test\nmcp_servers: {fake: {url: https://first.example.test/mcp}}\n"
)
guard.refresh_hashes(hermes, strict, "strict", mcp_transition="intend")
pending_hash = open(strict, encoding="utf-8").read()
open(config, "w", encoding="utf-8").write(
    "model: test\nmcp_servers: {fake: {url: https://second.example.test/mcp}}\n"
)
try:
    guard.refresh_hashes(hermes, strict, "strict", mcp_transition="intend")
except Exception as error:
    refusal = str(error)
else:
    refusal = ""
print(json.dumps({
    "refusal": refusal,
    "hash_unchanged": open(strict, encoding="utf-8").read() == pending_hash,
}))
`,
        GUARD,
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      refusal: "Hermes MCP configuration has an incomplete prior transaction",
      hash_unchanged: true,
    });
  });

  it("does not bless unrelated config or env drift while committing applied state", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util, json, os, sys, tempfile
spec = importlib.util.spec_from_file_location("hermes_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
root = tempfile.mkdtemp(prefix="hermes-mcp-apply-race-")
hermes = os.path.join(root, ".hermes")
os.mkdir(hermes)
config = os.path.join(hermes, "config.yaml")
env = os.path.join(hermes, ".env")
strict = os.path.join(root, "hash")
compat = os.path.join(hermes, ".config-hash")
open(config, "w", encoding="utf-8").write("model: test\n")
open(env, "w", encoding="utf-8").write("SAFE=1\n")
initial, _config_snapshot, _env_snapshot = guard._hash_text(config, env)
guard._write_hash(strict, initial)
guard._write_hash(compat, initial)
pending_config = "model: test\nmcp_servers: {fake: {url: https://mcp.example.test/mcp}}\n"
open(config, "w", encoding="utf-8").write(pending_config)
guard.refresh_hashes(hermes, strict, "strict", mcp_transition="intend")
guard.refresh_hashes(hermes, strict, "compat", mcp_transition="intend")
pending_hash = open(strict, encoding="utf-8").read()
errors = []
open(env, "w", encoding="utf-8").write("SAFE=changed-canary\n")
try:
    guard.refresh_hashes(hermes, strict, "strict", mcp_transition="apply")
except Exception as error:
    errors.append(str(error))
open(env, "w", encoding="utf-8").write("SAFE=1\n")
open(config, "w", encoding="utf-8").write(pending_config.replace("model: test", "model: drift-canary"))
try:
    guard.refresh_hashes(hermes, strict, "strict", mcp_transition="apply")
except Exception as error:
    errors.append(str(error))
print(json.dumps({"errors": errors, "hash_unchanged": open(strict, encoding="utf-8").read() == pending_hash}))
`,
        GUARD,
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout) as { errors: string[]; hash_unchanged: boolean };
    expect(proof.errors).toHaveLength(2);
    expect(proof.hash_unchanged).toBe(true);
    expect(proof.errors.join("\n")).not.toMatch(/changed-canary|drift-canary/u);
  });

  it("fails closed on drift and malformed or missing MCP metadata", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util, json, os, sys, tempfile
spec = importlib.util.spec_from_file_location("hermes_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
root = tempfile.mkdtemp(prefix="hermes-mcp-refusal-")
hermes = os.path.join(root, ".hermes")
os.mkdir(hermes)
config = os.path.join(hermes, "config.yaml")
env = os.path.join(hermes, ".env")
strict = os.path.join(root, "hash")
open(config, "w", encoding="utf-8").write("model: test\n")
open(env, "w", encoding="utf-8").write("SAFE=1\n")
initial_hash, _config_snapshot, _env_snapshot = guard._hash_text(config, env)
guard._write_hash(strict, initial_hash)
errors = []
open(config, "w", encoding="utf-8").write("mcp_servers: {fake: {token: raw-canary}}\n")
for operation in (
    lambda: guard.inspect_mcp_integrity(hermes, strict),
    lambda: (open(strict, "w", encoding="utf-8").write("malformed\n"), guard.inspect_mcp_integrity(hermes, strict))[1],
    lambda: (os.unlink(strict), guard.inspect_mcp_integrity(hermes, strict))[1],
    lambda: guard.refresh_hashes(hermes, strict, "strict"),
):
    try:
        operation()
    except Exception as error:
        errors.append(str(error))
print(json.dumps({"errors": errors, "hash_exists": os.path.exists(strict)}))
`,
        GUARD,
      ],
      { encoding: "utf-8", timeout: 10_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout) as { errors: string[]; hash_exists: boolean };
    expect(proof.errors).toHaveLength(4);
    expect(proof.hash_exists).toBe(false);
    expect(proof.errors.join("\n")).not.toContain("raw-canary");
  });
});
