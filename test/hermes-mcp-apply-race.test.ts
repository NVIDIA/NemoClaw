// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TRANSACTION = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "mcp-config-transaction.py",
);
const GUARD = path.join(import.meta.dirname, "..", "agents", "hermes", "runtime-config-guard.py");

describe("Hermes MCP apply-state race recovery", () => {
  it("returns success when the gateway commits the apply-state hash before the transaction helper can", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util, json, os, sys, tempfile

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

transaction = load("apply_race_transaction", sys.argv[1])
guard = load("apply_race_guard", sys.argv[2])

with tempfile.TemporaryDirectory(prefix="hermes-mcp-apply-race-") as root:
    hermes = os.path.join(root, ".hermes")
    os.mkdir(hermes)
    config = os.path.join(hermes, "config.yaml")
    env_path = os.path.join(hermes, ".env")
    strict = os.path.join(root, "hermes.config-hash")
    compat = os.path.join(hermes, ".config-hash")

    original_config = "model: test\n"
    open(config, "w", encoding="utf-8").write(original_config)
    open(env_path, "w", encoding="utf-8").write("SAFE=1\n")
    initial_hash, _, _ = guard._hash_text(config, env_path)
    guard._write_hash(strict, initial_hash)
    guard._write_hash(compat, initial_hash)

    transaction.GUARD_PATH = sys.argv[2]
    transaction.HERMES_DIR = hermes
    transaction.CONFIG_PATH = config
    transaction.STRICT_HASH_PATH = strict
    transaction.os.geteuid = lambda: 0
    transaction._assert_mutable_snapshot = lambda _: None

    payload = {
        "server": "fake",
        "url": "https://mcp.example.test/mcp",
        "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
        "replace_existing": False,
    }

    # Precompute what the new config would look like after the add using the
    # transaction module's own yaml import (avoids a standalone pyyaml dep).
    yaml = transaction.yaml
    candidate = transaction._managed_candidate(payload)
    new_config = yaml.safe_dump(
        {"model": "test", "mcp_servers": {"fake": candidate}}, sort_keys=False
    )

    # Mock apply_transaction: write the new config and advance hash to "intend".
    def mock_apply(action, recv_payload):
        open(config, "w", encoding="utf-8").write(new_config)
        guard.refresh_hashes(hermes, strict, "strict", mcp_transition="intend")
        guard.refresh_hashes(hermes, strict, "compat", mcp_transition="intend")
        return True
    transaction.apply_transaction = mock_apply

    # Mock reload_gateway: return True (gateway restart succeeded).
    transaction.reload_gateway = lambda: True

    # Mock _refresh_and_verify_hashes: on the first "apply" call, simulate
    # the gateway racing ahead by committing the apply-state hash before the
    # transaction helper can, then raise the race error that would result.
    original_refresh = transaction._refresh_and_verify_hashes
    apply_calls = {"n": 0}
    def race_on_apply(g, privileged, transition="preserve"):
        if transition == "apply":
            apply_calls["n"] += 1
            if apply_calls["n"] == 1:
                # Gateway commits apply-state hash (current/current with new config).
                guard.refresh_hashes(hermes, strict, "strict", mcp_transition="apply")
                guard.refresh_hashes(hermes, strict, "compat", mcp_transition="apply")
                raise guard.UnsafePathError(
                    "refusing raced runtime config path: " + compat
                )
        return original_refresh(g, privileged, transition)
    transaction._refresh_and_verify_hashes = race_on_apply

    returned = None
    error = ""
    try:
        returned = transaction.apply_transaction_and_reload("add", payload)
    except Exception as exc:
        error = str(exc)

    final_config = open(config, encoding="utf-8").read()
    final_state = guard.inspect_mcp_integrity(hermes, strict)
    anchors_match = (
        open(strict, encoding="utf-8").read()
        == open(compat, encoding="utf-8").read()
    )

    print(json.dumps({
        "returned": returned,
        "error": error,
        "final_config_is_new": final_config == new_config,
        "final_state": final_state,
        "anchors_match": anchors_match,
        "apply_calls": apply_calls["n"],
    }))
`,
        TRANSACTION,
        GUARD,
      ],
      { encoding: "utf-8", timeout: 15_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout) as {
      returned: Record<string, unknown> | null;
      error: string;
      final_config_is_new: boolean;
      final_state: string;
      anchors_match: boolean;
      apply_calls: number;
    };
    expect(proof.error).toBe("");
    expect(proof.returned).toEqual({ ok: true, changed: true, reloaded: true });
    expect(proof.final_config_is_new).toBe(true);
    expect(proof.final_state).toBe("current");
    expect(proof.anchors_match).toBe(true);
    expect(proof.apply_calls).toBe(1);
  });

  it("falls back to rollback when only the strict integrity anchor was committed", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util, json, os, sys, tempfile

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

transaction = load("partial_apply_race_transaction", sys.argv[1])
guard = load("partial_apply_race_guard", sys.argv[2])

with tempfile.TemporaryDirectory(prefix="hermes-mcp-partial-apply-race-") as root:
    hermes = os.path.join(root, ".hermes")
    os.mkdir(hermes)
    config = os.path.join(hermes, "config.yaml")
    env_path = os.path.join(hermes, ".env")
    strict = os.path.join(root, "hermes.config-hash")
    compat = os.path.join(hermes, ".config-hash")

    original_config = "model: test\n"
    open(config, "w", encoding="utf-8").write(original_config)
    open(env_path, "w", encoding="utf-8").write("SAFE=1\n")
    initial_hash, _, _ = guard._hash_text(config, env_path)
    guard._write_hash(strict, initial_hash)
    guard._write_hash(compat, initial_hash)

    transaction.GUARD_PATH = sys.argv[2]
    transaction.HERMES_DIR = hermes
    transaction.CONFIG_PATH = config
    transaction.STRICT_HASH_PATH = strict
    transaction.os.geteuid = lambda: 0
    transaction._assert_mutable_snapshot = lambda _: None

    payload = {
        "server": "fake",
        "url": "https://mcp.example.test/mcp",
        "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
        "replace_existing": False,
    }
    candidate = transaction._managed_candidate(payload)
    new_config = transaction.yaml.safe_dump(
        {"model": "test", "mcp_servers": {"fake": candidate}}, sort_keys=False
    )

    def mock_apply(action, recv_payload):
        open(config, "w", encoding="utf-8").write(new_config)
        guard.refresh_hashes(hermes, strict, "strict", mcp_transition="intend")
        guard.refresh_hashes(hermes, strict, "compat", mcp_transition="intend")
        return True
    transaction.apply_transaction = mock_apply

    reload_calls = {"n": 0}
    def mock_reload():
        reload_calls["n"] += 1
        return True
    transaction.reload_gateway = mock_reload

    apply_calls = {"n": 0}
    rollback_calls = {"n": 0}
    def partial_commit_then_fail_closed(g, privileged, transition="preserve"):
        if transition == "apply":
            apply_calls["n"] += 1
            if apply_calls["n"] == 1:
                # The strict commit record advanced, but the compatibility
                # anchor remained in the pending intend state.
                guard.refresh_hashes(hermes, strict, "strict", mcp_transition="apply")
                raise guard.UnsafePathError(
                    "refusing raced runtime config path: " + strict
                )
        if transition == "rollback":
            rollback_calls["n"] += 1
            raise RuntimeError("simulated rollback hash failure after partial commit")
    transaction._refresh_and_verify_hashes = partial_commit_then_fail_closed

    returned = None
    error = ""
    try:
        returned = transaction.apply_transaction_and_reload("add", payload)
    except Exception as exc:
        error = str(exc)

    final_config = open(config, encoding="utf-8").read()
    print(json.dumps({
        "returned": returned,
        "error": error,
        "final_config_is_original": final_config == original_config,
        "apply_calls": apply_calls["n"],
        "rollback_calls": rollback_calls["n"],
        "reload_calls": reload_calls["n"],
    }))
`,
        TRANSACTION,
        GUARD,
      ],
      { encoding: "utf-8", timeout: 15_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout) as {
      returned: Record<string, unknown> | null;
      error: string;
      final_config_is_original: boolean;
      apply_calls: number;
      rollback_calls: number;
      reload_calls: number;
    };
    expect(proof.returned).toBeNull();
    expect(proof.error).toContain("Hermes MCP runtime reload failed");
    expect(proof.error).toContain("simulated rollback hash failure after partial commit");
    expect(proof.final_config_is_original).toBe(true);
    expect(proof.apply_calls).toBe(1);
    expect(proof.rollback_calls).toBe(1);
    expect(proof.reload_calls).toBe(1);
  });

  it("rolls back when both anchors advance but the gateway reload did not complete", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import importlib.util, json, os, sys, tempfile

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module

transaction = load("failed_reload_race_transaction", sys.argv[1])
guard = load("failed_reload_race_guard", sys.argv[2])

with tempfile.TemporaryDirectory(prefix="hermes-mcp-failed-reload-race-") as root:
    hermes = os.path.join(root, ".hermes")
    os.mkdir(hermes)
    config = os.path.join(hermes, "config.yaml")
    env_path = os.path.join(hermes, ".env")
    strict = os.path.join(root, "hermes.config-hash")
    compat = os.path.join(hermes, ".config-hash")

    original_config = "model: test\n"
    open(config, "w", encoding="utf-8").write(original_config)
    open(env_path, "w", encoding="utf-8").write("SAFE=1\n")
    initial_hash, _, _ = guard._hash_text(config, env_path)
    guard._write_hash(strict, initial_hash)
    guard._write_hash(compat, initial_hash)

    transaction.GUARD_PATH = sys.argv[2]
    transaction.HERMES_DIR = hermes
    transaction.CONFIG_PATH = config
    transaction.STRICT_HASH_PATH = strict
    transaction.os.geteuid = lambda: 0
    transaction._assert_mutable_snapshot = lambda _: None

    payload = {
        "server": "fake",
        "url": "https://mcp.example.test/mcp",
        "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
        "replace_existing": False,
    }
    candidate = transaction._managed_candidate(payload)
    new_config = transaction.yaml.safe_dump(
        {"model": "test", "mcp_servers": {"fake": candidate}}, sort_keys=False
    )

    def mock_apply(action, recv_payload):
        open(config, "w", encoding="utf-8").write(new_config)
        guard.refresh_hashes(hermes, strict, "strict", mcp_transition="intend")
        guard.refresh_hashes(hermes, strict, "compat", mcp_transition="intend")
        return True
    transaction.apply_transaction = mock_apply

    reload_calls = {"n": 0}
    def mock_reload():
        reload_calls["n"] += 1
        if reload_calls["n"] == 1:
            # Another writer advanced both anchors, but that does not prove this
            # failed reload installed the intended config in the live runtime.
            guard.refresh_hashes(hermes, strict, "strict", mcp_transition="apply")
            guard.refresh_hashes(hermes, strict, "compat", mcp_transition="apply")
            return False
        return True
    transaction.reload_gateway = mock_reload

    returned = None
    error = ""
    try:
        returned = transaction.apply_transaction_and_reload("add", payload)
    except Exception as exc:
        error = str(exc)

    final_config = open(config, encoding="utf-8").read()
    integrity_error = ""
    try:
        guard.inspect_mcp_integrity(hermes, strict)
    except Exception as exc:
        integrity_error = str(exc)
    print(json.dumps({
        "returned": returned,
        "error": error,
        "final_config_is_original": final_config == original_config,
        "integrity_error": integrity_error,
        "reload_calls": reload_calls["n"],
    }))
`,
        TRANSACTION,
        GUARD,
      ],
      { encoding: "utf-8", timeout: 15_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout) as {
      returned: Record<string, unknown> | null;
      error: string;
      final_config_is_original: boolean;
      integrity_error: string;
      reload_calls: number;
    };
    expect(proof.returned).toBeNull();
    expect(proof.error).toContain("Hermes MCP runtime reload failed");
    expect(proof.error).toContain("gateway stopped before managed MCP reload");
    expect(proof.error).toContain("config/hash rollback failed");
    expect(proof.final_config_is_original).toBe(true);
    expect(proof.integrity_error).toContain("hash does not match persisted inputs");
    expect(proof.reload_calls).toBe(1);
  });
});
