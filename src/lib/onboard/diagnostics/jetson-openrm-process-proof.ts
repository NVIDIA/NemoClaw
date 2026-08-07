// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DockerGpuPatchDeps } from "../docker-gpu-patch-types";

const PROOF_TIMEOUT_MS = 30_000;
const CUDA_RESULT_PATTERN = /cuInit\(0\)=(-?\d+)/u;

// OpenShell v0.0.85 blocks these syscalls unconditionally in its inherited
// supervisor prelude and runtime seccomp filters on aarch64. clone3 uses ENOSYS
// so libc can fall back to clone; the other denials use EPERM.
const OPEN_SHELL_BLOCKED_SYSCALLS = [
  ["umount2", 39, 1],
  ["mount", 40, 1],
  ["pivot_root", 41, 1],
  ["kexec_load", 104, 1],
  ["init_module", 105, 1],
  ["delete_module", 106, 1],
  ["ptrace", 117, 1],
  ["perf_event_open", 241, 1],
  ["setns", 268, 1],
  ["process_vm_readv", 270, 1],
  ["process_vm_writev", 271, 1],
  ["finit_module", 273, 1],
  ["memfd_create", 279, 1],
  ["bpf", 280, 1],
  ["userfaultfd", 282, 1],
  ["kexec_file_load", 294, 1],
  ["open_tree", 428, 1],
  ["move_mount", 429, 1],
  ["fsopen", 430, 1],
  ["fsconfig", 431, 1],
  ["fsmount", 432, 1],
  ["fspick", 433, 1],
  ["pidfd_open", 434, 1],
  ["clone3", 435, 38],
  ["pidfd_getfd", 438, 1],
  ["pidfd_send_signal", 424, 1],
  ["io_uring_setup", 425, 1],
] as const;

const OPEN_SHELL_CONDITIONAL_RULES = [
  "socket-af-packet",
  "socket-af-bluetooth",
  "socket-af-vsock",
  "socket-netlink-non-route",
  "execveat-empty-path",
  "unshare-newuser",
  "clone-newuser",
  "seccomp-set-filter",
] as const;

