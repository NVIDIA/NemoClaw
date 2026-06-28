// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const IDENTITY_HARNESS = String.raw`
import importlib.util
import json
import os
import sys
import tempfile

spec = importlib.util.spec_from_file_location("runtime_guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guard
spec.loader.exec_module(guard)

def write_process(
    proc_root,
    pid,
    start_time,
    cmdline,
    namespace_path,
    effective_uid=0,
    inner_pid=1,
):
    process_dir = os.path.join(proc_root, str(pid))
    os.makedirs(os.path.join(process_dir, "ns"))
    fields = ["S"] + (["0"] * 18) + [str(start_time)]
    with open(os.path.join(process_dir, "stat"), "w", encoding="ascii") as stream:
        stream.write(f"{pid} (nemoclaw) {' '.join(fields)}\n")
    with open(os.path.join(process_dir, "cmdline"), "wb") as stream:
        stream.write(cmdline)
    with open(os.path.join(process_dir, "status"), "w", encoding="ascii") as stream:
        stream.write(
            f"Uid:\t{effective_uid}\t{effective_uid}\t{effective_uid}\t{effective_uid}\n"
            f"NSpid:\t{pid}\t{inner_pid}\n"
        )
    os.link(namespace_path, os.path.join(process_dir, "ns", "pid"))

def scenario(
    processes,
    expected_start="424242",
    expected_namespace="trusted",
    limit=32768,
):
    with tempfile.TemporaryDirectory() as root:
        proc_root = os.path.join(root, "proc")
        os.mkdir(proc_root)
        namespaces = {}
        for name in {"trusted", "other"}:
            namespace_path = os.path.join(root, name)
            with open(namespace_path, "wb") as stream:
                stream.write(name.encode("ascii"))
            namespaces[name] = namespace_path
        for process in processes:
            pid, start_time, cmdline, namespace, *identity = process
            write_process(
                proc_root,
                pid,
                start_time,
                cmdline,
                namespaces[namespace],
                *identity,
            )
        guard.PROC_ROOT = proc_root
        guard.MAX_PROC_ENTRIES = limit
        return guard._startup_process_identity_is_live(
            expected_start,
            os.stat(namespaces[expected_namespace]).st_ino,
        )

entrypoint = b"bash\0/usr/local/bin/nemoclaw-start\0"
spoof = b"bash\0/tmp/nemoclaw-start-spoof\0"
proof = {
    "remapped": scenario([(412, "424242", entrypoint, "trusted")]),
    "stale": scenario([(412, "999999", entrypoint, "trusted")]),
    "spoof": scenario([(412, "424242", spoof, "trusted")]),
    "nonroot": scenario([(412, "424242", entrypoint, "trusted", 1000)]),
    "noninit": scenario([(412, "424242", entrypoint, "trusted", 0, 2)]),
    "wrong_namespace": scenario([(412, "424242", entrypoint, "other")]),
    "duplicate": scenario([
        (412, "424242", entrypoint, "trusted"),
        (413, "424242", entrypoint, "trusted"),
    ]),
    "bounded": scenario([
        (412, "424242", entrypoint, "trusted"),
        (413, "999999", spoof, "other"),
    ], limit=1),
}
print(json.dumps(proof))
`;

const GUARDS = [
  ["OpenClaw", path.resolve("scripts/openclaw-config-guard.py")],
  ["Hermes", path.resolve("agents/hermes/runtime-config-guard.py")],
] as const;

describe.each(GUARDS)("%s startup process identity", (_name, guardPath) => {
  it("authenticates exactly one root namespace init and rejects stale or spoofed identities (#2426)", () => {
    const result = spawnSync("python3", ["-c", IDENTITY_HARNESS, guardPath], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      remapped: true,
      stale: false,
      spoof: false,
      nonroot: false,
      noninit: false,
      wrong_namespace: false,
      duplicate: false,
      bounded: false,
    });
  });
});
