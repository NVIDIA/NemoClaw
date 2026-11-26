// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const guardPath = path.resolve(
  import.meta.dirname,
  "../../../agents/hermes/runtime-config-guard.py",
);
const harness = String.raw`
import importlib.util, json, os, pathlib, stat, sys, tempfile, types
spec = importlib.util.spec_from_file_location("guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)
scenario = sys.argv[2]
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    proc = root / "proc"
    proc.mkdir()
    guard.PROC_ROOT = str(proc)
    guard.__file__ = guard.INSTALLED_RUNTIME_CONFIG_GUARD
    guard.HERMES_ROOT_LIFECYCLE_MARKER = str(root / "root-marker")
    guard.HERMES_STARTUP_READY_FILE = str(root / "ready-marker")
    guard.pwd.getpwnam = lambda _name: types.SimpleNamespace(pw_uid=1000, pw_gid=1000)
    guard.os.getppid = lambda: 20
    dev = root / "dev"
    dev.mkdir()
    (dev / "dri").mkdir()
    sysfs = root / "drm"
    sysfs.mkdir()
    real_open, real_fstat, real_scandir = guard.os.open, guard.os.fstat, guard.os.scandir
    real_path_flag = getattr(os, "O_PATH", None)
    guard.os.O_PATH = real_path_flag or 0x200000
    sysfs_inode = sysfs.stat().st_ino
    dev_inode, dri_inode = dev.stat().st_ino, (dev / "dri").stat().st_ino
    def open_device(path, flags, *args, **kwargs):
        if path == "/dev":
            if scenario == "bootstrap-drm-parent-symlink":
                raise OSError("symlink refused")
            path = str(dev)
        if path == "dri" and scenario == "bootstrap-drm-directory-symlink":
            raise OSError("symlink refused")
        if path in (str(dev), "dri"):
            if not flags & guard.os.O_PATH:
                raise PermissionError("Landlock denies device directory reads")
            if real_path_flag is None:
                flags &= ~guard.os.O_PATH
        if path == "/sys/class/drm":
            if scenario == "bootstrap-drm-sysfs-unreadable":
                raise PermissionError("sysfs denied")
            if scenario == "bootstrap-drm-sysfs-symlink":
                raise OSError("symlink refused")
            path = str(sysfs)
        return real_open(path, flags, *args, **kwargs)
    def directory_metadata(fd):
        metadata = real_fstat(fd)
        if metadata.st_ino in (dev_inode, dri_inode, sysfs_inode):
            values = list(metadata)
            values[4] = 1000 if scenario == "bootstrap-drm-directory-owner" else 0
            values[5] = 1000 if scenario == "bootstrap-drm-directory-group" else 0
            values[0] = stat.S_IFDIR | (0o777 if scenario == "bootstrap-drm-directory-writable" else 0o755)
            if metadata.st_ino == sysfs_inode:
                if scenario == "bootstrap-drm-sysfs-owner": values[4] = 1000
                if scenario == "bootstrap-drm-sysfs-group": values[5] = 1000
                if scenario == "bootstrap-drm-sysfs-writable": values[0] = stat.S_IFDIR | 0o777
            return os.stat_result(values)
        return metadata
    devices = {"card0": (44, 0), "renderD128": (992, 128)}
    if scenario == "bootstrap-drm-extended-minors":
        devices = {"card256": (44, 256), "renderD257": (992, 257)}
    if scenario == "bootstrap-drm-too-many":
        devices = {f"card{n}": (44, n) for n in range(257)}
    class Devices:
        def __enter__(self):
            names = list(devices)
            if scenario == "bootstrap-drm-unassigned-device":
                names += ["card9999", "card0-HDMI-A-1"]
            if scenario == "bootstrap-drm-sysfs-too-many":
                names += ["connector"] * 32768
            return iter(types.SimpleNamespace(name=name) for name in names)
        def __exit__(self, *_args): pass
    def device_metadata(name):
        if name not in devices: raise FileNotFoundError(name)
        gid, minor = devices[name]
        mode = stat.S_IFCHR | 0o660
        if scenario == "bootstrap-drm-node-symlink": mode = stat.S_IFLNK | 0o777
        if scenario == "bootstrap-drm-regular-file": mode = stat.S_IFREG | 0o660
        if scenario == "bootstrap-drm-world-rw": mode = stat.S_IFCHR | 0o666
        return types.SimpleNamespace(
            st_mode=mode,
            st_uid=1001 if scenario == "bootstrap-drm-device-owner" else 1000,
            st_gid=0 if scenario == "bootstrap-drm-device-root-group" else gid,
            st_rdev=os.makedev(1 if scenario == "bootstrap-drm-wrong-major" else 226,
                minor + 1 if scenario == "bootstrap-drm-wrong-minor" else minor),
        )
    def scan_devices(fd):
        return Devices() if isinstance(fd, int) and real_fstat(fd).st_ino == sysfs_inode else real_scandir(fd)
    guard.os.open, guard.os.fstat, guard.os.scandir = open_device, directory_metadata, scan_devices
    fields = {
        "Uid": "1000 1000 1000 1000", "Gid": "1000 1000 1000 1000",
        "Groups": "", "NoNewPrivs": "1", "NSpid": "1",
        **{key: "0000000000000000" for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")},
    }
    if scenario in fields:
        fields[scenario] = "1" if scenario.startswith("Cap") else {
            "Uid": "1000 1000 0 1000", "Gid": "1000 1000 0 1000",
            "Groups": "1000", "NoNewPrivs": "0", "NSpid": "2",
        }[scenario]
    if scenario in ("bootstrap-primary-group", "runtime-bootstrap-primary-group"):
        fields["Groups"] = "1000"
    if scenario == "bootstrap-extra-group":
        fields["Groups"] = "1000 1001"
    if scenario == "bootstrap-root-group":
        fields["Groups"] = "0"
    if scenario == "bootstrap-repeated-group":
        fields["Groups"] = "1000 1000"
    if "drm" in scenario:
        fields["Groups"] = "44 992 1000"
    if scenario == "bootstrap-drm-unexplained":
        fields["Groups"] += " 1001"
    if scenario == "bootstrap-drm-repeated":
        fields["Groups"] += " 44"
    status = "".join(f"{key}:\t{value}\n" for key, value in fields.items())
    if scenario == "duplicate-field":
        status += "NoNewPrivs:\t1\n"
    if scenario == "missing-field":
        status = status.replace("CapAmb:\t0000000000000000\n", "")
    bootstrap = b"/.openshell/channel/sandbox/bootstrap.json"
    argv = b"\0".join((guard.OPENSHELL_SUPERVISOR_ARGV0, b"launch-capability-free", b"1000", b"1000", bootstrap, b"/sandbox")) + b"\0"
    if scenario.startswith("bootstrap"):
        argv = guard.OPENSHELL_SUPERVISOR_ARGV0 + b"\0--bootstrap\0" + bootstrap + b"\0"
    if scenario.startswith("runtime-bootstrap"):
        argv = b"/.openshell/runtime/openshell-sandbox\0--bootstrap\0" + bootstrap + b"\0"
    if scenario == "argv":
        argv += b"foreign\0"
    def process(pid, parent, status, argv):
        directory = proc / str(pid)
        directory.mkdir()
        values = ["S", str(parent)] + ["0"] * 17 + [str(100 + pid)]
        (directory / "stat").write_text(f"{pid} (fixture) " + " ".join(values))
        (directory / "status").write_text(status)
        (directory / "cmdline").write_bytes(argv)
    process(1, 0, status, argv)
    process(20, 1, "Uid:\t1000 1000 1000 1000\nNSpid:\t20\n", b"/usr/bin/bash\0/usr/local/bin/nemoclaw-start\0")
    # Model Linux nondumpable proc status ownership without requiring root in unit tests.
    real_stat = guard.os.stat
    pid1_inode = real_stat(proc / "1").st_ino
    def metadata(name, **kwargs):
        if isinstance(name, str) and name.startswith(("card", "renderD")):
            assert kwargs == {"dir_fd": kwargs["dir_fd"], "follow_symlinks": False}
            assert real_fstat(kwargs["dir_fd"]).st_ino == dri_inode
            return device_metadata(name)
        observed = real_stat(name, **kwargs)
        if name == "status" and os.fstat(kwargs["dir_fd"]).st_ino == pid1_inode:
            values = list(observed)
            values[4] = 1000 if scenario == "status-uid" else 0
            values[5] = 1000 if scenario == "status-gid" else 0
            if scenario == "status-type":
                values[0] = stat.S_IFLNK | 0o777
            return os.stat_result(values)
        return observed
    guard.os.stat = metadata
    outcomes = {}
    for action, startup_owner in (("ensure-api-key", True), ("write-config", False)):
        try:
            guard._validate_action_readiness(action, startup_owner)
            outcomes[action] = True
        except guard.UnsafePathError:
            outcomes[action] = False
    print(json.dumps(outcomes))
    guard.os.open, guard.os.fstat, guard.os.scandir = real_open, real_fstat, real_scandir
    guard.os.stat = real_stat
    if real_path_flag is None: del guard.os.O_PATH
    else: guard.os.O_PATH = real_path_flag
`;

