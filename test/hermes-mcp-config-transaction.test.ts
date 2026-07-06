// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeMcpServerUrl,
  validateMcpCredentialEnvName,
} from "../src/lib/actions/sandbox/mcp-bridge-validation";
import credentialBoundaryManifest from "../src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.72.json";

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

  it("keeps Hermes and host MCP URL rejection boundaries in parity", () => {
    const cases = [
      { url: "https://mcp.example.com/mcp", accepted: true },
      { url: "https://mcp.example.com./mcp", accepted: false },
      { url: "https://host.openshell.internal:31337/mcp", accepted: false },
      { url: "https://host.docker.internal:31337/mcp", accepted: false },
      { url: "https://host.containers.internal:31337/mcp", accepted: false },
      { url: "https://8.8.8.8/mcp", accepted: true },
      { url: "http://mcp.example.com/mcp", accepted: false },
      { url: "https://localhost/mcp", accepted: false },
      { url: "https://service.internal/mcp", accepted: false },
      { url: "https://127.0.0.1/mcp", accepted: false },
      { url: "https://10.0.0.1/mcp", accepted: false },
      { url: "https://100.64.0.1/mcp", accepted: false },
      { url: "https://169.254.169.254/mcp", accepted: false },
      { url: "https://192.0.2.1/mcp", accepted: false },
      { url: "https://198.18.0.1/mcp", accepted: false },
      { url: "https://224.0.0.1/mcp", accepted: false },
      { url: "https://[::1]/mcp", accepted: false },
      { url: "https://[fc00::1]/mcp", accepted: false },
      { url: "https://[fe80::1]/mcp", accepted: false },
      { url: "https://[2001:db8::1]/mcp", accepted: false },
      { url: "https://[ff02::1]/mcp", accepted: false },
      { url: "https://[::ffff:127.0.0.1]/mcp", accepted: false },
      { url: "https://[2606:4700:4700::1111]/mcp", accepted: false },
      { url: "https://2130706433/mcp", accepted: false },
      { url: "https://user:password@mcp.example.com/mcp", accepted: false },
      { url: "https://mcp.example.com//mcp", accepted: false },
      { url: "https://mcp.example.com/mcp\\child", accepted: false },
      { url: "https://mcp.example.com/%2f", accepted: false },
      { url: "https://mcp.example.com/%", accepted: false },
      { url: "https://mcp.example.com/%GG", accepted: false },
      { url: "https://mcp.example.com/%2", accepted: false },
      { url: "https://mcp.example.com/mcp?token=x", accepted: false },
      { url: "https://mcp.example.com/mcp#fragment", accepted: false },
      { url: "wss://mcp.example.com/mcp", accepted: false },
    ];
    const expected = cases.map(({ accepted }) => accepted);
    const hostResults = cases.map(({ url }) => {
      try {
        normalizeMcpServerUrl(url);
        return true;
      } catch {
        return false;
      }
    });
    const result = runPython(
      `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
results = []
for url in json.loads(sys.argv[3]):
    payload = {
        "server": "fake",
        "url": url,
        "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
        "replace_existing": False,
    }
    try:
        module._validate_payload("add", payload)
    except ValueError:
        results.append(False)
    else:
        results.append(True)
print(json.dumps(results))
`,
      [JSON.stringify(cases.map(({ url }) => url))],
    );

    expect(hostResults).toEqual(expected);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expected);
  });

  it("rejects every OpenShell host alias when the Hermes validator is called directly", () => {
    const result = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
errors = []
for host in ("host.openshell.internal", "host.docker.internal", "host.containers.internal"):
    payload = {
        "server": "fake",
        "url": f"https://{host}:31337/mcp",
        "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
        "replace_existing": False,
    }
    try:
        module._validate_payload("add", payload)
    except ValueError as error:
        errors.append(str(error))
print(json.dumps(errors))
if len(errors) != 3:
    raise SystemExit(9)
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      "Authenticated MCP OpenShell host aliases are unavailable with OpenShell v0.0.72",
      "Authenticated MCP OpenShell host aliases are unavailable with OpenShell v0.0.72",
      "Authenticated MCP OpenShell host aliases are unavailable with OpenShell v0.0.72",
    ]);
  });

  it("accepts a legacy host alias only for exact cleanup payloads", () => {
    const result = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
payload = {
    "server": "fake",
    "url": "https://host.openshell.internal:31337/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:GCP_PROJECT_ID"},
    "force": True,
}
module._validate_payload("remove", payload)
print(json.dumps({"ok": True}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  });

  it("shares the host credential-name boundary while preserving exact cleanup", () => {
    const blockedNames = [
      ...credentialBoundaryManifest.rawChildValueKeys,
      ...credentialBoundaryManifest.rewrittenChildValueKeys,
      ...credentialBoundaryManifest.runtimeControlKeys,
      ...credentialBoundaryManifest.runtimeControlPrefixes.map((prefix) => `${prefix}MCP_TOKEN`),
    ];
    const result = runPython(
      `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

def payload(name, action):
    return {
        "server": "fake",
        "url": "https://mcp.example.test/mcp",
        "headers": {"Authorization": f"Bearer openshell:resolve:env:{name}"},
        "replace_existing" if action == "add" else "force": False,
    }

blocked = json.loads(sys.argv[3])
add_rejected = []
cleanup_accepted = []
for name in blocked:
    try:
        module._validate_payload("add", payload(name, "add"))
    except ValueError:
        add_rejected.append(name)
    try:
        module._validate_payload("remove", payload(name, "remove"))
    except ValueError:
        pass
    else:
        cleanup_accepted.append(name)
module._validate_payload("add", payload("MY_SERVICE_MCP_TOKEN", "add"))
print(json.dumps({
    "addRejected": add_rejected,
    "cleanupAccepted": cleanup_accepted,
    "safeAccepted": True,
}))
`,
      [JSON.stringify(blockedNames)],
    );

    expect(credentialBoundaryManifest.openshellVersion).toBe("0.0.72");
    for (const name of blockedNames) {
      expect(() => validateMcpCredentialEnvName(name)).toThrow();
    }
    expect(() => validateMcpCredentialEnvName("MY_SERVICE_MCP_TOKEN")).not.toThrow();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      addRejected: blockedNames,
      cleanupAccepted: blockedNames,
      safeAccepted: true,
    });
  });

  it("accepts only HTTPS endpoint definitions with one OpenShell placeholder", () => {
    const result = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

base = {
    "server": "safe_name-1",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:SAFE_MCP_TOKEN"},
}
valid = [
    ("add", {**base, "replace_existing": False}),
    ("remove", {**base, "force": False}),
]
invalid = [
    ("restart", {**base, "force": False}),
    ("add", {**base, "replace_existing": False, "command": "touch /tmp/pwned"}),
    ("add", {**base, "replace_existing": False, "args": ["--token", "raw"]}),
    ("add", {**base, "replace_existing": False, "transport": "stdio"}),
    ("add", {**base, "replace_existing": False, "env": {"SAFE_MCP_TOKEN": "raw"}}),
    ("add", {**base, "replace_existing": False, "url": "http://mcp.example.test/mcp"}),
    ("add", {**base, "replace_existing": False, "url": "https://mcp.example.test/../mcp"}),
    ("add", {**base, "replace_existing": False, "url": "https://mcp.example.test/./mcp"}),
    ("add", {**base, "replace_existing": False, "url": "https://mcp.example.test/mcp?transport=sse"}),
    ("add", {**base, "replace_existing": False, "headers": {}}),
    ("add", {**base, "replace_existing": False, "headers": {"authorization": base["headers"]["Authorization"]}}),
    ("add", {**base, "replace_existing": False, "headers": {**base["headers"], "X-Api-Key": "raw"}}),
    ("add", {**base, "replace_existing": False, "headers": {"Authorization": "Bearer raw-secret"}}),
    ("add", {**base, "replace_existing": False, "headers": {"Authorization": "openshell:resolve:env:SAFE_MCP_TOKEN"}}),
    ("add", {**base, "replace_existing": False, "headers": {"Authorization": "Bearer openshell:resolve:env:1INVALID"}}),
    ("add", {**base, "replace_existing": False, "headers": {"Authorization": "Bearer openshell:resolve:env:SAFE_MCP_TOKEN extra"}}),
]

accepted = []
for action, payload in valid + invalid:
    try:
        module._validate_payload(action, payload)
    except (TypeError, ValueError):
        accepted.append(False)
    else:
        accepted.append(True)
print(json.dumps(accepted))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([true, true, ...Array(16).fill(false)]);
  });

  it("rejects command, YAML-tag, and terminal-control injection without executing it", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-injection-"));
    const sentinel = path.join(temp, "executed");
    const invalidPayload = {
      server: `safe;touch ${sentinel}\n\u001b[31mFORGED`,
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer openshell:resolve:env:SAFE_MCP_TOKEN" },
      replace_existing: false,
    };
    const commandResult = spawnSync(
      "python3",
      [TRANSACTION, "add", "--payload", JSON.stringify(invalidPayload)],
      { encoding: "utf8" },
    );

    try {
      expect(commandResult.status).toBe(2);
      expect(commandResult.stderr).not.toContain("\u001b");
      expect(commandResult.stderr.trim().split("\n")).toHaveLength(1);
      expect(fs.existsSync(sentinel)).toBe(false);

      const hermesDir = path.join(temp, ".hermes");
      fs.mkdirSync(hermesDir);
      fs.writeFileSync(
        path.join(hermesDir, "config.yaml"),
        `model: !!python/object/apply:os.system ["touch ${sentinel}"]\n`,
        { mode: 0o600 },
      );
      fs.writeFileSync(path.join(hermesDir, ".env"), "HERMES_TEST=1\n", {
        mode: 0o600,
      });
      fs.writeFileSync(path.join(hermesDir, ".config-hash"), "untrusted\n", {
        mode: 0o600,
      });
      const yamlResult = runPython(
        `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.GUARD_PATH = sys.argv[2]
module.HERMES_DIR = sys.argv[3]
module.CONFIG_PATH = os.path.join(module.HERMES_DIR, "config.yaml")
module.os.geteuid = lambda: 1000
module._assert_non_root_lifecycle_identity = lambda: None
payload = {
    "server": "safe",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:SAFE_MCP_TOKEN"},
    "replace_existing": False,
}
sys.argv = [sys.argv[1], "add", "--payload", json.dumps(payload)]
print(json.dumps({"exit_code": module.main()}))
`,
        [hermesDir],
      );

      expect(yamlResult.status, `${yamlResult.stdout}\n${yamlResult.stderr}`).toBe(0);
      expect(JSON.parse(yamlResult.stdout)).toEqual({ exit_code: 2 });
      expect(yamlResult.stderr.trim()).toBe("Invalid Hermes config: YAML parsing failed");
      expect(yamlResult.stderr).not.toContain("python/object");
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("preserves falsey non-map YAML roots across mutation and reload transactions", () => {
    const result = runPython(`
import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
payload = {
    "server": "safe",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:SAFE_MCP_TOKEN"},
    "replace_existing": False,
}
snapshot = types.SimpleNamespace(mode=0o600)
module.os.geteuid = lambda: 1000
module._assert_mutable_snapshot = lambda received: None
module._managed_hash_paths = lambda privileged: []
module._refresh_and_verify_hashes = lambda guard, privileged, transition="preserve": None
module.reload_gateway = lambda: True

def run(method_name, original):
    state = {"text": original, "writes": []}
    def read_text(path):
        return state["text"], snapshot
    def write_existing(path, text, received_snapshot, mode):
        state["writes"].append(text)
        state["text"] = text
    module._load_guard = lambda: types.SimpleNamespace(
        _read_text=read_text,
        _write_existing=write_existing,
        inspect_mcp_integrity=lambda *_args: "current",
    )
    error = ""
    try:
        getattr(module, method_name)("add", payload)
    except (TypeError, ValueError) as caught:
        error = str(caught)
    return {
        "error": error,
        "preserved": state["text"] == original,
        "writes": len(state["writes"]),
    }

falsey_roots = ["[]\\n", "false\\n", "0\\n", '""\\n']
results = {
    method: [run(method, original) for original in falsey_roots]
    for method in ("apply_transaction", "apply_transaction_and_reload")
}
null_result = run("apply_transaction", "null\\n")
print(json.dumps({"results": results, "null_result": null_result}))
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      results: Record<string, Array<{ error: string; preserved: boolean; writes: number }>>;
      null_result: { error: string; preserved: boolean; writes: number };
    };
    for (const outcomes of Object.values(payload.results)) {
      expect(outcomes).toHaveLength(4);
      for (const outcome of outcomes) {
        expect(outcome.error).toContain("expected a YAML object");
        expect(outcome.preserved).toBe(true);
        expect(outcome.writes).toBe(0);
      }
    }
    expect(payload.null_result.error).toBe("");
    expect(payload.null_result.preserved).toBe(false);
    expect(payload.null_result.writes).toBe(1);
  });

  it("emits bounded one-line errors with payload and runtime secrets redacted", () => {
    const result = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
payload = {
    "server": "safe",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:SAFE_MCP_TOKEN"},
    "replace_existing": False,
}
def fail(action, received):
    raise RuntimeError(
        "reload failed Authorization: " + received["headers"]["Authorization"]
        + " Bearer runtime-secret-123 token=second-secret-456 "
        + "https://user:password@example.test/mcp?token=query-secret-789 "
        + "\\x1b[31m\\nFORGED\\u202e" + ("A" * 1000)
    )
module.execute = fail
sys.argv = [sys.argv[1], "add", "--payload", json.dumps(payload)]
print(json.dumps({"exit_code": module.main()}))
`);

    expect(result.status, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ exit_code: 2 });
    expect(result.stderr).toContain("<REDACTED>");
    for (const secret of [
      "SAFE_MCP_TOKEN",
      "runtime-secret-123",
      "second-secret-456",
      "password",
      "query-secret-789",
    ]) {
      expect(result.stderr).not.toContain(secret);
    }
    expect(result.stderr).not.toContain("\u001b");
    expect(result.stderr).not.toContain("\u202e");
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr.trim().length).toBeLessThanOrEqual(512);

    const representations = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
messages = [
    "failed {'api_key': 'raw-secret-1'}",
    "failed {'token': 'raw-secret-2'}",
    'Authorization: Bearer "runtime secret with spaces", comma-secret',
    "Bearer 'quoted bearer secret', suffix-secret",
]
print(json.dumps([
    module._sanitize_error_message(RuntimeError(message)) for message in messages
]))
`);
    expect(representations.status, representations.stderr).toBe(0);
    const sanitized = JSON.parse(representations.stdout) as string[];
    expect(sanitized).toHaveLength(4);
    for (const message of sanitized) expect(message).toContain("<REDACTED>");
    for (const secret of [
      "raw-secret-1",
      "raw-secret-2",
      "runtime secret with spaces",
      "comma-secret",
      "quoted bearer secret",
      "suffix-secret",
    ]) {
      expect(sanitized.join("\n")).not.toContain(secret);
    }
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

  it("blocks symlink, hardlink, permission, inode-race, and atomic-write guard bypasses", () => {
    const result = runPython(`
import hashlib, importlib.util, json, os, shutil, sys, tempfile

TRANSACTION_PATH = sys.argv[1]
GUARD_PATH = sys.argv[2]
CONFIG_TEXT = "model: test\\n"
ENV_TEXT = "HERMES_TEST=1\\n"
PAYLOAD = {
    "server": "safe",
    "url": "https://mcp.example.test/mcp",
    "headers": {"Authorization": "Bearer openshell:resolve:env:SAFE_MCP_TOKEN"},
    "replace_existing": False,
}

def load_transaction(name):
    spec = importlib.util.spec_from_file_location(name, TRANSACTION_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

def fixture(name):
    root = tempfile.mkdtemp(prefix="nemoclaw-hermes-mcp-" + name + "-")
    hermes_dir = os.path.join(root, ".hermes")
    os.mkdir(hermes_dir, 0o700)
    config_path = os.path.join(hermes_dir, "config.yaml")
    env_path = os.path.join(hermes_dir, ".env")
    hash_path = os.path.join(hermes_dir, ".config-hash")
    for path, text in ((config_path, CONFIG_TEXT), (env_path, ENV_TEXT)):
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.chmod(path, 0o600)
    empty_mcp = hashlib.sha256(b"{}").hexdigest()
    hash_text = (
        hashlib.sha256(CONFIG_TEXT.encode()).hexdigest() + "  " + config_path + "\\n"
        + hashlib.sha256(ENV_TEXT.encode()).hexdigest() + "  " + env_path + "\\n"
        + "# nemoclaw-hermes-mcp-state-v1 intended=" + empty_mcp
        + " applied=" + empty_mcp + "\\n"
    )
    with open(hash_path, "w", encoding="utf-8") as handle:
        handle.write(hash_text)
    os.chmod(hash_path, 0o600)
    return root, hermes_dir, config_path, hash_path, hash_text

def configure(module, hermes_dir):
    module.GUARD_PATH = GUARD_PATH
    module.HERMES_DIR = hermes_dir
    module.CONFIG_PATH = os.path.join(hermes_dir, "config.yaml")
    module.os.geteuid = lambda: 1000
    module._assert_mutable_snapshot = lambda snapshot: None

def blocked(operation):
    try:
        operation()
    except Exception as error:
        return True, type(error).__name__
    return False, "none"

results = {}
roots = []
try:
    root, hermes_dir, config_path, _, _ = fixture("config-symlink")
    roots.append(root)
    target = os.path.join(root, "config-target")
    os.replace(config_path, target)
    os.symlink(target, config_path)
    module = load_transaction("mcp_tx_config_symlink")
    configure(module, hermes_dir)
    was_blocked, error = blocked(lambda: module.apply_transaction("add", PAYLOAD))
    results["config_symlink"] = {
        "blocked": was_blocked,
        "error": error,
        "preserved": open(target, encoding="utf-8").read() == CONFIG_TEXT,
    }

    root, hermes_dir, config_path, _, _ = fixture("config-hardlink")
    roots.append(root)
    alias = os.path.join(root, "config-alias")
    os.link(config_path, alias)
    module = load_transaction("mcp_tx_config_hardlink")
    configure(module, hermes_dir)
    was_blocked, error = blocked(lambda: module.apply_transaction("add", PAYLOAD))
    results["config_hardlink"] = {
        "blocked": was_blocked,
        "error": error,
        "preserved": open(alias, encoding="utf-8").read() == CONFIG_TEXT,
    }

    root, hermes_dir, config_path, _, _ = fixture("config-mode")
    roots.append(root)
    os.chmod(config_path, 0o620)
    module = load_transaction("mcp_tx_config_mode")
    configure(module, hermes_dir)
    was_blocked, error = blocked(lambda: module.apply_transaction("add", PAYLOAD))
    results["config_group_writable"] = {
        "blocked": was_blocked,
        "error": error,
        "preserved": open(config_path, encoding="utf-8").read() == CONFIG_TEXT,
    }

    for kind in ("symlink", "hardlink"):
        root, hermes_dir, config_path, hash_path, hash_text = fixture("hash-" + kind)
        roots.append(root)
        alias = os.path.join(root, "hash-alias")
        if kind == "symlink":
            os.replace(hash_path, alias)
            os.symlink(alias, hash_path)
        else:
            os.link(hash_path, alias)
        module = load_transaction("mcp_tx_hash_" + kind)
        configure(module, hermes_dir)
        was_blocked, error = blocked(lambda: module.apply_transaction("add", PAYLOAD))
        results["hash_" + kind] = {
            "blocked": was_blocked,
            "error": error,
            "config_preserved": open(config_path, encoding="utf-8").read() == CONFIG_TEXT,
            "hash_preserved": open(alias, encoding="utf-8").read() == hash_text,
        }

    root, hermes_dir, config_path, _, _ = fixture("config-race")
    roots.append(root)
    module = load_transaction("mcp_tx_config_race")
    configure(module, hermes_dir)
    guard = module._load_guard()
    module._load_guard = lambda: guard
    original_write = guard._write_existing
    raced = {"done": False}
    def race_before_write(path, text, snapshot, mode=None):
        if path == config_path and not raced["done"]:
            raced["done"] = True
            replacement = os.path.join(hermes_dir, "attacker-config")
            with open(replacement, "w", encoding="utf-8") as handle:
                handle.write("attacker: preserved\\n")
            os.chmod(replacement, 0o600)
            os.replace(replacement, config_path)
        return original_write(path, text, snapshot, mode=mode)
    guard._write_existing = race_before_write
    was_blocked, error = blocked(lambda: module.apply_transaction("add", PAYLOAD))
    results["config_inode_race"] = {
        "blocked": was_blocked,
        "error": error,
        "attacker_preserved": open(config_path, encoding="utf-8").read() == "attacker: preserved\\n",
    }

    root, hermes_dir, config_path, _, _ = fixture("atomic-failure")
    roots.append(root)
    module = load_transaction("mcp_tx_atomic_failure")
    configure(module, hermes_dir)
    guard = module._load_guard()
    module._load_guard = lambda: guard
    original_replace = guard.os.replace
    def fail_config_replace(source, destination, *args, **kwargs):
        if destination == "config.yaml":
            raise OSError("simulated atomic replace failure")
        return original_replace(source, destination, *args, **kwargs)
    guard.os.replace = fail_config_replace
    was_blocked, error = blocked(lambda: module.apply_transaction("add", PAYLOAD))
    guard.os.replace = original_replace
    results["atomic_replace_failure"] = {
        "blocked": was_blocked,
        "error": error,
        "config_preserved": open(config_path, encoding="utf-8").read() == CONFIG_TEXT,
        "temp_cleaned": not any(".nemoclaw." in name for name in os.listdir(hermes_dir)),
    }

    root, hermes_dir, config_path, hash_path, hash_text = fixture("hash-race")
    roots.append(root)
    module = load_transaction("mcp_tx_hash_race")
    configure(module, hermes_dir)
    guard = module._load_guard()
    original_hash_text = guard._hash_text
    raced = {"done": False}
    def race_after_hash(*args):
        value = original_hash_text(*args)
        if not raced["done"]:
            raced["done"] = True
            replacement = os.path.join(hermes_dir, "raced-config")
            with open(replacement, "w", encoding="utf-8") as handle:
                handle.write("attacker: after-hash\\n")
            os.chmod(replacement, 0o600)
            os.replace(replacement, config_path)
        return value
    guard._hash_text = race_after_hash
    was_blocked, error = blocked(lambda: module._refresh_and_verify_hashes(guard, False))
    results["hash_inode_race"] = {
        "blocked": was_blocked,
        "error": error,
        "hash_preserved": open(hash_path, encoding="utf-8").read() == hash_text,
    }
finally:
    for root in roots:
        shutil.rmtree(root, ignore_errors=True)

print(json.dumps(results, sort_keys=True))
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const scenarios = JSON.parse(result.stdout) as Record<string, Record<string, unknown>>;
    expect(Object.keys(scenarios).sort()).toEqual([
      "atomic_replace_failure",
      "config_group_writable",
      "config_hardlink",
      "config_inode_race",
      "config_symlink",
      "hash_hardlink",
      "hash_inode_race",
      "hash_symlink",
    ]);
    const expectedErrors: Record<string, string> = {
      atomic_replace_failure: "OSError",
      config_group_writable: "UnsafePathError",
      config_hardlink: "UnsafePathError",
      config_inode_race: "UnsafePathError",
      config_symlink: "OSError",
      hash_hardlink: "UnsafePathError",
      hash_inode_race: "UnsafePathError",
      hash_symlink: "OSError",
    };
    for (const [name, scenario] of Object.entries(scenarios)) {
      expect(scenario.blocked, name).toBe(true);
      expect(scenario.error, `${name}.error`).toBe(expectedErrors[name]);
      for (const [property, value] of Object.entries(scenario).filter(
        ([property]) => property.endsWith("preserved") || property === "temp_cleaned",
      )) {
        expect(value, `${name}.${property}`).toBe(true);
      }
    }
  });

  it("keeps config ownership and gateway lifecycle identities separated", () => {
    const result = runPython(`
import importlib.util, json, stat, sys, types
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

errors = []
module.os.geteuid = lambda: 1000
for snapshot in (
    types.SimpleNamespace(mode=0o600, uid=2000, gid=1000),
    types.SimpleNamespace(mode=0o400, uid=1000, gid=1000),
):
    try:
        module._assert_mutable_snapshot(snapshot)
    except RuntimeError as error:
        errors.append(str(error))

module.os.geteuid = lambda: 0
module.pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=1000)
module.grp.getgrnam = lambda name: types.SimpleNamespace(gr_gid=1000)
for snapshot in (
    types.SimpleNamespace(mode=0o600, uid=2000, gid=1000),
    types.SimpleNamespace(mode=0o600, uid=1000, gid=2000),
):
    try:
        module._assert_mutable_snapshot(snapshot)
    except RuntimeError as error:
        errors.append(str(error))

module.os.geteuid = lambda: 1000
unsafe_markers = (
    types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777, st_uid=0),
    types.SimpleNamespace(st_mode=stat.S_IFREG | 0o444, st_uid=1000),
)
for marker in unsafe_markers:
    module.os.lstat = lambda path, marker=marker: marker
    try:
        module._assert_non_root_lifecycle_identity()
    except PermissionError as error:
        errors.append(str(error))

print(json.dumps(errors))
`);

    expect(result.status, result.stderr).toBe(0);
    const errors = JSON.parse(result.stdout) as string[];
    expect(errors).toHaveLength(6);
    expect(errors.slice(0, 4).every((error) => error.includes("not owned"))).toBe(true);
    expect(errors.slice(4).every((error) => error.includes("marker is unsafe"))).toBe(true);
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
module._gateway_has_managed_parent = lambda pid: True
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

  it("recognizes the wrapped Hermes gateway from its bounded PID record", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-gateway-pid-"));
    const pidPath = path.join(temp, "gateway.pid");
    fs.writeFileSync(pidPath, JSON.stringify({ pid: 4242, start_time: 99 }), { mode: 0o600 });

    try {
      const result = runPython(
        `
import importlib.util, json, os, sys, types
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

expected_uid = os.geteuid()
gateway = types.ModuleType("gateway")
status = types.ModuleType("gateway.status")
status.get_running_pid = lambda cleanup_stale=False: None
status.get_process_start_time = lambda pid: 99
runtime = {"lock_active": True}
status.is_gateway_runtime_lock_active = lambda: runtime["lock_active"]
sys.modules["gateway"] = gateway
sys.modules["gateway.status"] = status

module.GATEWAY_PID_PATH = sys.argv[3]
module.os.stat = lambda path: types.SimpleNamespace(st_uid=expected_uid)
module._is_trusted_gateway_process = lambda pid: pid == 4242
module._gateway_has_managed_parent = lambda pid: True

recognized = module._gateway_identity()
runtime["lock_active"] = False
unlocked = module._gateway_identity()
runtime["lock_active"] = True
status.get_process_start_time = lambda pid: 100
reused = module._gateway_identity()
start_times = iter((99, 100))
status.get_process_start_time = lambda pid: next(start_times)
unstable = module._gateway_identity()
status.get_process_start_time = lambda pid: 99
module._is_trusted_gateway_process = lambda pid: False
try:
    module._gateway_identity()
except PermissionError as error:
    untrusted = str(error)
else:
    raise SystemExit(9)
print(json.dumps({
    "recognized": recognized,
    "reused": reused,
    "unstable": unstable,
    "unlocked": unlocked,
    "untrusted": untrusted,
}))
`,
        [pidPath],
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        recognized: [4242, 99],
        reused: null,
        unstable: null,
        unlocked: null,
        untrusted: "Hermes gateway PID does not identify the trusted launcher",
      });
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("rejects a FIFO gateway PID record without blocking", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-gateway-fifo-"));
    const fifoPath = path.join(temp, "gateway.pid");

    try {
      const result = runPython(
        `
import importlib.util, os, signal, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.GATEWAY_PID_PATH = sys.argv[3]
os.mkfifo(module.GATEWAY_PID_PATH, 0o600)
signal.alarm(2)
try:
    module._gateway_pid_record_candidate(os.geteuid())
except PermissionError as error:
    print(str(error))
else:
    raise SystemExit(9)
finally:
    signal.alarm(0)
`,
        [fifoPath],
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Hermes gateway PID record is unsafe");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("requires the public relay and stable identity before acknowledging reload health", () => {
    const result = runPython(`
import importlib.util, json, signal, sys, types
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

statuses = {
    module.GATEWAY_INTERNAL_PORT: 200,
    module.GATEWAY_PUBLIC_PORT: 401,
}
ports = []
class Connection:
    def __init__(self, host, port, timeout):
        if host != "127.0.0.1" or timeout != 2:
            raise AssertionError("unexpected Hermes health endpoint")
        self.port = port
        ports.append(port)
    def request(self, method, path):
        if method != "GET" or path != "/health":
            raise AssertionError("unexpected Hermes health request")
    def getresponse(self):
        status = statuses[self.port]
        if isinstance(status, list):
            status = status.pop(0)
        return types.SimpleNamespace(status=status, read=lambda: b"")
    def close(self):
        pass

module.http.client.HTTPConnection = Connection
ready = module._gateway_healthy()
statuses[module.GATEWAY_PUBLIC_PORT] = 503
public_down = module._gateway_healthy()
statuses[module.GATEWAY_INTERNAL_PORT] = 503
statuses[module.GATEWAY_PUBLIC_PORT] = 401
internal_down = module._gateway_healthy()
health_ports = list(ports)

ports.clear()
statuses[module.GATEWAY_INTERNAL_PORT] = 200
statuses[module.GATEWAY_PUBLIC_PORT] = [503, 401, 401]
identities = iter(((1, 10), (2, 20), (2, 20), (3, 30), (3, 30), (3, 30)))
module._gateway_identity = lambda: next(identities)
module._gateway_has_managed_parent = lambda pid: True
signals = []
module.os.kill = lambda pid, sent_signal: signals.append((pid, signal.Signals(sent_signal).name))
module.time.monotonic = lambda: 0
sleeps = []
module.time.sleep = sleeps.append
reloaded = module.reload_gateway()
print(json.dumps({
    "ready": ready,
    "public_down": public_down,
    "internal_down": internal_down,
    "health_ports": health_ports,
    "reloaded": reloaded,
    "reload_ports": ports,
    "signals": signals,
    "sleeps": sleeps,
}))
`);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ready: true,
      public_down: false,
      internal_down: false,
      health_ports: [18642, 8642, 18642, 8642, 18642],
      reloaded: true,
      reload_ports: [18642, 8642, 18642, 8642, 18642, 8642],
      signals: [[1, "SIGUSR1"]],
      sleeps: [1, 1],
    });
  });

  it("trusts the current real Hermes launcher and retained compatibility paths", () => {
    const result = runPython(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
arguments = {
    1: [b"/usr/local/bin/hermes.real", b"gateway", b"run"],
    2: [b"/opt/hermes/.venv/bin/python", b"/usr/local/bin/hermes.real", b"gateway", b"run"],
    3: [b"/usr/local/lib/nemoclaw/hermes", b"gateway", b"run"],
    4: [b"/opt/hermes/.venv/bin/hermes", b"gateway", b"run"],
    5: [b"/usr/local/bin/hermes", b"gateway", b"run"],
}
module._process_arguments = lambda pid: arguments[pid]
print(json.dumps({str(pid): module._is_trusted_gateway_process(pid) for pid in arguments}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      "1": true,
      "2": true,
      "3": true,
      "4": true,
      "5": false,
    });
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
config_state = {"text": "model: test\\n"}
guard = types.SimpleNamespace(
    _read_text=lambda path: (config_state["text"], snapshot),
)
module._load_guard = lambda: guard
def apply_transaction(action, payload):
    observed["helper_uid"] = module.os.geteuid()
    observed["action"] = action
    parsed = module.yaml.safe_load(config_state["text"])
    updated, _changed = module._mutate(parsed, action, payload)
    config_state["text"] = module.yaml.safe_dump(updated, sort_keys=False)
    return True
module.apply_transaction = apply_transaction
module._refresh_and_verify_hashes = lambda guard, privileged, transition="preserve": None

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
def gateway_health_phase(deadline=None):
    observed["health_uid"] = module.os.geteuid()
    return True, "waiting-for-stable-replacement-identity"
module._gateway_health_phase = gateway_health_phase

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
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      changed: true,
      ok: true,
      reloaded: true,
    });
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
      trusted_pids: [4242, 4242, 4242, 4242, 4242],
    });
  });

  it("verifies strict and compatibility MCP hash state on an unchanged retry", () => {
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
guard = module._load_guard()
hash_text, _config_snapshot, _env_snapshot = guard._hash_text(
    module.CONFIG_PATH, os.path.join(module.HERMES_DIR, ".env")
)
guard._write_hash(sys.argv[4], hash_text)
guard._write_hash(os.path.join(module.HERMES_DIR, ".config-hash"), hash_text)
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
    expect(JSON.parse(result.stdout)).toEqual({
      "1": true,
      "2": false,
      "3": false,
    });
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
    expect(JSON.parse(result.stdout)).toEqual({
      changed: true,
      ok: true,
      reloaded: true,
    });
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

  it("restores config and hashes after both desired-config reload signals fail", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-mcp-rollback-"));
    const hermesDir = path.join(temp, ".hermes");
    const configPath = path.join(hermesDir, "config.yaml");
    const envPath = path.join(hermesDir, ".env");
    const compatHash = path.join(hermesDir, ".config-hash");
    const strictHash = path.join(temp, "strict-hash");
    const config = "model: test\n";
    const env = "HERMES_TEST=1\n";
    const emptyMcp = crypto.createHash("sha256").update("{}").digest("hex");
    const originalHash = `${crypto.createHash("sha256").update(config).digest("hex")}  ${configPath}\n${crypto.createHash("sha256").update(env).digest("hex")}  ${envPath}\n# nemoclaw-hermes-mcp-state-v1 intended=${emptyMcp} applied=${emptyMcp}\n`;
    fs.mkdirSync(hermesDir);
    fs.writeFileSync(configPath, config, { mode: 0o600 });
    fs.writeFileSync(envPath, env, { mode: 0o600 });
    fs.writeFileSync(compatHash, originalHash, { mode: 0o600 });
    fs.writeFileSync(strictHash, originalHash, { mode: 0o600 });

    try {
      const result = runPython(
        `
import importlib.util, json, os, signal, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.GUARD_PATH = sys.argv[2]
module.HERMES_DIR = sys.argv[3]
module.CONFIG_PATH = os.path.join(module.HERMES_DIR, "config.yaml")
module.STRICT_HASH_PATH = sys.argv[4]
module.os.geteuid = lambda: 0
module._assert_mutable_snapshot = lambda snapshot: None
module.RELOAD_TIMEOUT_SECONDS = 4
clock = {"now": 0}
gateway = {"identity": (4242, 99)}
signals = []
module._gateway_identity = lambda: gateway["identity"]
module._gateway_has_managed_parent = lambda pid: True
module._gateway_health_phase = lambda deadline=None: (
    True, "waiting-for-stable-replacement-identity"
)
module.time.monotonic = lambda: clock["now"]
module.time.sleep = lambda seconds: clock.__setitem__("now", clock["now"] + seconds)
def signal_gateway(pid, sent_signal):
    signals.append((pid, signal.Signals(sent_signal).name))
    if len(signals) == 3:
        gateway["identity"] = (4243, 100)
module.os.kill = signal_gateway
try:
    module.apply_transaction_and_reload("add", {
        "server": "fake",
        "url": "https://mcp.example.test/mcp",
        "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
        "replace_existing": False,
    })
except RuntimeError as error:
    print(json.dumps({"error": str(error), "signals": signals}))
else:
    raise SystemExit(9)
`,
        [hermesDir, strictHash],
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        signals: [
          [4242, "SIGUSR1"],
          [4242, "SIGUSR1"],
          [4242, "SIGUSR1"],
        ],
      });
      expect(result.stdout).toContain("re-kick sent: yes");
      expect(fs.readFileSync(configPath, "utf8")).toBe(config);
      expect(fs.readFileSync(compatHash, "utf8")).toBe(originalHash);
      expect(fs.readFileSync(strictHash, "utf8")).toBe(originalHash);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
