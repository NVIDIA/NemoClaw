// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const TRANSACTION = path.resolve(
  import.meta.dirname,
  "..",
  "agents/hermes/mcp-config-transaction.py",
);
const GUARD = path.resolve(import.meta.dirname, "..", "agents/hermes/runtime-config-guard.py");

function runPython(source: string, args: string[] = []) {
  return spawnSync("python3", ["-c", source, TRANSACTION, GUARD, ...args], {
    encoding: "utf8",
  });
}

describe("Hermes managed MCP config transaction", () => {
  it("rejects raw credentials, plaintext targets, and non-boolean control flags", () => {
    const result = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
bad = [
    {"server": "fake", "url": "https://mcp.example.test/mcp", "headers": {"Authorization": "Bearer raw-secret"}},
    {"server": "fake", "url": "http://host.openshell.internal/mcp", "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"}},
    {"server": "fake", "url": "https://mcp.example.test/mcp", "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"}, "replace_existing": "yes"},
]
errors = []
for payload in bad:
    try:
        module._validate_payload("add", payload)
    except ValueError as error:
        errors.append(str(error))
print(json.dumps(errors))
if len(errors) != len(bad):
    raise SystemExit(9)
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(3);
  });

  it("refuses a locked config snapshot", () => {
    const result = runPython(`
import importlib.util, sys, types
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.os.geteuid = lambda: 1000
try:
    module._assert_mutable_snapshot(types.SimpleNamespace(mode=0o440, uid=1000, gid=1000))
except RuntimeError as error:
    print(str(error))
else:
    raise SystemExit(9)
`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("locked");
  });

  it("treats edits to any managed field as drift during removal", () => {
    const result = runPython(`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
payload = {
    "server": "fake",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
}
candidate = module._managed_candidate(payload)
candidate["enabled"] = False
try:
    module._mutate({"mcp_servers": {"fake": candidate}}, "remove", payload)
except ValueError as error:
    print(str(error))
else:
    raise SystemExit(9)
`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Refusing to remove modified Hermes MCP server");
  });

  it("treats a null same-name Hermes server as drift rather than absence", () => {
    const result = runPython(`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
payload = {
    "server": "fake",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
}
try:
    module._mutate({"mcp_servers": {"fake": None}}, "remove", payload)
except ValueError as error:
    print(str(error))
else:
    raise SystemExit(9)
`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Refusing to remove modified Hermes MCP server");
  });

  it("allows root reload control to signal only the gateway service identity", () => {
    const result = runPython(`
import importlib.util, sys, types
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
gateway = types.ModuleType("gateway")
status = types.ModuleType("gateway.status")
status.get_running_pid = lambda cleanup_stale=False: 4242
status.get_process_start_time = lambda pid: 99
sys.modules["gateway"] = gateway
sys.modules["gateway.status"] = status
module.os.geteuid = lambda: 0
module.pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=2000)
module._is_trusted_gateway_process = lambda pid: True
module.os.stat = lambda path: types.SimpleNamespace(st_uid=1000)
try:
    module._gateway_identity()
except PermissionError as error:
    print(str(error))
else:
    raise SystemExit(9)
module.os.stat = lambda path: types.SimpleNamespace(st_uid=2000)
if module._gateway_identity() != (4242, 99):
    raise SystemExit(10)
module._is_trusted_gateway_process = lambda pid: False
try:
    module._gateway_identity()
except PermissionError as error:
    print(str(error))
else:
    raise SystemExit(11)
`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("expected gateway identity");
    expect(result.stdout).toContain("does not identify the trusted launcher");
  });

  it("allows an ordinary same-UID sandbox exec to reload the trusted gateway", () => {
    const result = runPython(`
import importlib.util, json, signal, sys, types
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

sandbox_uid = 1000
gateway_pid = 4242
gateway_state = {"start_time": 99}
observed = {
    "trusted_pids": [],
}
module.os.geteuid = lambda: sandbox_uid
module.os.lstat = lambda path: (_ for _ in ()).throw(FileNotFoundError(path))
observed["entrypoint_uid"] = module.os.geteuid()
module.pwd.getpwnam = lambda name: (_ for _ in ()).throw(
    AssertionError("same-UID reload must not resolve a separate gateway identity")
)

snapshot = types.SimpleNamespace(mode=0o600, uid=sandbox_uid, gid=sandbox_uid)
guard = types.SimpleNamespace(
    _read_text=lambda path: ("model: test\\n", snapshot),
)
module._load_guard = lambda: guard
def apply_transaction(action, payload):
    observed["helper_uid"] = module.os.geteuid()
    observed["action"] = action
    return True
module.apply_transaction = apply_transaction

gateway = types.ModuleType("gateway")
status = types.ModuleType("gateway.status")
status.get_running_pid = lambda cleanup_stale=False: gateway_pid
status.get_process_start_time = lambda pid: gateway_state["start_time"]
sys.modules["gateway"] = gateway
sys.modules["gateway.status"] = status

def stat_gateway(path):
    observed["gateway_owner_uid"] = sandbox_uid
    observed["gateway_check_uid"] = module.os.geteuid()
    return types.SimpleNamespace(st_uid=sandbox_uid)
module.os.stat = stat_gateway
def trusted_gateway(pid):
    observed["trusted_pids"].append(pid)
    return True
module._is_trusted_gateway_process = trusted_gateway
module._gateway_has_managed_parent = lambda pid: True
def signal_gateway(pid, sent_signal):
    observed["signal_uid"] = module.os.geteuid()
    observed["signal_pid"] = pid
    observed["signal_name"] = signal.Signals(sent_signal).name
    gateway_state["start_time"] = 100
module.os.kill = signal_gateway
def gateway_healthy():
    observed["health_uid"] = module.os.geteuid()
    return True
module._gateway_healthy = gateway_healthy

payload = {
    "server": "fake",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
    "replace_existing": False,
}
sys.argv = [sys.argv[1], "add", "--payload", json.dumps(payload)]
exit_code = module.main()
observed["exit_code"] = exit_code
print(json.dumps(observed, sort_keys=True))
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({ changed: true, ok: true, reloaded: true });
    expect(JSON.parse(lines[1] ?? "{}")).toEqual({
      action: "add",
      entrypoint_uid: 1000,
      exit_code: 0,
      gateway_check_uid: 1000,
      gateway_owner_uid: 1000,
      health_uid: 1000,
      helper_uid: 1000,
      signal_name: "SIGUSR1",
      signal_pid: 4242,
      signal_uid: 1000,
      trusted_pids: [4242, 4242, 4242, 4242],
    });
  });

  it("repairs and verifies strict and compatibility hashes on an unchanged retry", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-tx-"));
    const hermesDir = path.join(temp, ".hermes");
    const configPath = path.join(hermesDir, "config.yaml");
    const envPath = path.join(hermesDir, ".env");
    const strictHash = path.join(temp, "hermes.config-hash");
    const compatHash = path.join(hermesDir, ".config-hash");
    fs.mkdirSync(hermesDir);
    const config = `model: test
mcp_servers:
  fake:
    url: https://mcp.example.test/mcp
    enabled: true
    timeout: 120
    connect_timeout: 60
    tools:
      resources: true
      prompts: true
    headers:
      Authorization: Bearer openshell:resolve:env:FAKE_TOKEN
`;
    fs.writeFileSync(configPath, config, { mode: 0o600 });
    fs.writeFileSync(envPath, "HERMES_TEST=1\n", { mode: 0o600 });
    fs.writeFileSync(strictHash, "stale\n", { mode: 0o600 });
    fs.writeFileSync(compatHash, "different-stale\n", { mode: 0o600 });

    try {
      const result = runPython(
        `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.GUARD_PATH = sys.argv[2]
module.HERMES_DIR = sys.argv[3]
module.CONFIG_PATH = os.path.join(module.HERMES_DIR, "config.yaml")
module.STRICT_HASH_PATH = sys.argv[4]
module.os.geteuid = lambda: 0
module._require_lifecycle_identity = lambda: None
module._assert_mutable_snapshot = lambda snapshot: None
changed = module.apply_transaction("add", {
    "server": "fake",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
    "replace_existing": True,
})
print(json.dumps({"changed": changed}))
`,
        [hermesDir, strictHash],
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('"changed": false');
      const strict = fs.readFileSync(strictHash, "utf8");
      const compat = fs.readFileSync(compatHash, "utf8");
      expect(strict).toBe(compat);
      expect(strict).toContain(crypto.createHash("sha256").update(config).digest("hex"));
      expect(strict).toContain(
        crypto.createHash("sha256").update(fs.readFileSync(envPath)).digest("hex"),
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects ordinary exec in a root-separated Hermes topology", () => {
    const result = runPython(`
import importlib.util, json, stat, sys, types
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.os.geteuid = lambda: 1000
module.os.lstat = lambda path: types.SimpleNamespace(st_mode=stat.S_IFREG | 0o444, st_uid=0)
payload = {
    "server": "fake",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
    "replace_existing": False,
}
errors = []
for operation in (lambda: module.execute("add", payload), module.probe):
    try:
        operation()
    except PermissionError as error:
        errors.append(str(error))
if len(errors) != 2:
    raise SystemExit(9)
print(json.dumps(errors))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("requires a same-uid OpenShell sandbox runtime");
  });

  it("rejects a same-UID bare gateway before mutating managed MCP state", () => {
    const result = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.os.geteuid = lambda: 1000
module.os.lstat = lambda path: (_ for _ in ()).throw(FileNotFoundError(path))
module._gateway_identity = lambda: (123, 456)
module._gateway_has_managed_parent = lambda pid: False
calls = []
module.apply_transaction_and_reload = lambda action, payload: calls.append((action, payload))
payload = {
    "server": "fake",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
    "replace_existing": False,
}
errors = []
for operation in (lambda: module.execute("add", payload), module.probe):
    try:
        operation()
    except RuntimeError as error:
        errors.append(str(error))
if calls or len(errors) != 2:
    raise SystemExit(9)
print(json.dumps(errors))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("not running under the managed service lifecycle");
  });

  it("does not mistake a one-shot nemoclaw-start wrapper for the service manager", () => {
    const result = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
arguments = {
    1: [b"bash", module.SERVICE_MANAGER_PATH],
    2: [b"bash", module.SERVICE_MANAGER_PATH, b"true"],
    3: [b"bash", b"-c", b"text mentioning /usr/local/bin/nemoclaw-start"],
}
module._process_arguments = lambda pid: arguments[pid]
print(json.dumps({str(pid): module._is_service_manager_process(pid) for pid in arguments}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ "1": true, "2": false, "3": false });
  });

  it("runs a one-shot mutation through the stock OpenShell exec topology", () => {
    const result = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.os.geteuid = lambda: 1000
module.os.lstat = lambda path: (_ for _ in ()).throw(FileNotFoundError(path))
module._gateway_identity = lambda: (123, 456)
module._gateway_has_managed_parent = lambda pid: True
module.apply_transaction_and_reload = lambda action, payload: {
    "ok": True, "changed": True, "reloaded": True
}
result = module.execute("add", {
    "server": "fake",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
    "replace_existing": False,
})
print(json.dumps(result, sort_keys=True))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ changed: true, ok: true, reloaded: true });
  });

  it("probes the same-UID helper without mutating config", () => {
    const result = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.os.geteuid = lambda: 1000
module.os.lstat = lambda path: (_ for _ in ()).throw(FileNotFoundError(path))
module._gateway_identity = lambda: (123, 456)
module._gateway_has_managed_parent = lambda pid: True
print(json.dumps(module.probe(), sort_keys=True))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  });

  it("restores config and hashes when runtime reload fails", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-rollback-"));
    const hermesDir = path.join(temp, ".hermes");
    const configPath = path.join(hermesDir, "config.yaml");
    const envPath = path.join(hermesDir, ".env");
    const compatHash = path.join(hermesDir, ".config-hash");
    const strictHash = path.join(temp, "strict-hash");
    const config = "model: test\n";
    const env = "HERMES_TEST=1\n";
    const originalHash = `${crypto.createHash("sha256").update(config).digest("hex")}  ${configPath}\n${crypto.createHash("sha256").update(env).digest("hex")}  ${envPath}\n`;
    fs.mkdirSync(hermesDir);
    fs.writeFileSync(configPath, config, { mode: 0o600 });
    fs.writeFileSync(envPath, env, { mode: 0o600 });
    fs.writeFileSync(compatHash, originalHash, { mode: 0o600 });
    fs.writeFileSync(strictHash, originalHash, { mode: 0o600 });

    try {
      const result = runPython(
        `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.GUARD_PATH = sys.argv[2]
module.HERMES_DIR = sys.argv[3]
module.CONFIG_PATH = os.path.join(module.HERMES_DIR, "config.yaml")
module.STRICT_HASH_PATH = sys.argv[4]
module.os.geteuid = lambda: 0
module._require_lifecycle_identity = lambda: None
module._assert_mutable_snapshot = lambda snapshot: None
calls = []
def reload():
    calls.append(1)
    if len(calls) == 1:
        raise TimeoutError("forward reload timeout")
    return True
module.reload_gateway = reload
try:
    module.apply_transaction_and_reload("add", {
        "server": "fake",
        "url": "https://mcp.example.test/mcp",
        "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
        "replace_existing": False,
    })
except RuntimeError as error:
    print(json.dumps({"error": str(error), "reload_calls": len(calls)}))
else:
    raise SystemExit(9)
`,
        [hermesDir, strictHash],
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ reload_calls: 2 });
      expect(fs.readFileSync(configPath, "utf8")).toBe(config);
      expect(fs.readFileSync(compatHash, "utf8")).toBe(originalHash);
      expect(fs.readFileSync(strictHash, "utf8")).toBe(originalHash);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
