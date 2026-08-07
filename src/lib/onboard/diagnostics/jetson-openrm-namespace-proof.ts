// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DockerGpuPatchDeps } from "../docker-gpu-patch-types";

const PROOF_TIMEOUT_MS = 30_000;
const CUDA_RESULT_PATTERN = /cuInit\(0\)=(-?\d+)/u;

const NAMESPACE_BOUNDARY_PROBE = String.raw`
import ctypes
import errno
import glob
import os
import pwd
import resource
import stat
import sys

mode = sys.argv[1]
libc = ctypes.CDLL(None, use_errno=True)

def checked_call(name, *args):
    ctypes.set_errno(0)
    rc = getattr(libc, name)(*args)
    if rc != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))

def drop_bounding_set():
    for capability in range(64):
        ctypes.set_errno(0)
        rc = libc.prctl(24, capability, 0, 0, 0)
        error = ctypes.get_errno()
        if rc != 0 and error != errno.EINVAL:
            raise OSError(error, os.strerror(error))

def find_openshell_workload():
    self_net = os.stat("/proc/self/ns/net").st_ino
    candidates = []
    for entry in os.scandir("/proc"):
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            with open(f"/proc/{pid}/status", encoding="utf8") as status_file:
                uid_line = next(line for line in status_file if line.startswith("Uid:"))
            if int(uid_line.split()[1]) != 998:
                continue
            net_inode = os.stat(f"/proc/{pid}/ns/net").st_ino
            if net_inode == self_net:
                continue
            with open(f"/proc/{pid}/cmdline", "rb") as command_file:
                command = command_file.read().replace(b"\\0", b" ").decode("utf8", "replace")
            priority = 0 if "openclaw" in command or "node" in command else 1
            candidates.append((priority, pid, net_inode, command[:160]))
        except (OSError, StopIteration, ValueError):
            continue
    if not candidates:
        raise RuntimeError("no sandbox workload in a distinct network namespace")
    return sorted(candidates)[0]

target = None
if "namespace" in mode:
    target = find_openshell_workload()
    _, target_pid, target_net, target_command = target
    print(f"namespace_target=pid:{target_pid} net:{target_net} command:{target_command}")
    if "net" in mode:
        with open(f"/proc/{target_pid}/ns/net", "rb", buffering=0) as namespace:
            checked_call("setns", namespace.fileno(), 0x40000000)
    if "mount" in mode:
        with open(f"/proc/{target_pid}/ns/mnt", "rb", buffering=0) as namespace:
            checked_call("setns", namespace.fileno(), 0x00020000)

if "process-group" in mode:
    os.setpgid(0, 0)
if "hardening" in mode:
    drop_bounding_set()

account = pwd.getpwnam("sandbox")
groups = {account.pw_gid}
for pattern in ("/dev/nvmap", "/dev/nvhost-*", "/dev/dri/renderD*", "/dev/dri/card*"):
    for device in glob.glob(pattern):
        try:
            device_stat = os.stat(device)
        except OSError:
            continue
        if stat.S_ISCHR(device_stat.st_mode) and device_stat.st_gid > 0:
            groups.add(device_stat.st_gid)
os.setgroups(sorted(groups))
os.setgid(account.pw_gid)
os.setuid(account.pw_uid)
checked_call("prctl", 4, 1, 0, 0, 0)

if "hardening" in mode:
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    checked_call("prctl", 4, 0, 0, 0, 0)
    checked_call("prctl", 38, 1, 0, 0, 0)

cuda = ctypes.CDLL("libcuda.so.1")
cuda.cuInit.argtypes = [ctypes.c_uint]
cuda.cuInit.restype = ctypes.c_int
result = cuda.cuInit(0)
print(f"cuInit(0)={result}")
raise SystemExit(0 if result == 0 else 1)
`.trim();

type DockerRun = NonNullable<DockerGpuPatchDeps["dockerRun"]>;

function runCase(containerId: string, mode: string, dockerRun: DockerRun): string {
  const result = dockerRun(
    ["exec", "--user", "0", containerId, "python3", "-c", NAMESPACE_BOUNDARY_PROBE, mode],
    { ignoreError: true, suppressOutput: true, timeout: PROOF_TIMEOUT_MS },
  );
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  const cuda = output.match(CUDA_RESULT_PATTERN)?.[1] ?? "missing";
  if (cuda === "missing") {
    console.error(
      `  namespace_case_error[${mode}]=${output.trim().replaceAll(/\s+/gu, " ").slice(0, 500) || "no output"}`,
    );
  }
  return cuda;
}

/** Compare direct Docker execution with the namespaces used by OpenShell workloads. */
export function runJetsonOpenRmNamespaceProof(containerId: string, dockerRun: DockerRun): void {
  const cases = [
    "baseline",
    "process-group",
    "net-namespace",
    "mount-namespace",
    "net-mount-namespace",
    "hardening-net-namespace",
    "hardening-mount-namespace",
    "hardening-net-mount-namespace",
  ];
  const results = new Map(cases.map((mode) => [mode, runCase(containerId, mode, dockerRun)]));

  console.log("");
  console.log("  === Jetson OpenRM namespace boundary matrix ===");
  console.log(
    cases.map((mode) => `${mode.replaceAll("-", "_")}_cuInit=${results.get(mode)}`).join(" "),
  );
  if (results.get("baseline") !== "0") {
    console.error("  INCONCLUSIVE: the direct-Docker namespace baseline did not pass.");
    return;
  }
  const isolated = cases.slice(1).filter((mode) => results.get(mode) === "801");
  if (isolated.length > 0) {
    console.log(`  ISOLATED: cuInit fails in OpenShell launch context(s): ${isolated.join(", ")}.`);
    return;
  }
  console.error(
    "  INCONCLUSIVE: filesystem access, modeled process controls, and workload namespaces all pass outside OpenShell.",
  );
}
