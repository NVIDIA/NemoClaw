// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { dockerSpawnSync } from "../src/lib/adapters/docker/exec";

const RUNTIME_CONFIG_GUARD = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "runtime-config-guard.py",
);
const ROOT_RUNTIME_IMAGE =
  "python:3.12-slim@sha256:cab2dbf575e971934a81e4622f5aba17aa7929719bd7e31033a3a83b97fd0464";
const ROOT_CONTAINER_RUNTIME_AVAILABLE =
  process.platform === "linux" &&
  dockerSpawnSync(["info"], {
    stdio: "ignore",
    timeout: 15_000,
  }).status === 0;
const ROOT_CONTAINER_DRIVER = String.raw`
import json
import os
import sys

payload = json.load(sys.stdin)
guard_path = "/tmp/runtime-config-guard.py"
with open(guard_path, "x", encoding="utf-8") as handle:
    handle.write(payload["guard_source"])
os.chmod(guard_path, 0o444)
sys.argv = ["-c", guard_path]
exec(
    compile(payload["harness"], "<root-runtime-harness>", "exec"),
    {"__name__": "__main__"},
)
`;

function runPythonHarness(source: string) {
  return spawnSync("python3", ["-c", source, RUNTIME_CONFIG_GUARD], {
    encoding: "utf-8",
    timeout: 5000,
  });
}

function runRootContainerHarness(source: string) {
  return dockerSpawnSync(
    [
      "run",
      "--rm",
      "-i",
      "--platform",
      "linux/amd64",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=64m",
      ROOT_RUNTIME_IMAGE,
      "python3",
      "-c",
      ROOT_CONTAINER_DRIVER,
    ],
    {
      encoding: "utf-8",
      input: JSON.stringify({
        guard_source: readFileSync(RUNTIME_CONFIG_GUARD, "utf-8"),
        harness: source,
      }),
      timeout: 60_000,
    },
  );
}

const loadGuardModule = String.raw`
import importlib.util
import sys
import types

yaml = types.ModuleType("yaml")
class YAMLError(Exception):
    pass
yaml.YAMLError = YAMLError
yaml.safe_load = lambda _text: {"model": "test"}
sys.modules["yaml"] = yaml

spec = importlib.util.spec_from_file_location("runtime_config_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
`;