const PROCESS_BOUNDARY_PROBE = String.raw`
import ctypes
import errno
import glob
import os
import pwd
import resource
import stat
import sys

mode = sys.argv[1]
blocked = {
${OPEN_SHELL_BLOCKED_SYSCALLS.map(([name, number, error]) => `    ${JSON.stringify(name)}: (${String(number)}, ${String(error)}),`).join("\n")}
}
conditional = {
    "socket-af-packet": ("eq", 198, 0, 17),
    "socket-af-bluetooth": ("eq", 198, 0, 31),
    "socket-af-vsock": ("eq", 198, 0, 40),
    "socket-netlink-non-route": ("netlink", 198, 0, 16),
    "execveat-empty-path": ("masked", 281, 4, 0x1000),
    "unshare-newuser": ("masked", 97, 0, 0x10000000),
    "clone-newuser": ("masked", 220, 0, 0x10000000),
    "seccomp-set-filter": ("eq", 277, 0, 1),
}

libc = ctypes.CDLL(None, use_errno=True)

def prctl(option, arg2=0, arg3=0, arg4=0, arg5=0, allow_einval=False):
    ctypes.set_errno(0)
    rc = libc.prctl(
        ctypes.c_int(option),
        ctypes.c_ulong(arg2),
        ctypes.c_ulong(arg3),
        ctypes.c_ulong(arg4),
        ctypes.c_ulong(arg5),
    )
    error = ctypes.get_errno()
    if rc != 0 and not (allow_einval and error == errno.EINVAL):
        raise OSError(error, os.strerror(error))
    return rc

def prctl_get(option):
    ctypes.set_errno(0)
    rc = libc.prctl(ctypes.c_int(option), 0, 0, 0, 0)
    if rc < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return rc

def drop_bounding_set():
    for capability in range(64):
        prctl(24, capability, allow_einval=True)

def drop_to_sandbox():
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

class SockFilter(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_ushort),
        ("jt", ctypes.c_ubyte),
        ("jf", ctypes.c_ubyte),
        ("k", ctypes.c_uint),
    ]

class SockFprog(ctypes.Structure):
    _fields_ = [
        ("length", ctypes.c_ushort),
        ("filters", ctypes.POINTER(SockFilter)),
    ]

def install_filter(denials, conditional_denials):
    instructions = [(0x20, 0, 0, 0)]
    for syscall_number, syscall_errno in denials:
        instructions.append((0x15, 0, 1, syscall_number))
        instructions.append((0x06, 0, 0, 0x00050000 | syscall_errno))
    for kind, syscall_number, arg_index, value in conditional_denials:
        instructions.append((0x20, 0, 0, 0))
        if kind == "masked":
            instructions.append((0x15, 0, 4, syscall_number))
            instructions.append((0x20, 0, 0, 16 + (arg_index * 8)))
            instructions.append((0x54, 0, 0, value))
            instructions.append((0x15, 0, 1, value))
        elif kind == "netlink":
            instructions.append((0x15, 0, 5, syscall_number))
            instructions.append((0x20, 0, 0, 16))
            instructions.append((0x15, 0, 3, value))
            instructions.append((0x20, 0, 0, 32))
            instructions.append((0x15, 1, 0, 0))
        else:
            instructions.append((0x15, 0, 3, syscall_number))
            instructions.append((0x20, 0, 0, 16 + (arg_index * 8)))
            instructions.append((0x15, 0, 1, value))
        instructions.append((0x06, 0, 0, 0x00050001))
    instructions.append((0x06, 0, 0, 0x7fff0000))
    filters = (SockFilter * len(instructions))(
        *(SockFilter(*instruction) for instruction in instructions)
    )
    program = SockFprog(len(instructions), filters)
    prctl(38, 1)
    prctl(22, 2, ctypes.addressof(program))

drop_caps = mode in (
    "empty-capability-bounding",
    "openshell-hardening",
    "hardening-plus-openshell-seccomp",
) or mode == "empty-capability-bounding-plus-openshell-seccomp"
if drop_caps:
    drop_bounding_set()
drop_to_sandbox()
prctl(4, 1)

if mode in ("core-zero", "openshell-hardening", "hardening-plus-openshell-seccomp", "core-zero-plus-openshell-seccomp"):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
if mode in ("nondumpable", "openshell-hardening", "hardening-plus-openshell-seccomp", "nondumpable-plus-openshell-seccomp"):
    prctl(4, 0)
if mode in ("no-new-privs", "openshell-hardening", "hardening-plus-openshell-seccomp", "no-new-privs-plus-openshell-seccomp"):
    prctl(38, 1)

denials = []
conditional_denials = []
if mode.startswith("deny-"):
    rule = mode.removeprefix("deny-")
    if rule in blocked:
        denials = [blocked[rule]]
    else:
        conditional_denials = [conditional[rule]]
elif mode == "openshell-seccomp" or mode.endswith("-plus-openshell-seccomp"):
    denials = list(blocked.values())
    conditional_denials = list(conditional.values())
if mode == "allow-all-seccomp" or denials or conditional_denials:
    install_filter(denials, conditional_denials)

status = {}
with open("/proc/self/status", encoding="utf8") as status_file:
    for line in status_file:
        key, _, value = line.partition(":")
        if key in ("Uid", "Gid", "Groups", "CapBnd", "NoNewPrivs", "Seccomp", "Seccomp_filters"):
            status[key] = value.strip()
print("process_status=" + "; ".join(f"{key}={value}" for key, value in status.items()))
print(f"dumpable={prctl_get(3)} core_limit={resource.getrlimit(resource.RLIMIT_CORE)[0]}")

cuda = ctypes.CDLL("libcuda.so.1")
cuda.cuInit.argtypes = [ctypes.c_uint]
cuda.cuInit.restype = ctypes.c_int
result = cuda.cuInit(0)
print(f"cuInit(0)={result}")
raise SystemExit(0 if result == 0 else 1)
`.trim();

type DockerRun = NonNullable<DockerGpuPatchDeps["dockerRun"]>;

function cudaResult(value: string): string {
  return value.match(CUDA_RESULT_PATTERN)?.[1] ?? "missing";
}

