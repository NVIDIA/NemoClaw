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

describe("Hermes MCP rollback integrity", () => {
  it("keeps a failed runtime rollback pending until a healthy old-config reload", () => {
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

transaction = load("rollback_pending_transaction", sys.argv[1])
guard = load("rollback_pending_guard", sys.argv[2])
with tempfile.TemporaryDirectory(prefix="hermes-mcp-rollback-pending-") as root:
    hermes = os.path.join(root, ".hermes")
    os.mkdir(hermes)
    config = os.path.join(hermes, "config.yaml")
    env = os.path.join(hermes, ".env")
    strict = os.path.join(root, "hermes.config-hash")
    compat = os.path.join(hermes, ".config-hash")
    original_config = "model: test\n"
    open(config, "w", encoding="utf-8").write(original_config)
    open(env, "w", encoding="utf-8").write("SAFE=1\n")
    initial, _config_snapshot, _env_snapshot = guard._hash_text(config, env)
    guard._write_hash(strict, initial)
    guard._write_hash(compat, initial)

    transaction.GUARD_PATH = sys.argv[2]
    transaction.HERMES_DIR = hermes
    transaction.CONFIG_PATH = config
    transaction.STRICT_HASH_PATH = strict
    transaction.os.geteuid = lambda: 0
    transaction._assert_mutable_snapshot = lambda _snapshot: None
    reload_calls = {"count": 0}
    def fail_reload():
        reload_calls["count"] += 1
        raise RuntimeError(f"reload-{reload_calls['count']}-failed")
    transaction.reload_gateway = fail_reload

    error = ""
    try:
        transaction.apply_transaction_and_reload("add", {
            "server": "fake",
            "url": "https://mcp.example.test/mcp",
            "headers": {"Authorization": "Bearer openshell:resolve:env:FAKE_TOKEN"},
            "replace_existing": False,
        })
    except RuntimeError as caught:
        error = str(caught)

    strict_pending = open(strict, encoding="utf-8").read()
    compat_pending = open(compat, encoding="utf-8").read()
    _config_digest, _env_digest, pending_marker = guard._parse_config_hash(
        strict_pending, config, env
    )
    pending_state = guard.inspect_mcp_integrity(hermes, strict)
    restored_config = open(config, encoding="utf-8").read()

    guard.refresh_hashes(hermes, strict, "strict", mcp_transition="apply")
    guard.refresh_hashes(hermes, strict, "compat", mcp_transition="apply")
    repaired_state = guard.inspect_mcp_integrity(hermes, strict)
    rejected = ""
    try:
        guard.refresh_hashes(hermes, strict, "strict", mcp_transition="rollback")
    except Exception as caught:
        rejected = str(caught)

    print(json.dumps({
        "compat_matches": compat_pending == strict_pending,
        "error": error,
        "marker_differs": pending_marker.intended != pending_marker.applied,
        "pending_state": pending_state,
        "rejected": rejected,
        "reload_calls": reload_calls["count"],
        "repaired_state": repaired_state,
        "restored_config": restored_config,
    }))
`,
        TRANSACTION,
        GUARD,
      ],
      { encoding: "utf-8", timeout: 15_000 },
    );

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout) as {
      compat_matches: boolean;
      error: string;
      marker_differs: boolean;
      pending_state: string;
      rejected: string;
      reload_calls: number;
      repaired_state: string;
      restored_config: string;
    };
    expect(proof).toMatchObject({
      compat_matches: true,
      marker_differs: true,
      pending_state: "pending",
      reload_calls: 2,
      repaired_state: "current",
      restored_config: "model: test\n",
    });
    expect(proof.error).toContain("reload-1-failed");
    expect(proof.error).toContain("old-config runtime reload failed: reload-2-failed");
    expect(proof.rejected).toContain("rollback requires a pending desired configuration");
  });
});
