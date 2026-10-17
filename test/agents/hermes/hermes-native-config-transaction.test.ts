// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HERMES_NATIVE_CONFIG_WRITE } from "../../../src/lib/sandbox/hermes-native-config";

const original = "model:\n  default: old-model\nmcp_servers: {}\ncustom: retained\n";
const updated = original.replace("old-model", "selected-model");

function transaction(scenario: string, mode = "reload", source = original, replacement = updated) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-native-config-"));
  try {
    const home = path.join(root, "home");
    fs.mkdirSync(home, { mode: 0o700 });
    fs.writeFileSync(path.join(home, "config.yaml"), source, { mode: 0o600 });
    fs.writeFileSync(path.join(home, ".env"), "SAFE_SETTING=true\n", { mode: 0o600 });
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const hashes = `${hash(source)}  ${home}/config.yaml\n${hash("SAFE_SETTING=true\n")}  ${home}/.env\n`;
    fs.writeFileSync(path.join(home, ".config-hash"), hashes, { mode: 0o600 });
    const lockDir = path.join(root, "lock");
    fs.mkdirSync(lockDir, { mode: 0o755 });
    fs.writeFileSync(path.join(lockDir, "transaction"), "", { mode: 0o444 });
    fs.chmodSync(lockDir, 0o755);
    fs.chmodSync(path.join(lockDir, "transaction"), 0o444);
    const shim = path.join(root, "helper.py");
    // Exercise the real filesystem guards and transaction lock. Runtime identity
    // and the installed Hermes schema are exercised by the Brev reproduction.
    fs.writeFileSync(
      shim,
      `
import importlib.util, os, sys, types
from pathlib import Path

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

guard = load("native_guard", ${JSON.stringify(path.resolve("agents/hermes/runtime-config-guard.py"))})
helper = load("native_helper", ${JSON.stringify(path.resolve("agents/hermes/mcp-config-transaction.py"))})
helper.HERMES_DIR = ${JSON.stringify(home)}
helper.CONFIG_PATH = helper.HERMES_DIR + "/config.yaml"
helper.MCP_TRANSACTION_LOCK_PATH = ${JSON.stringify(path.join(lockDir, "transaction"))}
helper.MCP_TRANSACTION_LOCK_EXPECTED_UID = os.geteuid()
helper.MCP_TRANSACTION_LOCK_EXPECTED_GID = os.stat(helper.MCP_TRANSACTION_LOCK_PATH).st_gid
helper._load_guard = lambda: guard
guard._sandbox_identity = lambda: (os.geteuid(), os.getegid())
helper._assert_non_root_lifecycle_identity = lambda: None
helper._configure_gateway_public_port = lambda: None
def reload_gateway():
    with open(helper.HERMES_DIR + "/reloads", "a") as output: output.write("reload\\n")
    return True
helper.reload_gateway = reload_gateway
schema = types.ModuleType("gateway.config")
schema.GatewayConfig = type("GatewayConfig", (), {"from_dict": staticmethod(lambda data: data)})
sys.modules["gateway.config"] = schema
scenario = ${JSON.stringify(scenario)}
if scenario == "lifecycle":
    def reject(): raise PermissionError("wrong lifecycle")
    helper._assert_non_root_lifecycle_identity = reject
if scenario == "reload-failure":
    helper.reload_gateway = lambda: False
if scenario == "stale-archive-hash":
    Path(helper.HERMES_DIR + "/.config-hash").write_text("0" * 64 + "  " + helper.CONFIG_PATH + "\\n" + "0" * 64 + "  " + helper.HERMES_DIR + "/.env\\n")
if scenario == "unsafe-mode":
    os.chmod(helper.CONFIG_PATH, 0o644)
if scenario == "raw-secret":
    Path(helper.HERMES_DIR + "/.env").write_text("NVIDIA_API_KEY=raw-fixture-secret\\n")
if scenario == "hash-drift":
    Path(helper.HERMES_DIR + "/.env").write_text("changed=true\\n")
if scenario == "symlink":
    current = Path(helper.CONFIG_PATH)
    current.rename(current.with_suffix(".original"))
    current.symlink_to(current.with_suffix(".original"))
if scenario == "hardlink":
    os.link(helper.CONFIG_PATH, helper.CONFIG_PATH + ".link")
if scenario == "hash-failure":
    def fail_hash(*args): raise RuntimeError("injected hash failure")
    helper._refresh_and_verify_hashes = fail_hash
if scenario in ("late-environment-race", "final-environment-race", "final-config-race"):
    refresh = helper._refresh_and_verify_hashes
    refresh_count = 0
    def raced_refresh(*args):
        global refresh_count
        refresh_count += 1
        trigger = 1 if scenario == "late-environment-race" else 2
        if refresh_count == trigger:
            if scenario == "final-config-race":
                Path(helper.CONFIG_PATH).write_text("model: concurrent-writer\\n")
            else:
                Path(helper.HERMES_DIR + "/.env").write_text("NVIDIA_API_KEY=synthetic-race-value\\n")
        return refresh(*args)
    helper._refresh_and_verify_hashes = raced_refresh
if scenario == "environment-race":
    write = guard._write_existing
    def raced_environment(filename, text, snapshot, mode=None):
        write(filename, text, snapshot, mode)
        if filename == helper.CONFIG_PATH:
            Path(helper.HERMES_DIR + "/.env").write_text("CHANGED=true\\n")
    guard._write_existing = raced_environment
if scenario == "concurrent-write":
    write = guard._write_existing
    def raced_write(filename, text, snapshot, mode=None):
        write(filename, text, snapshot, mode)
        if filename == helper.CONFIG_PATH:
            Path(filename).write_text("model: concurrent-writer\\n")
    guard._write_existing = raced_write
for name, value in vars(helper).items():
    if not name.startswith("__"): globals()[name] = value
`,
    );
    const candidate =
      scenario === "mcp-change"
        ? replacement.replace(
            "mcp_servers: {}",
            "mcp_servers: {other: {url: 'https://example.test/mcp'}}",
          )
        : replacement;
    const script = HERMES_NATIVE_CONFIG_WRITE.replace(
      "except Exception:\n    # Config parser",
      "except Exception:\n    import traceback; traceback.print_exc()\n    # Config parser",
    ).replace("/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py", shim);
    const result = spawnSync(
      "python3",
      ["-c", script, scenario === "stale" ? "0".repeat(64) : hash(source), mode],
      {
        input: candidate,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    return {
      result,
      config: fs.readFileSync(path.join(home, "config.yaml"), "utf8"),
      hash: fs.readFileSync(path.join(home, ".config-hash"), "utf8"),
      originalHash: hashes,
      updatedHash: hash(replacement),
      reloads: fs.existsSync(path.join(home, "reloads"))
        ? fs.readFileSync(path.join(home, "reloads"), "utf8")
        : "",
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("native Hermes config transaction", () => {
  it("updates the selected model and compatibility hash while preserving unrelated configuration", () => {
    const actual = transaction("success");
    expect(actual.result.status, actual.result.stderr).toBe(0);
    expect(actual.config).toBe(updated);
    expect(actual.hash).toContain(actual.updatedHash);
  });

  it.each([
    "stale",
    "lifecycle",
    "symlink",
    "hardlink",
    "mcp-change",
    "hash-failure",
    "reload-failure",
  ])("preserves configuration and its hash after %s rejection", (scenario) => {
    const actual = transaction(scenario);
    expect(actual.result.status).not.toBe(0);
    expect(actual.config).toBe(original);
    expect(actual.hash).toBe(actual.originalHash);
  });

  it("refuses mismatched environment integrity before writing configuration", () => {
    const actual = transaction("hash-drift");
    expect(actual.result.status).not.toBe(0);
    expect(actual.config).toBe(original);
  });

  it("retains a concurrent writer's configuration instead of rolling it back", () => {
    const actual = transaction("concurrent-write");
    expect(actual.result.status).not.toBe(0);
    expect(actual.config).toBe("model: concurrent-writer\n");
  });
});

const restoredLocal = `model:
  default: local-model
  provider: custom
  base_url: http://host.openshell.internal:8000/v1
  api_key: openshell:resolve:env:v1_NEMOCLAW_LOCAL_INFERENCE_TOKEN
_nemoclaw_upstream:
  provider: vllm-local
  provider_key: vllm-local
  model: local-model
providers:
  vllm-local:
    default_model: local-model
    api: http://host.openshell.internal:8000/v1
    api_key: openshell:resolve:env:v1_NEMOCLAW_LOCAL_INFERENCE_TOKEN
custom_providers:
  - name: vllm-local
    base_url: http://host.openshell.internal:8000/v1
    api_key: openshell:resolve:env:v1_NEMOCLAW_LOCAL_INFERENCE_TOKEN
mcp_servers: {}
custom: retained
`;
const reboundLocal = restoredLocal.replaceAll(":v1_", ":v2_");

describe("native Hermes deferred configuration", () => {
  it("commits initial configuration without reloading before the restart owner", () => {
    const actual = transaction("success", "deferred");
    expect(actual.result.status, actual.result.stderr).toBe(0);
    expect(actual.config).toBe(updated);
    expect(actual.reloads).toBe("");
  });

  it.each(["deferred", "restore-native-local"])(
    "rejects environment changes during %s writes",
    (mode) => {
      const actual = transaction("environment-race", mode, restoredLocal, reboundLocal);
      expect(actual.result.status).not.toBe(0);
      expect(actual.config).toBe(restoredLocal);
      expect(actual.hash).toBe(actual.originalHash);
      expect(actual.reloads).toBe("");
    },
  );

  it.each(["late-environment-race", "final-environment-race"])(
    "refuses %s during restored hash refresh without accepting changed credentials",
    (scenario) => {
      const actual = transaction(scenario, "restore-native-local", restoredLocal, reboundLocal);
      expect(actual.result.status).not.toBe(0);
      expect(actual.config).toBe(restoredLocal);
      expect(actual.hash).toBe(actual.originalHash);
      expect(actual.reloads).toBe("");
    },
  );

  it("preserves a concurrent configuration writer during final hash refresh", () => {
    const actual = transaction(
      "final-config-race",
      "restore-native-local",
      restoredLocal,
      reboundLocal,
    );
    expect(actual.result.status).not.toBe(0);
    expect(actual.config).toBe("model: concurrent-writer\n");
    expect(actual.reloads).toBe("");
  });

  it.each(["success", "stale-archive-hash"])(
    "rebinds restored credential slots with %s",
    (scenario) => {
      const actual = transaction(scenario, "restore-native-local", restoredLocal, reboundLocal);
      expect(actual.result.status, actual.result.stderr).toBe(0);
      expect(actual.config).toBe(reboundLocal);
      expect(actual.hash).toContain(actual.updatedHash);
      expect(actual.reloads).toBe("");
    },
  );

  it.each([
    {
      name: "model change",
      scenario: "success",
      candidate: reboundLocal.replaceAll("local-model", "other-model"),
    },
    {
      name: "MCP change",
      scenario: "success",
      candidate: reboundLocal.replace(
        "mcp_servers: {}",
        "mcp_servers: {extra: {command: untrusted}}",
      ),
    },
    { name: "raw environment credential", scenario: "raw-secret", candidate: reboundLocal },
    { name: "hash failure", scenario: "hash-failure", candidate: reboundLocal },
    { name: "stale read", scenario: "stale", candidate: reboundLocal },
    { name: "wrong lifecycle", scenario: "lifecycle", candidate: reboundLocal },
    { name: "symlink", scenario: "symlink", candidate: reboundLocal },
    { name: "hard link", scenario: "hardlink", candidate: reboundLocal },
    { name: "non-private restored mode", scenario: "unsafe-mode", candidate: reboundLocal },
  ])("preserves restored config after $name", ({ scenario, candidate }) => {
    const actual = transaction(scenario, "restore-native-local", restoredLocal, candidate);
    expect(actual.result.status).not.toBe(0);
    expect(actual.config).toBe(restoredLocal);
    expect(actual.hash).toBe(actual.originalHash);
    expect(actual.reloads).toBe("");
  });
});
