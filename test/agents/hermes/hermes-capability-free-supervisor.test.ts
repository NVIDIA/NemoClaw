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
    status = "".join(f"{key}:\t{value}\n" for key, value in fields.items())
    if scenario == "duplicate-field":
        status += "NoNewPrivs:\t1\n"
    if scenario == "missing-field":
        status = status.replace("CapAmb:\t0000000000000000\n", "")
    bootstrap = b"/.openshell/channel/sandbox/bootstrap.json"
    argv = b"\0".join((guard.OPENSHELL_SUPERVISOR_ARGV0, b"launch-capability-free", b"1000", b"1000", bootstrap, b"/sandbox")) + b"\0"
    if scenario == "bootstrap":
        argv = guard.OPENSHELL_SUPERVISOR_ARGV0 + b"\0--bootstrap\0" + bootstrap + b"\0"
    if scenario == "runtime-bootstrap":
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
`;

describe("Hermes capability-free supervisor authority", () => {
  it.each([
    ["rootless", true],
    ["bootstrap", true],
    ["runtime-bootstrap", true],
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
