// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const TRANSACTION = path.resolve(
  import.meta.dirname,
  "../../..",
  "agents/hermes/mcp-config-transaction.py",
);
const GUARD = path.resolve(
  import.meta.dirname,
  "../../..",
  "agents/hermes/runtime-config-guard.py",
);

function runPython(source: string, args: string[] = []) {
  const revisionedEnvironment = Object.fromEntries(
    [...source.matchAll(/openshell:resolve:env:(v[0-9]{1,20})_([A-Za-z_][A-Za-z0-9_]*)/gu)].map(
      ([, revision, name]) => [name!, `openshell:resolve:env:${revision!}_${name!}`],
    ),
  );
  return spawnSync("python3", ["-c", source, TRANSACTION, GUARD, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...revisionedEnvironment },
  });
}

describe("Hermes managed MCP config reconciliation", () => {
  it("advertises versioned reconcile-finality support without mutating config", () => {
    const result = runPython(`
import contextlib, importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.os.geteuid = lambda: 0
module._configure_gateway_public_port = lambda: None
module._mcp_transaction_lock = contextlib.nullcontext
module.apply_transaction_and_reload = lambda action, payload: (_ for _ in ()).throw(RuntimeError("must not mutate"))
print(json.dumps(module.probe(), sort_keys=True))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      capabilities: { reconcile_finality: 1 },
      ok: true,
    });
  });

  it("proves committed and absent state through stable managed gateway health", () => {
    const result = runPython(`
import contextlib, importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.os.geteuid = lambda: 0
module._mcp_transaction_lock = lambda: contextlib.nullcontext()
module.RECONCILE_STABILITY_SECONDS = 0
module._configure_gateway_public_port = lambda: None
module._gateway_identity = lambda: (4242, 99)
module._gateway_has_managed_parent = lambda pid: pid == 4242
module._gateway_health_phase = lambda: (True, "waiting-for-stable-replacement-identity")
inspections = []
module.inspect_managed_config = lambda payload, require_applied_hash=False: inspections.append({"payload": payload, "requireAppliedHash": require_applied_hash}) or {"ok": True, "state": "matched"}
expected = {
    "url": "https://mcp.example.test/mcp",
    "enabled": True,
    "timeout": 120,
    "connect_timeout": 60,
    "tools": {"resources": True, "prompts": True},
    "headers": {"Authorization": "Bearer openshell:resolve:env:v7_FAKE_TOKEN"},
}
committed = module.reconcile_managed_config({"present": {"fake": expected}, "absent": []})
absent = module.reconcile_managed_config({"present": {}, "absent": ["fake"]})
print(json.dumps({"committed": committed, "absent": absent, "inspections": inspections}, sort_keys=True))
`);

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof).toMatchObject({
      committed: { ok: true, state: "committed" },
      absent: { ok: true, state: "absent" },
    });
    expect(proof.inspections).toHaveLength(4);
    expect(proof.inspections[0]).toMatchObject({
      requireAppliedHash: true,
      payload: { present: { fake: { url: "https://mcp.example.test/mcp" } }, absent: [] },
    });
  });

  it.each([
    ["gateway identity changes", "identity", /identity changed/u],
    ["public or internal health fails", "health", /public-relay-health/u],
    ["config or hash inspection fails", "integrity", /applied gateway state/u],
  ])("rejects reconciliation when %s", (_label, failure, message) => {
    const result = runPython(
      `
import contextlib, importlib.util, json, sys
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.os.geteuid = lambda: 0
module._mcp_transaction_lock = lambda: contextlib.nullcontext()
module.RECONCILE_STABILITY_SECONDS = 0
module._configure_gateway_public_port = lambda: None
identity_calls = {"count": 0}
def identity():
    identity_calls["count"] += 1
    return (4243, 100) if sys.argv[3] == "identity" and identity_calls["count"] > 1 else (4242, 99)
module._gateway_identity = identity
module._gateway_has_managed_parent = lambda pid: pid in (4242, 4243)
module._gateway_health_phase = lambda: (
    (False, "waiting-for-public-relay-health")
    if sys.argv[3] == "health"
    else (True, "waiting-for-stable-replacement-identity")
)
def inspect(payload, require_applied_hash=False):
    if sys.argv[3] == "integrity":
        raise RuntimeError("Hermes MCP config does not match applied gateway state")
    return {"ok": True, "state": "matched"}
module.inspect_managed_config = inspect
try:
    module.reconcile_managed_config({"present": {}, "absent": ["fake"]})
except RuntimeError as error:
    print(json.dumps({"error": str(error)}))
else:
    raise SystemExit(9)
`,
      [failure],
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).error).toMatch(message);
  });

  it("waits for an in-flight mutation before proving absence", () => {
    const result = runPython(`
import importlib.util, json, os, pathlib, sys, tempfile, threading, time
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
module.RECONCILE_STABILITY_SECONDS = 0
module._configure_gateway_public_port = lambda: None
module._gateway_identity = lambda: (4242, 99)
module._gateway_has_managed_parent = lambda pid: pid == 4242
module._gateway_health_phase = lambda: (True, "waiting-for-stable-replacement-identity")
committed = {"value": False}
observations = []
started = threading.Event()
release = threading.Event()
with tempfile.TemporaryDirectory() as root:
    lock_path = pathlib.Path(root) / "transaction.lock"
    lock_path.touch(mode=0o444)
    os.chmod(root, 0o755)
    module.MCP_TRANSACTION_LOCK_PATH = str(lock_path)
    module.MCP_TRANSACTION_LOCK_EXPECTED_UID = os.getuid()
    module.MCP_TRANSACTION_LOCK_EXPECTED_GID = os.getgid()
    def mutate():
        with module._mcp_transaction_lock():
            started.set()
            release.wait(2)
            committed["value"] = True
    worker = threading.Thread(target=mutate)
    worker.start()
    if not started.wait(2):
        raise SystemExit(8)
    module.inspect_managed_config = lambda payload, require_applied_hash=False: (
        observations.append(committed["value"])
        or (_ for _ in ()).throw(RuntimeError("requested native entry is now committed"))
        if committed["value"]
        else {"ok": True, "state": "matched"}
    )
    timer = threading.Timer(0.2, release.set)
    timer.start()
    began = time.monotonic()
    try:
        module.reconcile_managed_config({"present": {}, "absent": ["fake"]})
    except RuntimeError as error:
        elapsed = time.monotonic() - began
        outcome = {"elapsed": elapsed, "error": str(error), "observations": observations}
    else:
        raise SystemExit(9)
    finally:
        release.set()
        timer.cancel()
        worker.join(2)
print(json.dumps(outcome, sort_keys=True))
`);

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(proof.error).toContain("now committed");
    expect(proof.elapsed).toBeGreaterThanOrEqual(0.15);
    expect(proof.observations).toEqual([true]);
  });

  it("rejects a replaceable lock path before reconciliation", () => {
    const result = runPython(`
import importlib.util, json, os, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
calls = []
module._reconcile_managed_config_locked = lambda payload: calls.append(payload)
with tempfile.TemporaryDirectory() as root:
    lock_path = pathlib.Path(root) / "transaction.lock"
    lock_path.touch(mode=0o444)
    os.chmod(root, 0o777)
    module.MCP_TRANSACTION_LOCK_PATH = str(lock_path)
    module.MCP_TRANSACTION_LOCK_EXPECTED_UID = os.getuid()
    module.MCP_TRANSACTION_LOCK_EXPECTED_GID = os.getgid()
    try:
        module.reconcile_managed_config({"present": {}, "absent": ["fake"]})
    except RuntimeError as error:
        outcome = {"calls": calls, "error": str(error)}
    else:
        raise SystemExit(9)
print(json.dumps(outcome, sort_keys=True))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      calls: [],
      error: "Hermes MCP transaction lock is unsafe",
    });
  });

  it("detects lock-path replacement after acquiring the original descriptor", () => {
    const result = runPython(`
import importlib.util, json, os, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location("mcp_tx", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
calls = []
module._reconcile_managed_config_locked = lambda payload: calls.append(payload)
with tempfile.TemporaryDirectory() as root:
    lock_path = pathlib.Path(root) / "transaction.lock"
    lock_path.touch(mode=0o444)
    os.chmod(root, 0o755)
    module.MCP_TRANSACTION_LOCK_PATH = str(lock_path)
    module.MCP_TRANSACTION_LOCK_EXPECTED_UID = os.getuid()
    module.MCP_TRANSACTION_LOCK_EXPECTED_GID = os.getgid()
    real_flock = module.fcntl.flock
    def replace_after_acquisition(descriptor, operation):
        real_flock(descriptor, operation)
        if operation == module.fcntl.LOCK_EX:
            os.chmod(root, 0o700)
            lock_path.unlink()
            lock_path.touch(mode=0o444)
            os.chmod(root, 0o755)
    module.fcntl.flock = replace_after_acquisition
    try:
        module.reconcile_managed_config({"present": {}, "absent": ["fake"]})
    except RuntimeError as error:
        outcome = {"calls": calls, "error": str(error)}
    else:
        raise SystemExit(9)
print(json.dumps(outcome, sort_keys=True))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      calls: [],
      error: "Hermes MCP transaction lock changed during acquisition",
    });
  });
});