function runCase(containerId: string, mode: string, dockerRun: DockerRun): string {
  const result = dockerRun(
    ["exec", "--user", "0", containerId, "python3", "-c", PROCESS_BOUNDARY_PROBE, mode],
    { ignoreError: true, suppressOutput: true, timeout: PROOF_TIMEOUT_MS },
  );
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  const cuda = cudaResult(output);
  if (cuda === "missing") {
    console.error(
      `  process_case_error[${mode}]=${output.trim().replaceAll(/\s+/gu, " ").slice(0, 500) || "no output"}`,
    );
  }
  return cuda;
}

/** Isolate the process controls that differ between direct Docker and OpenShell. */
export function runJetsonOpenRmProcessProof(containerId: string, dockerRun: DockerRun): void {
  const fixedCases = [
    "baseline",
    "no-new-privs",
    "nondumpable",
    "core-zero",
    "empty-capability-bounding",
    "allow-all-seccomp",
    "openshell-hardening",
  ];
  const results = new Map(fixedCases.map((mode) => [mode, runCase(containerId, mode, dockerRun)]));

  console.log("");
  console.log("  === Jetson OpenRM process boundary matrix ===");
  console.log(
    fixedCases.map((mode) => `${mode.replaceAll("-", "_")}_cuInit=${results.get(mode)}`).join(" "),
  );
  if (results.get("baseline") !== "0") {
    console.error("  INCONCLUSIVE: the direct-Docker process probe baseline did not pass.");
    return;
  }
  const isolatedHardening = fixedCases.slice(1, 5).filter((mode) => results.get(mode) === "801");
  if (isolatedHardening.length > 0) {
    console.log(`  ISOLATED: cuInit fails after ${isolatedHardening.join(", ")}.`);
    return;
  }
  if (results.get("allow-all-seccomp") === "801") {
    console.log("  ISOLATED: cuInit fails when any additional seccomp filter is installed.");
    return;
  }
  if (results.get("openshell-hardening") === "801") {
    console.log(
      "  ISOLATED: cuInit fails only when the non-seccomp process controls are combined.",
    );
    return;
  }

  const exactSeccomp = runCase(containerId, "openshell-seccomp", dockerRun);
  console.log(`  openshell_seccomp_cuInit=${exactSeccomp}`);
  if (exactSeccomp === "801") {
    const rules = [
      ...OPEN_SHELL_BLOCKED_SYSCALLS.map(([name]) => name),
      ...OPEN_SHELL_CONDITIONAL_RULES,
    ];
    const ruleResults = new Map(
      rules.map((name) => [name, runCase(containerId, `deny-${name}`, dockerRun)]),
    );
    console.log(
      `  seccomp_rule_cuInit=${[...ruleResults].map(([name, result]) => `${name}:${result}`).join(",")}`,
    );
    const isolatedRules = [...ruleResults]
      .filter(([, result]) => result === "801")
      .map(([name]) => name);
    if (isolatedRules.length > 0) {
      console.log(
        `  ISOLATED: OpenShell blocks CUDA-required rule(s): ${isolatedRules.join(", ")}.`,
      );
    } else {
      console.log("  ISOLATED: CUDA requires a combination of OpenShell seccomp rules.");
    }
    return;
  }

  const full = runCase(containerId, "hardening-plus-openshell-seccomp", dockerRun);
  console.log(`  hardening_plus_openshell_seccomp_cuInit=${full}`);
  if (full === "801") {
    const hardening = ["no-new-privs", "nondumpable", "core-zero", "empty-capability-bounding"];
    const interactionResults = new Map(
      hardening.map((name) => [
        name,
        runCase(containerId, `${name}-plus-openshell-seccomp`, dockerRun),
      ]),
    );
    console.log(
      `  hardening_seccomp_interaction_cuInit=${[...interactionResults].map(([name, result]) => `${name}:${result}`).join(",")}`,
    );
    const isolatedInteractions = [...interactionResults]
      .filter(([, result]) => result === "801")
      .map(([name]) => name);
    console.log(
      isolatedInteractions.length > 0
        ? `  ISOLATED: CUDA fails when OpenShell seccomp is combined with ${isolatedInteractions.join(", ")}.`
        : "  ISOLATED: CUDA requires the combined OpenShell hardening and seccomp state.",
    );
    return;
  }
  console.error(
    "  INCONCLUSIVE: the complete OpenShell process-control model passes; Landlock or an unmodeled launch difference remains.",
  );
}