describe("Hermes mutable shields root topology", () => {
  it("maps a real missing marker to same-UID and rejects marker bypass or drift (#7033)", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile
from types import SimpleNamespace

def capture_topology_error():
    try:
        guard._attested_shields_runtime_topology()
    except guard.UnsafePathError as exc:
        return str(exc)
    return ""

with tempfile.TemporaryDirectory() as tmp:
    marker = os.path.join(tmp, "hermes-root-lifecycle")
    target = os.path.join(tmp, "marker-target")
    guard.HERMES_ROOT_LIFECYCLE_MARKER = marker
    guard.__file__ = guard.INSTALLED_RUNTIME_CONFIG_GUARD
    guard.os.geteuid = lambda: 0
    guard._startup_ready_marker_absent = lambda: True
    guard.pwd.getpwnam = lambda _name: SimpleNamespace(pw_uid=1000)
    fallback_calls = []
    guard._openshell_supervised_nonroot_start_is_live = (
        lambda *_args: fallback_calls.append("same-uid-proof") or True
    )

    missing_state = guard._root_lifecycle_marker_state()
    missing_topology = guard._attested_shields_runtime_topology()
    guard._openshell_supervised_nonroot_start_is_live = (
        lambda *_args: fallback_calls.append("missing-proof") or False
    )
    missing_without_proof = guard._attested_shields_runtime_topology()
    guard._openshell_supervised_nonroot_start_is_live = (
        lambda *_args: fallback_calls.append("unexpected-bypass-fallback") or True
    )

    with open(target, "wb") as handle:
        handle.write(b"root-separated\\n")
    os.chmod(target, 0o444)
    os.symlink(target, marker)
    symlink_error = capture_topology_error()
    os.unlink(marker)

    os.symlink(os.path.join(tmp, "missing-target"), marker)
    dangling_symlink_error = capture_topology_error()
    os.unlink(marker)

    os.link(target, marker)
    hardlink_error = capture_topology_error()
    os.unlink(marker)

    os.mkdir(marker, 0o700)
    directory_error = capture_topology_error()
    os.rmdir(marker)

    marker_states = iter(("absent", "root-separated"))
    guard._root_lifecycle_marker_state = lambda: next(marker_states)
    guard._startup_ready_marker_absent = lambda: True
    guard._openshell_supervised_nonroot_start_is_live = lambda *_args: True
    marker_drift_error = capture_topology_error()

    guard._root_lifecycle_marker_state = lambda: "absent"
    startup_states = iter((True, False))
    guard._startup_ready_marker_absent = lambda: next(startup_states)
    startup_drift_error = capture_topology_error()

print(json.dumps({
    "missing_state": missing_state,
    "missing_topology": missing_topology,
    "missing_without_proof": missing_without_proof,
    "symlink_error": symlink_error,
    "dangling_symlink_error": dangling_symlink_error,
    "hardlink_error": hardlink_error,
    "directory_error": directory_error,
    "marker_drift_error": marker_drift_error,
    "startup_drift_error": startup_drift_error,
    "fallback_calls": fallback_calls,
}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      dangling_symlink_error: "Hermes root lifecycle marker is unsafe",
      directory_error: "Hermes root lifecycle marker is unsafe",
      fallback_calls: ["same-uid-proof", "missing-proof"],
      hardlink_error: "Hermes root lifecycle marker is unsafe",
      marker_drift_error: "Hermes runtime topology changed during attestation",
      missing_state: "absent",
      missing_topology: "same-uid-nonroot",
      missing_without_proof: "unknown",
      startup_drift_error: "Hermes runtime topology changed during attestation",
      symlink_error: "Hermes root lifecycle marker is unsafe",
    });
  });

  it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
    "attests a real root-owned marker and rejects malformed metadata or topology drift (#7033)",
    () => {
      const result = runPythonHarness(`${loadGuardModule}
import json
import os
import tempfile

def capture_topology_error():
    try:
        guard._attested_shields_runtime_topology()
    except guard.UnsafePathError as exc:
        return str(exc)
    return ""

with tempfile.TemporaryDirectory() as tmp:
    marker = os.path.join(tmp, "hermes-root-lifecycle")
    source = os.path.join(tmp, "marker-source")
    guard.HERMES_ROOT_LIFECYCLE_MARKER = marker
    fallback_calls = []
    guard._openshell_supervised_nonroot_start_is_live = (
        lambda *_args: fallback_calls.append("unexpected-fallback") or True
    )

    def publish(payload=b"root-separated\\n", mode=0o444, uid=0, gid=0):
        try:
            os.unlink(marker)
        except FileNotFoundError:
            pass
        with open(marker, "wb") as handle:
            handle.write(payload)
        os.chown(marker, uid, gid)
        os.chmod(marker, mode)

    publish()

    guard._pid1_is_nemoclaw_start = lambda: True
    guard._process_effective_uid = lambda pid: 0 if pid == 1 else None
    valid_state = guard._root_lifecycle_marker_state()
    valid_topology = guard._attested_shields_runtime_topology()

    guard._pid1_is_nemoclaw_start = lambda: False
    pid1_error = capture_topology_error()
    guard._pid1_is_nemoclaw_start = lambda: True

    guard._process_effective_uid = lambda pid: 1000 if pid == 1 else None
    pid1_uid_error = capture_topology_error()
    guard._process_effective_uid = lambda pid: 0 if pid == 1 else None

    real_geteuid = guard.os.geteuid
    guard.os.geteuid = lambda: 1000
    guard_uid_error = capture_topology_error()
    guard.os.geteuid = real_geteuid

    publish(b"root-separated\\ntrailing-data")
    content_error = capture_topology_error()

    publish(mode=0o644)
    mode_error = capture_topology_error()

    publish(uid=12345, gid=12345)
    owner_error = capture_topology_error()

    os.unlink(marker)
    with open(source, "wb") as handle:
        handle.write(b"root-separated\\n")
    os.chown(source, 0, 0)
    os.chmod(source, 0o444)
    os.link(source, marker)
    hardlink_error = capture_topology_error()

print(json.dumps({
    "valid_state": valid_state,
    "valid_topology": valid_topology,
    "pid1_error": pid1_error,
    "pid1_uid_error": pid1_uid_error,
    "guard_uid_error": guard_uid_error,
    "content_error": content_error,
    "mode_error": mode_error,
    "owner_error": owner_error,
    "hardlink_error": hardlink_error,
    "fallback_calls": fallback_calls,
}))
`);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        content_error: "Hermes root lifecycle marker is unsafe",
        fallback_calls: [],
        guard_uid_error: "Hermes root lifecycle marker does not match the live PID 1 topology",
        hardlink_error: "Hermes root lifecycle marker is unsafe",
        mode_error: "Hermes root lifecycle marker is unsafe",
        owner_error: "Hermes root lifecycle marker is unsafe",
        pid1_error: "Hermes root lifecycle marker does not match the live PID 1 topology",
        pid1_uid_error: "Hermes root lifecycle marker does not match the live PID 1 topology",
        valid_state: "root-separated",
        valid_topology: "root-separated",
      });
    },
  );

  it("accepts private mode only for same UID, repairs root separation, and rejects unknown topology (#7033)", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import stat
import tempfile
from types import SimpleNamespace

with tempfile.TemporaryDirectory() as tmp:
    hermes = os.path.join(tmp, ".hermes")
    os.mkdir(hermes, 0o700)
    os.chmod(hermes, 0o700)
    fd = os.open(hermes, os.O_RDONLY | os.O_DIRECTORY)
    try:
        initial = os.fstat(fd)
        expected = {
            "dev": initial.st_dev,
            "ino": initial.st_ino,
            "uid": initial.st_uid,
            "gid": initial.st_gid,
            "mode": 0o3770,
        }

        guard._attested_shields_runtime_topology = lambda: "same-uid-nonroot"
        same_stat, same_posture = guard._reconcile_private_mutable_shields_root(
            fd, os.fstat(fd), expected, "mutable"
        )

        os.fchmod(fd, 0o700)
        guard._attested_shields_runtime_topology = lambda: "root-separated"
        real_fchmod = guard.os.fchmod
        real_fstat = guard.os.fstat
        root_requested_modes = []
        def linux_fchmod(target_fd, mode):
            if target_fd == fd and mode == 0o3770:
                root_requested_modes.append(mode)
                return
            return real_fchmod(target_fd, mode)
        def linux_fstat(target_fd):
            current = real_fstat(target_fd)
            if target_fd != fd or not root_requested_modes:
                return current
            return SimpleNamespace(
                st_dev=current.st_dev,
                st_ino=current.st_ino,
                st_uid=current.st_uid,
                st_gid=current.st_gid,
                st_mode=(current.st_mode & ~0o7777) | root_requested_modes[-1],
            )
        guard.os.fchmod = linux_fchmod
        guard.os.fstat = linux_fstat
        try:
            root_stat, root_posture = guard._reconcile_private_mutable_shields_root(
                fd, guard.os.fstat(fd), expected, "mutable"
            )
        finally:
            guard.os.fchmod = real_fchmod
            guard.os.fstat = real_fstat

        os.fchmod(fd, 0o700)
        guard._attested_shields_runtime_topology = lambda: "unknown"
        try:
            guard._reconcile_private_mutable_shields_root(
                fd, os.fstat(fd), expected, "mutable"
            )
        except guard.UnsafePathError as exc:
            unknown_error = str(exc)
        else:
            unknown_error = ""
        unknown_mode = stat.S_IMODE(os.fstat(fd).st_mode)
    finally:
        os.close(fd)

print(json.dumps({
    "same_mode": stat.S_IMODE(same_stat.st_mode),
    "same_posture": same_posture,
    "root_mode": stat.S_IMODE(root_stat.st_mode),
    "root_posture": root_posture,
    "root_requested_modes": root_requested_modes,
    "unknown_error": unknown_error,
    "unknown_mode": unknown_mode,
}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      root_mode: 0o3770,
      root_posture: "root-separated",
      root_requested_modes: [0o3770],
      same_mode: 0o700,
      same_posture: "same-uid-nonroot",
      unknown_error:
        "refusing shields finish because private mutable .hermes lacks an attested same-UID topology",
      unknown_mode: 0o700,
    });
  });

  it("reapplies root-separated mode after a deterministic post-attestation race (#7033)", () => {
    const result = runPythonHarness(`${loadGuardModule}
import json
import os
import stat
import tempfile
from types import SimpleNamespace

with tempfile.TemporaryDirectory() as tmp:
    hermes = os.path.join(tmp, ".hermes")
    os.mkdir(hermes, 0o700)
    os.chmod(hermes, 0o700)
    fd = os.open(hermes, os.O_RDONLY | os.O_DIRECTORY)
    real_fchmod = guard.os.fchmod
    real_fstat = guard.os.fstat
    real_fsync = guard.os.fsync
    synthetic_mode = 0o700
    requested_modes = []
    events = []

    def tracked_fchmod(target_fd, mode):
        global synthetic_mode
        if target_fd == fd:
            requested_modes.append(mode)
            synthetic_mode = mode
            events.append(f"fchmod:{oct(mode)}")
            return
        return real_fchmod(target_fd, mode)

    def tracked_fstat(target_fd):
        current = real_fstat(target_fd)
        if target_fd != fd:
            return current
        events.append(f"fstat:{oct(synthetic_mode)}")
        return SimpleNamespace(
            st_dev=current.st_dev,
            st_ino=current.st_ino,
            st_uid=current.st_uid,
            st_gid=current.st_gid,
            st_mode=(current.st_mode & ~0o7777) | synthetic_mode,
        )

    def tracked_fsync(target_fd):
        if target_fd == fd:
            events.append("fsync")
            return
        return real_fsync(target_fd)

    guard.os.fchmod = tracked_fchmod
    guard.os.fstat = tracked_fstat
    guard.os.fsync = tracked_fsync
    try:
        initial = guard.os.fstat(fd)
        expected = {
            "dev": initial.st_dev,
            "ino": initial.st_ino,
            "uid": initial.st_uid,
            "gid": initial.st_gid,
            "mode": 0o3770,
        }
        guard._attested_shields_runtime_topology = lambda: "root-separated"
        _early, posture = guard._reconcile_private_mutable_shields_root(
            fd, initial, expected, "mutable"
        )

        # Deterministically model the sandbox owner undoing the first repair
        # after attestation but before the irreversible commit.
        synthetic_mode = 0o700
        raced_mode = stat.S_IMODE(guard.os.fstat(fd).st_mode)
        events.clear()
        final = guard._enforce_final_shields_root_posture(
            fd, expected, "mutable", posture
        )
        commit_events = list(events)
        synthetic_mode = 0o700
        same_private = guard._enforce_final_shields_root_posture(
            fd, expected, "mutable", "same-uid-nonroot"
        )
        synthetic_mode = 0o3770
        same_canonical = guard._enforce_final_shields_root_posture(
            fd, expected, "mutable", "same-uid-nonroot"
        )
        synthetic_mode = 0o750
        try:
            guard._enforce_final_shields_root_posture(
                fd, expected, "mutable", "same-uid-nonroot"
            )
        except guard.UnsafePathError as exc:
            same_drift_error = str(exc)
        else:
            same_drift_error = ""
    finally:
        guard.os.fchmod = real_fchmod
        guard.os.fstat = real_fstat
        guard.os.fsync = real_fsync
        os.close(fd)

print(json.dumps({
    "posture": posture,
    "raced_mode": raced_mode,
    "final_mode": stat.S_IMODE(final.st_mode),
    "requested_modes": requested_modes,
    "same_private_mode": stat.S_IMODE(same_private.st_mode),
    "same_canonical_mode": stat.S_IMODE(same_canonical.st_mode),
    "same_drift_error": same_drift_error,
    "commit_events": commit_events,
}))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      commit_events: ["fchmod:0o3770", "fsync", "fstat:0o3770"],
      final_mode: 0o3770,
      posture: "root-separated",
      raced_mode: 0o700,
      requested_modes: [0o3770, 0o3770],
      same_canonical_mode: 0o3770,
      same_drift_error: "refusing shields finish because the final .hermes metadata drifted",
      same_private_mode: 0o700,
    });
  });

  // source-shape-contract: security -- Executes the shipped guard as root to prove real Linux repair and rollback metadata
  it.skipIf(!ROOT_CONTAINER_RUNTIME_AVAILABLE)(
    "restores exact locked posture after root-separated repair and later failure (#7033)",
    () => {
      const result = runRootContainerHarness(`${loadGuardModule}
import json
import os
import stat
import tempfile

with tempfile.TemporaryDirectory() as tmp:
    os.chmod(tmp, 0o700)
    sandbox = os.path.join(tmp, "sandbox")
    hermes = os.path.join(sandbox, ".hermes")
    os.makedirs(hermes)
    config = os.path.join(hermes, "config.yaml")
    env = os.path.join(hermes, ".env")
    strict = os.path.join(tmp, "hermes.config-hash")
    state = os.path.join(tmp, "restart-state.json")
    lock = os.path.join(tmp, "hermes-config-mutation.lock")
    lifecycle_marker = os.path.join(tmp, "hermes-root-lifecycle")

    with open(lifecycle_marker, "wb") as handle:
        handle.write(b"root-separated\\n")
    os.chown(lifecycle_marker, 0, 0)
    os.chmod(lifecycle_marker, 0o444)
    guard.HERMES_ROOT_LIFECYCLE_MARKER = lifecycle_marker
    guard._pid1_is_nemoclaw_start = lambda: True
    guard._process_effective_uid = lambda pid: 0 if pid == 1 else None

    with open(config, "wb") as handle:
        handle.write(b"model: test\\n")
    with open(env, "wb") as handle:
        handle.write(b"SAFE=1\\n")
    initial_hash, _config_snapshot, _env_snapshot = guard._hash_text(config, env)
    guard._write_hash(strict, initial_hash)
    guard.refresh_hashes(hermes, strict, "both")
    for name in (config, env, os.path.join(hermes, ".config-hash")):
        os.chmod(name, 0o444)
    os.chmod(hermes, 0o755)
    os.chmod(sandbox, 0o755)

    guard._get_inode_flags = lambda _fd: 0
    guard._set_inode_flags = lambda _fd, _flags: None
    guard._sandbox_identity = lambda: (12345, 12345)
    token, _original_locked = guard.begin_shields_transition(
        hermes, strict, state, "mutable", "locked"
    )
    guard._claim_transition_worker = (
        lambda state_path, _token, _purpose: guard._load_restart_state(state_path)
    )
    guard.apply_shields_transition(hermes, state, token)

    # Exercise the actual Linux owner capability through a descriptor retained
    # before the parent namespace is frozen, rather than simulating chmod.
    raced_fd = os.open(hermes, os.O_RDONLY | os.O_DIRECTORY)
    child = os.fork()
    if child == 0:
        os.setgid(12345)
        os.setuid(12345)
        try:
            os.fchmod(raced_fd, 0o700)
        except OSError:
            os._exit(1)
        else:
            os._exit(0)
    _pid, child_status = os.waitpid(child, 0)
    os.close(raced_fd)
    if child_status != 0:
        raise RuntimeError(f"sandbox chmod child failed: {child_status}")

    real_verify_compat = guard._verify_compat_hash
    guard._verify_compat_hash = lambda *_args: (_ for _ in ()).throw(
        guard.UnsafePathError("simulated later validation failure")
    )
    try:
        guard.finish_shields_transition(hermes, strict, state, token)
    except guard.UnsafePathError as exc:
        finish_error = str(exc)
    else:
        finish_error = ""
    repaired_mode = stat.S_IMODE(os.stat(hermes).st_mode)
    applied_state = guard._load_restart_state(state).get("phase")

    guard._verify_compat_hash = real_verify_compat
    guard.prepare_shields_abort(hermes, state, token)
    aborting_state = guard._load_restart_state(state).get("phase")
    guard.abort_shields_transition(hermes, state, token)
    lifecycle_stat = os.stat(lifecycle_marker, follow_symlinks=False)
    with open(lifecycle_marker, "rb") as handle:
        lifecycle_content = handle.read().decode("ascii")

    print(json.dumps({
        "finish_error": finish_error,
        "repaired_mode": oct(repaired_mode),
        "applied_state": applied_state,
        "aborting_state": aborting_state,
        "parent_mode": oct(stat.S_IMODE(os.stat(sandbox).st_mode)),
        "parent_uid": os.stat(sandbox).st_uid,
        "parent_gid": os.stat(sandbox).st_gid,
        "hermes_mode": oct(stat.S_IMODE(os.stat(hermes).st_mode)),
        "hermes_uid": os.stat(hermes).st_uid,
        "hermes_gid": os.stat(hermes).st_gid,
        "file_modes": {
            name: oct(stat.S_IMODE(os.stat(os.path.join(hermes, name)).st_mode))
            for name in guard.SEALED_FILE_NAMES
        },
        "state_exists": os.path.exists(state),
        "lock_exists": os.path.exists(lock),
        "marker_exists": os.path.exists(
            os.path.join(hermes, guard.RESTART_ORPHAN_MARKER_NAME)
        ),
        "lifecycle_marker": {
            "uid": lifecycle_stat.st_uid,
            "gid": lifecycle_stat.st_gid,
            "mode": oct(stat.S_IMODE(lifecycle_stat.st_mode)),
            "nlink": lifecycle_stat.st_nlink,
            "content": lifecycle_content,
        },
    }))
`);

      expect(result.status, result.error?.message || String(result.stderr || result.stdout)).toBe(
        0,
      );
      expect(JSON.parse(String(result.stdout))).toEqual({
        aborting_state: "shields-transition-aborting",
        applied_state: "shields-transition-applied",
        file_modes: {
          ".config-hash": "0o444",
          ".env": "0o444",
          "config.yaml": "0o444",
        },
        finish_error: "simulated later validation failure",
        hermes_gid: 0,
        hermes_mode: "0o755",
        hermes_uid: 0,
        lifecycle_marker: {
          content: "root-separated\n",
          gid: 0,
          mode: "0o444",
          nlink: 1,
          uid: 0,
        },
        lock_exists: false,
        marker_exists: false,
        parent_gid: 12345,
        parent_mode: "0o1775",
        parent_uid: 0,
        repaired_mode: "0o3770",
        state_exists: false,
      });
    },
  );
});