describe("Hermes capability-free supervisor authority", () => {
  it.each([
    ["rootless", true],
    ["bootstrap", true],
    ["runtime-bootstrap", true],
    ["bootstrap-primary-group", true],
    ["runtime-bootstrap-primary-group", true],
    ["bootstrap-drm", true],
    ["runtime-bootstrap-drm", true],
    ["rootless-drm", false],
    ["bootstrap-drm-parent-symlink", false],
    ["bootstrap-drm-directory-symlink", false],
    ["bootstrap-drm-directory-owner", false],
    ["bootstrap-drm-directory-group", false],
    ["bootstrap-drm-directory-writable", false],
    ["bootstrap-drm-node-symlink", false],
    ["bootstrap-drm-regular-file", false],
    ["bootstrap-drm-world-rw", false],
    ["bootstrap-drm-device-owner", false],
    ["bootstrap-drm-device-root-group", false],
    ["bootstrap-drm-wrong-major", false],
    ["bootstrap-drm-wrong-minor", false],
    ["bootstrap-drm-too-many", false],
    ["bootstrap-drm-extended-minors", true],
    ["bootstrap-drm-unassigned-device", true],
    ["bootstrap-drm-sysfs-unreadable", false],
    ["bootstrap-drm-sysfs-symlink", false],
    ["bootstrap-drm-sysfs-owner", false],
    ["bootstrap-drm-sysfs-group", false],
    ["bootstrap-drm-sysfs-writable", false],
    ["bootstrap-drm-sysfs-too-many", false],
    ["bootstrap-drm-unexplained", false],
    ["bootstrap-drm-repeated", false],
    ["bootstrap-extra-group", false],
    ["bootstrap-root-group", false],
    ["bootstrap-repeated-group", false],
    ["argv", false],
    ["status-uid", false],
    ["status-gid", false],
    ["status-type", false],
    ["Uid", false],
    ["Gid", false],
    ["Groups", false],
    ["NoNewPrivs", false],
    ["NSpid", false],
    ["CapInh", false],
    ["CapPrm", false],
    ["CapEff", false],
    ["CapBnd", false],
    ["CapAmb", false],
    ["duplicate-field", false],
    ["missing-field", false],
  ] as const)("gates startup and host config actions for %s", (scenario, allowed) => {
    const result = spawnSync("python3", ["-c", harness, guardPath, scenario], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      "ensure-api-key": allowed,
      "write-config": allowed,
    });
  });
});
