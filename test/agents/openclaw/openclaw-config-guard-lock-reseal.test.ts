// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// _transition("lock") re-seals a perms-only drifted locked pair (#4663 / #7985).
//
// When a rebuild's closing shields relock re-confirms an already-locked
// /sandbox/.openclaw, an in-sandbox privileged reconciler (OpenClaw gateway /
// doctor perm-normalization) may have re-permissioned .config-hash back to
// 660 sandbox:sandbox in the meantime. The locked *directory* posture then
// routes into the verify-only branch, which used to raise config-not-locked and
// strand the sandbox with host shields state UNLOCKED while the state
// directories stayed root-locked (#7985: skill install fails, agent turns
// EACCES, `shields down` refuses). The fix lets that perms-only drift fall
// through to the freeze/install re-seal path. Content or structural drift is
// caught earlier by _snapshot_pair's hash check and still fails closed.
//
// The guard needs euid 0 and the fixed /sandbox/.openclaw path, so it cannot run
// for real here. This drives _transition through a Python harness that replaces
// every filesystem helper with a recording stub, asserting which branch runs.

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const guardPath = path.join(import.meta.dirname, "../../..", "scripts", "openclaw-config-guard.py");

// Loads the guard module, neutralizes the filesystem helpers _transition("lock")
// delegates to (recording which ran), then exercises one scenario named by argv.
// Prints "OK" and exits 0 on success; raises (non-zero exit) on any mismatch.
const HARNESS = String.raw`
import importlib.util, sys

guard_path, scenario = sys.argv[1], sys.argv[2]

spec = importlib.util.spec_from_file_location("openclaw_config_guard", guard_path)
g = importlib.util.module_from_spec(spec)
# KW_ONLY dataclasses in the guard resolve their own module from sys.modules
# during class creation, so register before exec.
sys.modules[spec.name] = g
spec.loader.exec_module(g)

ran = []
CONFIG_HASH = "/sandbox/.openclaw/.config-hash"
classify_resealable_drift = g._is_resealable_config_hash_permissions_drift
identity = g.Identity(root_uid=0, root_gid=0, sandbox_uid=1000, sandbox_gid=1000)

class Opened:
    config_path = "/sandbox/.openclaw"

opened = Opened()

def snapshot(name, uid, gid, mode, flags=0):
    return g.FileSnapshot(name, 1, 1, uid, gid, mode, 0, 0, 0, 1, b"x", (), flags)

locked_pair = (
    snapshot("openclaw.json", 0, 0, 0o444),
    snapshot(".config-hash", 0, 0, 0o444),
)
drifted_hash_pair = (
    locked_pair[0],
    snapshot(".config-hash", 1000, 1000, 0o660),
)
writable_config_pair = (
    snapshot("openclaw.json", 1000, 1000, 0o660),
    drifted_hash_pair[1],
)

def stub(name, result=None):
    def _run(*a, **k):
        ran.append(name)
        return result
    return _run

def raising(name, code):
    def _run(*a, **k):
        ran.append(name)
        raise g.GuardError(code, CONFIG_HASH, code)
    return _run

def check(cond, msg):
    if not cond:
        raise SystemExit("CHECK FAILED [%s]: %s ran=%r" % (scenario, msg, ran))

# Locked directory posture; every filesystem helper neutralized.
g._has_clamped_locked_dir_posture = lambda *a, **k: False
g._has_locked_dir_posture = lambda *a, **k: True
g._settle_pending_transaction_for_lock = stub("settle")
pair_results = iter(
    [drifted_hash_pair, locked_pair]
    if scenario == "perms-drift-reseals"
    else [writable_config_pair]
    if scenario == "unsafe-file-posture-reraised"
    else [locked_pair]
)
def snapshot_pair(*a, **k):
    ran.append("snapshot_pair")
    return next(pair_results)
g._snapshot_pair = snapshot_pair
g._freeze = stub("freeze")
g._repair_absent_hash_for_lock = stub("repair_hash")
g._snapshot_raw_pair = stub("snapshot_raw", ("raw-a", "raw-b"))
g._canonical_targets = stub("canonical", (("t-a", "t-b"), "digest"))
g._install_stored_pair = stub("install")
g._commit_locked_dirs = stub("commit")
g._force_fail_closed_lock = stub("fail_closed", [])

def lock():
    return g._transition("lock", opened, identity)

if scenario == "perms-drift-reseals":
    lock()  # The real classifier must route only the known drift to re-seal.
    check("freeze" in ran and "install" in ran and "commit" in ran, "expected re-seal")
    check(g._resealed_drift is True, "expected resealedDrift flag set for the result JSON")
    check("fail_closed" not in ran, "re-seal path must not fall into fail-closed")
elif scenario == "other-error-reraised":
    g._verify_locked_files = raising("verify", "startup-not-ready")
    code = None
    try:
        lock()
    except g.GuardError as e:
        code = e.code
    check(code == "startup-not-ready", "expected re-raise, got %r" % code)
    check("install" not in ran, "must not re-seal")
elif scenario == "unsafe-file-posture-reraised":
    code = None
    try:
        lock()
    except g.GuardError as e:
        code = e.code
    check(code == "config-not-locked", "expected unsafe posture rejection, got %r" % code)
    check("install" not in ran, "must not re-seal an unsafe file posture")
elif scenario == "classifies-only-known-hash-drift":
    locked_config, drifted_hash = drifted_hash_pair
    check(classify_resealable_drift((locked_config, drifted_hash), identity), "expected known drift")
    writable_config = snapshot("openclaw.json", 1000, 1000, 0o660)
    check(not classify_resealable_drift((writable_config, drifted_hash), identity), "writable config")
    unexpected_hash = snapshot(".config-hash", 0, 0, 0o644)
    check(not classify_resealable_drift((locked_config, unexpected_hash), identity), "unknown hash")
    flagged_hash = snapshot(".config-hash", 1000, 1000, 0o660, g.FS_IMMUTABLE_FL)
    check(not classify_resealable_drift((locked_config, flagged_hash), identity), "flagged hash")
elif scenario == "content-drift-fails-closed":
    g._snapshot_pair = raising("snapshot_pair", "config-hash-mismatch")
    code = None
    try:
        lock()
    except g.GuardError as e:
        code = e.code
    check(code == "config-hash-mismatch", "expected fail-closed, got %r" % code)
    check("verify" not in ran and "install" not in ran, "must not verify or re-seal")
elif scenario == "clean-verify-only":
    lock()  # clean locked pair: verify-only, no raise
    check("snapshot_pair" in ran and "freeze" not in ran and "install" not in ran, "expected verify-only")
    check(g._resealed_drift is False, "clean pair must not flag a reseal")
else:
    raise SystemExit("unknown scenario: " + scenario)

print("OK")
`;

function runScenario(scenario: string) {
  const result = spawnSync("python3", ["-c", HARNESS, guardPath, scenario], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(
    result.status,
    `guard harness '${scenario}' exited ${String(result.status)}:\n${result.stderr}${result.stdout}`,
  ).toBe(0);
  return result.stdout.trim();
}

describe("openclaw-config-guard lock re-seal on perms-only drift (#7985)", () => {
  it("re-seals a perms-only .config-hash drift instead of failing closed", () => {
    expect(runScenario("perms-drift-reseals")).toBe("OK");
  });

  it("re-raises a guard error that is not config-not-locked", () => {
    expect(runScenario("other-error-reraised")).toBe("OK");
  });

  it("rejects file-level drift outside the known .config-hash posture", () => {
    expect(runScenario("unsafe-file-posture-reraised")).toBe("OK");
  });

  it("classifies only the known hash-sidecar permission drift as recoverable", () => {
    expect(runScenario("classifies-only-known-hash-drift")).toBe("OK");
  });

  it("still fails closed on content or structural drift", () => {
    expect(runScenario("content-drift-fails-closed")).toBe("OK");
  });

  it("leaves an unmodified locked pair verify-only", () => {
    expect(runScenario("clean-verify-only")).toBe("OK");
  });
});
