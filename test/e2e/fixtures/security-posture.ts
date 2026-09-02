// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  RuntimeProviderPrivilegedSandboxCommandResult,
  RuntimeProviderPrivilegedSandboxTarget,
} from "../../../src/lib/onboard/runtime-provider/contract.ts";
import {
  executePrivilegedSandboxCommand,
  resolvePrivilegedSandboxTarget,
} from "../../../src/lib/sandbox/privileged-exec.ts";
import { buildAvailabilityProbeEnv } from "./availability-env.ts";
import type { HostCliClient } from "./clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "./clients/sandbox.ts";
import type { ShellProbeResult } from "./shell-probe.ts";

export type SecurityPostureAgent = "hermes" | "openclaw";

export interface ProcessSecurityStatus {
  capAmb: string;
  capBnd: string;
  capEff: string;
  capInh: string;
  capPrm: string;
  gid: string[];
  groups: string[];
  noNewPrivs: string;
  uid: string[];
}

export interface ProcessSecurityIdentity {
  argv: string[];
  executable: string;
  pid: number;
  ppid: number;
  state: string;
  startTime: string;
  status: ProcessSecurityStatus;
}

export interface SplitProcessSecurityReport {
  childSupervisors: ProcessSecurityIdentity[];
  observedChildSupervisors: ProcessSecurityIdentity[];
  observedProcEntries: number;
  sandboxGid: number;
  sandboxUid: number;
  supervisor: ProcessSecurityIdentity;
  version: 2;
}

export interface SecurityPostureSummary {
  configureGuard: true;
  hostNonRoot: true;
  rcFilesLocked: true;
  runtimeProxyEnvLocked: true;
  splitProcess: {
    childSupervisor: ProcessSecurityIdentity;
    supervisor: ProcessSecurityIdentity;
  };
  startupLogClean: true;
}

export interface SecurityPostureExpectations {
  enabled: boolean;
  openshellSplitProcess: boolean;
}

export interface SecurityPostureDependencies {
  executePrivilegedCommand?: typeof executePrivilegedSandboxCommand;
  resolvePrivilegedTarget?: typeof resolvePrivilegedSandboxTarget;
}

const OPENSHELL_SUPERVISOR_EXECUTABLE = "/opt/openshell/bin/openshell-sandbox";
const OPENSHELL_SUPERVISOR_ARGV = [
  OPENSHELL_SUPERVISOR_EXECUTABLE,
  "--workdir",
  "/sandbox",
] as const;
const SYSTEM_BASH_EXECUTABLES = ["/bin/bash", "/usr/bin/bash"] as const;
const NEMOCLAW_START_SUPERVISOR_PATHS = [
  "nemoclaw-start",
  "/usr/local/bin/nemoclaw-start",
] as const;
const BASH_ARGV0 = ["bash", ...SYSTEM_BASH_EXECUTABLES] as const;
const LIVE_PROCESS_STATES = ["D", "R", "S"] as const;
const MAX_PROC_ENTRIES = 32_768;
const MAX_CENSUS_STABILITY_ATTEMPTS = 4;
const MAX_CENSUS_DIAGNOSTIC_IDENTITIES = 16;
// The pinned OpenShell supervisor has the Docker default capabilities plus
// NET_ADMIN, SYS_ADMIN, SYS_PTRACE, and SYSLOG. Freeze the
// resulting Linux capability mask so additions and removals both require an
// explicit security review.
export const OPENSHELL_SUPERVISOR_CAPABILITY_MASK = "00000004a82c35fb";
export const PODMAN_OPENSHELL_SUPERVISOR_CAPABILITY_MASK = "00000004002811cd";

const OPENSHELL_SUPERVISOR_CAPABILITY_MASKS = Object.freeze({
  docker: OPENSHELL_SUPERVISOR_CAPABILITY_MASK,
  podman: PODMAN_OPENSHELL_SUPERVISOR_CAPABILITY_MASK,
});

function supervisorCapabilityMask(providerId: string): string {
  const mask = OPENSHELL_SUPERVISOR_CAPABILITY_MASKS[
    providerId as keyof typeof OPENSHELL_SUPERVISOR_CAPABILITY_MASKS
  ];
  if (!mask) {
    throw new Error(`security-posture has no reviewed capability mask for '${providerId}'`);
  }
  return mask;
}

export const SPLIT_PROCESS_SECURITY_PROBE = String.raw`import grp
import json
import os
from pathlib import Path
import pwd

PROC_ROOT = Path("/proc")
MAX_PROC_ENTRIES = ${MAX_PROC_ENTRIES}
MAX_CENSUS_STABILITY_ATTEMPTS = ${MAX_CENSUS_STABILITY_ATTEMPTS}
MAX_CENSUS_DIAGNOSTIC_IDENTITIES = ${MAX_CENSUS_DIAGNOSTIC_IDENTITIES}
OPENSHELL_SUPERVISOR_ARGV = tuple(item.encode("utf-8") for item in ${JSON.stringify(OPENSHELL_SUPERVISOR_ARGV)})
OPENSHELL_SUPERVISOR_EXECUTABLE = ${JSON.stringify(OPENSHELL_SUPERVISOR_EXECUTABLE)}
NEMOCLAW_START_SUPERVISOR = tuple(item.encode("utf-8") for item in ${JSON.stringify(NEMOCLAW_START_SUPERVISOR_PATHS)})
BASH = tuple(item.encode("utf-8") for item in ${JSON.stringify(BASH_ARGV0)})
SYSTEM_BASH_EXECUTABLES = set(${JSON.stringify(SYSTEM_BASH_EXECUTABLES)})
LIVE_PROCESS_STATES = set(${JSON.stringify(LIVE_PROCESS_STATES)})

def argv_for(path):
    raw = (path / "cmdline").read_bytes()
    if not raw:
        return ()
    if not raw.endswith(b"\0"):
        raise RuntimeError("process command line is not terminated")
    return tuple(raw[:-1].split(b"\0"))

def is_nemoclaw_start_supervisor(argv):
    return (
        (len(argv) == 1 and argv[0] in NEMOCLAW_START_SUPERVISOR)
        or (
            len(argv) == 2
            and argv[0] in BASH
            and argv[1] in NEMOCLAW_START_SUPERVISOR
        )
    )

def stat_identity(raw):
    suffix = raw.rsplit(") ", 1)
    if len(suffix) != 2:
        raise RuntimeError("malformed proc stat record")
    fields = suffix[1].split()
    if len(fields) < 20:
        raise RuntimeError("incomplete proc stat record")
    return fields[0], int(fields[1], 10), fields[19]

def selected_status(raw):
    values = {}
    for line in raw.splitlines():
        name, separator, value = line.partition(":")
        if separator:
            values[name] = value.strip().split()
    return {
        "uid": values.get("Uid", []),
        "gid": values.get("Gid", []),
        "groups": values.get("Groups", []),
        "capInh": (values.get("CapInh") or [""])[0],
        "capPrm": (values.get("CapPrm") or [""])[0],
        "capEff": (values.get("CapEff") or [""])[0],
        "capBnd": (values.get("CapBnd") or [""])[0],
        "capAmb": (values.get("CapAmb") or [""])[0],
        "noNewPrivs": (values.get("NoNewPrivs") or [""])[0],
    }

def stable_process(pid):
    path = PROC_ROOT / str(pid)
    before = os.stat(path, follow_symlinks=False)
    first_state, first_ppid, first_start_time = stat_identity(
        (path / "stat").read_text(encoding="utf-8")
    )
    first_status = selected_status((path / "status").read_text(encoding="utf-8"))
    first_argv = argv_for(path)
    first_executable = os.readlink(path / "exe")
    second_state, second_ppid, second_start_time = stat_identity(
        (path / "stat").read_text(encoding="utf-8")
    )
    second_status = selected_status((path / "status").read_text(encoding="utf-8"))
    second_argv = argv_for(path)
    second_executable = os.readlink(path / "exe")
    after = os.stat(path, follow_symlinks=False)
    if first_state not in LIVE_PROCESS_STATES or second_state not in LIVE_PROCESS_STATES:
        raise RuntimeError(f"process {pid} is not live")
    if (
        before.st_dev != after.st_dev
        or before.st_ino != after.st_ino
        or first_ppid != second_ppid
        or first_start_time != second_start_time
        or first_status != second_status
        or first_argv != second_argv
        or first_executable != second_executable
    ):
        raise RuntimeError(f"process {pid} changed during inspection")
    return {
        "pid": int(pid),
        "ppid": second_ppid,
        "state": second_state,
        "startTime": second_start_time,
        "argv": [item.decode("utf-8", "strict") for item in first_argv],
        "executable": first_executable,
        "status": first_status,
    }

def child_supervisor_census():
    observed = 0
    matches = []
    with os.scandir(PROC_ROOT) as entries:
        for entry in entries:
            if not entry.name.isascii() or not entry.name.isdigit():
                continue
            observed += 1
            if observed > MAX_PROC_ENTRIES:
                raise RuntimeError("process census exceeded its checked bound")
            try:
                selected_path = Path(entry.path)
                _, _, selected_start_time = stat_identity(
                    (selected_path / "stat").read_text(encoding="utf-8")
                )
                selected_argv = argv_for(selected_path)
            except (FileNotFoundError, ProcessLookupError):
                continue
            if is_nemoclaw_start_supervisor(selected_argv):
                process = stable_process(entry.name)
                stable_argv = tuple(item.encode("utf-8") for item in process["argv"])
                if (
                    process["startTime"] != selected_start_time
                    or stable_argv != selected_argv
                    or not is_nemoclaw_start_supervisor(stable_argv)
                    or process["executable"] not in SYSTEM_BASH_EXECUTABLES
                ):
                    raise RuntimeError(
                        "nemoclaw-start process changed after census selection"
                    )
                matches.append(process)
    return observed, matches

def stable_security_identity(process):
    return {name: value for name, value in process.items() if name != "state"}

def process_identity_key(process):
    return process["pid"], int(process["startTime"])

def canonical_security_identities(processes):
    return sorted(
        (stable_security_identity(process) for process in processes),
        key=process_identity_key,
    )

def diagnostic_census(processes):
    identities = sorted(
        (
            {
                "pid": process["pid"],
                "ppid": process["ppid"],
                "startTime": process["startTime"],
            }
            for process in processes
        ),
        key=process_identity_key,
    )
    return {
        "count": len(identities),
        "identities": identities[:MAX_CENSUS_DIAGNOSTIC_IDENTITIES],
        "truncated": len(identities) > MAX_CENSUS_DIAGNOSTIC_IDENTITIES,
    }

def changed_identity_fields(first, second):
    return [
        name
        for name in ("ppid", "startTime", "argv", "executable", "status")
        if first[name] != second[name]
    ]

def remember_observed_processes(observed, observed_start_times, processes):
    for process in processes:
        key = process_identity_key(process)
        previous_start_time = observed_start_times.get(process["pid"])
        if previous_start_time is not None and previous_start_time != process["startTime"]:
            raise RuntimeError(
                f"nemoclaw-start process PID {process['pid']} was reused during census acquisition"
            )
        previous = observed.get(key)
        if (
            previous is not None
            and stable_security_identity(previous) != stable_security_identity(process)
        ):
            raise RuntimeError(
                "nemoclaw-start process identity changed across census attempts: "
                f"pid={process['pid']} "
                f"fields={','.join(changed_identity_fields(previous, process))}"
            )
        observed[key] = process
        observed_start_times[process["pid"]] = process["startTime"]
        if len(observed) > MAX_PROC_ENTRIES:
            raise RuntimeError("retained process census exceeded its checked bound")

def require_retained_process_bound(observed, observed_proc_entries):
    if len(observed) > observed_proc_entries:
        raise RuntimeError("retained process census exceeded the observed process bound")

def acquire_stable_child_supervisor_census():
    observed_proc_entries, first_processes = child_supervisor_census()
    observed_processes = {}
    observed_start_times = {}
    remember_observed_processes(
        observed_processes,
        observed_start_times,
        first_processes,
    )
    require_retained_process_bound(observed_processes, observed_proc_entries)
    first_identities = canonical_security_identities(first_processes)
    for attempt in range(2, MAX_CENSUS_STABILITY_ATTEMPTS + 1):
        next_observed_proc_entries, second_processes = child_supervisor_census()
        observed_proc_entries = max(observed_proc_entries, next_observed_proc_entries)
        remember_observed_processes(
            observed_processes,
            observed_start_times,
            second_processes,
        )
        require_retained_process_bound(observed_processes, observed_proc_entries)
        second_identities = canonical_security_identities(second_processes)
        if first_identities == second_identities:
            return (
                observed_proc_entries,
                sorted(second_processes, key=process_identity_key),
                sorted(observed_processes.values(), key=process_identity_key),
            )
        if attempt == MAX_CENSUS_STABILITY_ATTEMPTS:
            raise RuntimeError(
                "nemoclaw-start child supervisor census did not stabilize "
                f"after {MAX_CENSUS_STABILITY_ATTEMPTS} attempts: "
                f"first={json.dumps(diagnostic_census(first_processes), sort_keys=True)} "
                f"second={json.dumps(diagnostic_census(second_processes), sort_keys=True)}"
            )
        first_processes = second_processes
        first_identities = second_identities
    raise RuntimeError("nemoclaw-start child supervisor census did not run")

sandbox_user = pwd.getpwnam("sandbox")
sandbox_group = grp.getgrnam("sandbox")
sandbox_uid = sandbox_user.pw_uid
sandbox_gid = sandbox_group.gr_gid
if sandbox_user.pw_gid != sandbox_gid:
    raise RuntimeError("sandbox user and group identities disagree")
supervisor_before = stable_process(1)
(
    observed_proc_entries,
    child_supervisors,
    observed_child_supervisors,
) = acquire_stable_child_supervisor_census()
supervisor_after = stable_process(1)
if stable_security_identity(supervisor_before) != stable_security_identity(supervisor_after):
    raise RuntimeError("OpenShell supervisor changed during inspection")
if (
    tuple(supervisor_before["argv"]) != tuple(item.decode("ascii") for item in OPENSHELL_SUPERVISOR_ARGV)
    or supervisor_before["executable"] != OPENSHELL_SUPERVISOR_EXECUTABLE
):
    raise RuntimeError("unexpected OpenShell supervisor command")
if any(
    item["executable"] not in SYSTEM_BASH_EXECUTABLES
    for item in observed_child_supervisors
):
    raise RuntimeError("unexpected nemoclaw-start child supervisor executable")
print(json.dumps({
    "version": 2,
    "observedProcEntries": observed_proc_entries,
    "sandboxUid": sandbox_uid,
    "sandboxGid": sandbox_gid,
    "supervisor": supervisor_before,
    "childSupervisors": child_supervisors,
    "observedChildSupervisors": observed_child_supervisors,
}, sort_keys=True))`;

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function probeEnv(): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
}

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function requireSuccess(label: string, result: ShellProbeResult): void {
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit ${result.exitCode}:\n${resultText(result)}`);
  }
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function requiredInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} must be a safe integer greater than or equal to ${minimum}`);
  }
  return Number(value);
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

function processStatus(value: unknown, label: string): ProcessSecurityStatus {
  const status = requiredRecord(value, label);
  return {
    capAmb: requiredString(status.capAmb, `${label}.capAmb`),
    capBnd: requiredString(status.capBnd, `${label}.capBnd`),
    capEff: requiredString(status.capEff, `${label}.capEff`),
    capInh: requiredString(status.capInh, `${label}.capInh`),
    capPrm: requiredString(status.capPrm, `${label}.capPrm`),
    gid: requiredStringArray(status.gid, `${label}.gid`),
    groups: requiredStringArray(status.groups, `${label}.groups`),
    noNewPrivs: requiredString(status.noNewPrivs, `${label}.noNewPrivs`),
    uid: requiredStringArray(status.uid, `${label}.uid`),
  };
}

function processIdentity(value: unknown, label: string): ProcessSecurityIdentity {
  const process = requiredRecord(value, label);
  const identity = {
    argv: requiredStringArray(process.argv, `${label}.argv`),
    executable: requiredString(process.executable, `${label}.executable`),
    pid: requiredInteger(process.pid, `${label}.pid`, 1),
    ppid: requiredInteger(process.ppid, `${label}.ppid`, 0),
    state: requiredString(process.state, `${label}.state`),
    startTime: requiredString(process.startTime, `${label}.startTime`),
    status: processStatus(process.status, `${label}.status`),
  };
  if (!/^\d+$/u.test(identity.startTime)) throw new Error(`${label}.startTime must be numeric`);
  if (identity.argv.length === 0 || identity.argv.some((argument) => argument.length === 0)) {
    throw new Error(`${label}.argv must contain only nonempty arguments`);
  }
  if (!(LIVE_PROCESS_STATES as readonly string[]).includes(identity.state)) {
    throw new Error(`${label}.state must be one of ${LIVE_PROCESS_STATES.join(", ")}`);
  }
  return identity;
}

function requireCapabilityHex(value: string, label: string): void {
  if (!/^[0-9a-f]{16}$/u.test(value)) {
    throw new Error(`${label} must be a 16-digit lowercase capability mask`);
  }
}

function requireZeroCapabilities(status: ProcessSecurityStatus, label: string): void {
  for (const field of ["capInh", "capPrm", "capEff", "capBnd", "capAmb"] as const) {
    const value = status[field];
    requireCapabilityHex(value, `${label}.${field}`);
    if (!/^[0]+$/u.test(value)) {
      throw new Error(`${label}.${field} expected 0, got ${value}`);
    }
  }
}

function requireExactIds(values: string[], expected: number, label: string): void {
  const exact = String(expected);
  if (values.length !== 4 || values.some((value) => value !== exact)) {
    throw new Error(
      `${label} expected ${exact} in all four identity slots, got ${values.join(" ")}`,
    );
  }
}

function requireExactSupplementaryGroups(
  values: string[],
  expected: readonly number[],
  label: string,
  alternatives: readonly (readonly number[])[] = [],
): void {
  const exact = [expected, ...alternatives].map((groupSet) => groupSet.map(String).sort());
  const actual = [...values].sort();
  if (
    !exact.some(
      (groupSet) =>
        actual.length === groupSet.length &&
        actual.every((value, index) => value === groupSet[index]),
    )
  ) {
    throw new Error(
      `${label} expected exactly ${exact.map((groupSet) => groupSet.join(" ")).join(" or ")}, got ${values.join(" ")}`,
    );
  }
}

function canonicalNemoclawStartSupervisorArgv(argv: string[]): boolean {
  if (
    argv.length === 1 &&
    (NEMOCLAW_START_SUPERVISOR_PATHS as readonly string[]).includes(argv[0] ?? "")
  ) {
    return true;
  }
  return (
    argv.length === 2 &&
    (BASH_ARGV0 as readonly string[]).includes(argv[0] ?? "") &&
    (NEMOCLAW_START_SUPERVISOR_PATHS as readonly string[]).includes(argv[1] ?? "")
  );
}

function validateSupervisor(
  process: ProcessSecurityIdentity,
  sandboxGid: number,
  expectedCapabilityMask: string,
): void {
  if (process.pid !== 1 || process.ppid !== 0) {
    throw new Error(
      `OpenShell supervisor expected pid=1 ppid=0, got ${process.pid}/${process.ppid}`,
    );
  }
  if (
    process.executable !== OPENSHELL_SUPERVISOR_EXECUTABLE ||
    process.argv.length !== OPENSHELL_SUPERVISOR_ARGV.length ||
    process.argv.some((argument, index) => argument !== OPENSHELL_SUPERVISOR_ARGV[index])
  ) {
    throw new Error("PID 1 does not have the expected OpenShell supervisor command");
  }
  requireExactIds(process.status.uid, 0, "OpenShell supervisor Uid");
  requireExactIds(process.status.gid, 0, "OpenShell supervisor Gid");
  requireExactSupplementaryGroups(
    process.status.groups,
    [0],
    "OpenShell supervisor Groups",
    [[0, sandboxGid]],
  );
  for (const field of ["capInh", "capPrm", "capEff", "capBnd", "capAmb"] as const) {
    requireCapabilityHex(process.status[field], `OpenShell supervisor ${field}`);
  }
  if (process.status.capInh !== "0000000000000000") {
    throw new Error(`OpenShell supervisor CapInh drifted to ${process.status.capInh}`);
  }
  for (const field of ["capPrm", "capEff", "capBnd"] as const) {
    if (process.status[field] !== expectedCapabilityMask) {
      throw new Error(
        `OpenShell supervisor ${field} expected ${expectedCapabilityMask}, got ${process.status[field]}`,
      );
    }
  }
  if (process.status.capAmb !== "0000000000000000") {
    throw new Error(`OpenShell supervisor CapAmb drifted to ${process.status.capAmb}`);
  }
  if (process.status.noNewPrivs !== "1") {
    throw new Error(`OpenShell supervisor expected NoNewPrivs=1, got ${process.status.noNewPrivs}`);
  }
}

function validateNemoclawStartProcess(
  process: ProcessSecurityIdentity,
  sandboxUid: number,
  sandboxGid: number,
): void {
  if (process.pid === 1) {
    throw new Error("nemoclaw-start process must not replace the OpenShell supervisor at PID 1");
  }
  if (!canonicalNemoclawStartSupervisorArgv(process.argv)) {
    throw new Error("nemoclaw-start process does not have the expected argv");
  }
  if (!(SYSTEM_BASH_EXECUTABLES as readonly string[]).includes(process.executable)) {
    throw new Error(
      `nemoclaw-start process expected the system Bash executable, got ${process.executable}`,
    );
  }
  requireExactIds(process.status.uid, sandboxUid, "nemoclaw-start process Uid");
  requireExactIds(process.status.gid, sandboxGid, "nemoclaw-start process Gid");
  requireExactSupplementaryGroups(
    process.status.groups,
    [sandboxGid],
    "nemoclaw-start process Groups",
  );
  requireZeroCapabilities(process.status, "nemoclaw-start process");
  if (process.status.noNewPrivs !== "1") {
    throw new Error(
      `nemoclaw-start process expected NoNewPrivs=1, got ${process.status.noNewPrivs}`,
    );
  }
}

function selectNemoclawStartSupervisor(
  processes: ProcessSecurityIdentity[],
): ProcessSecurityIdentity {
  const byPid = new Map<number, ProcessSecurityIdentity>();
  for (const process of processes) {
    if (byPid.has(process.pid)) {
      throw new Error(`nemoclaw-start process PID ${process.pid} appeared more than once`);
    }
    byPid.set(process.pid, process);
  }

  const direct = processes.filter((process) => process.ppid === 1);
  if (direct.length !== 1) {
    throw new Error(
      `expected exactly one direct nemoclaw-start child supervisor, found ${direct.length}`,
    );
  }
  const supervisor = direct[0]!;
  for (const process of processes) {
    if (process === supervisor) continue;
    const visited = new Set<number>([process.pid]);
    let current = process;
    while (current.ppid !== 1) {
      const parent = byPid.get(current.ppid);
      if (!parent || visited.has(parent.pid)) {
        throw new Error(
          `nemoclaw-start process PID ${process.pid} is not a descendant of the direct child supervisor`,
        );
      }
      visited.add(parent.pid);
      current = parent;
    }
    if (current !== supervisor) {
      throw new Error(
        `nemoclaw-start process PID ${process.pid} is not a descendant of the direct child supervisor`,
      );
    }
  }
  return supervisor;
}

function stableProcessIdentityKey(process: ProcessSecurityIdentity): string {
  return JSON.stringify({
    argv: process.argv,
    executable: process.executable,
    pid: process.pid,
    ppid: process.ppid,
    startTime: process.startTime,
    status: process.status,
  });
}

function processIdentityArray(value: unknown, label: string): ProcessSecurityIdentity[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_PROC_ENTRIES) {
    throw new Error(`${label} exceeded ${MAX_PROC_ENTRIES} process entries`);
  }
  return value.map((entry, index) => processIdentity(entry, `${label}[${index}]`));
}

export function validateSplitProcessSecurityReport(
  value: unknown,
  expectedCapabilityMask = OPENSHELL_SUPERVISOR_CAPABILITY_MASK,
): SplitProcessSecurityReport {
  requireCapabilityHex(expectedCapabilityMask, "reviewed OpenShell supervisor capability mask");
  const report = requiredRecord(value, "split-process security report");
  if (report.version !== 2) throw new Error("split-process security report version must be 2");
  const observedProcEntries = requiredInteger(
    report.observedProcEntries,
    "split-process security report observedProcEntries",
    1,
  );
  if (observedProcEntries > MAX_PROC_ENTRIES) {
    throw new Error(`split-process security report exceeded ${MAX_PROC_ENTRIES} process entries`);
  }
  const sandboxUid = requiredInteger(report.sandboxUid, "sandbox uid", 1);
  const sandboxGid = requiredInteger(report.sandboxGid, "sandbox gid", 1);
  const supervisor = processIdentity(report.supervisor, "supervisor");
  const childSupervisors = processIdentityArray(
    report.childSupervisors,
    "split-process security report childSupervisors",
  );
  const observedChildSupervisors = processIdentityArray(
    report.observedChildSupervisors,
    "split-process security report observedChildSupervisors",
  );
  if (observedChildSupervisors.length > observedProcEntries) {
    throw new Error(
      "split-process security report retained more child supervisors than observed processes",
    );
  }
  validateSupervisor(supervisor, sandboxGid, expectedCapabilityMask);
  for (const process of childSupervisors) {
    validateNemoclawStartProcess(process, sandboxUid, sandboxGid);
  }
  selectNemoclawStartSupervisor(childSupervisors);
  const observedByPid = new Map<number, ProcessSecurityIdentity>();
  const observedIdentityKeys = new Set<string>();
  for (const process of observedChildSupervisors) {
    validateNemoclawStartProcess(process, sandboxUid, sandboxGid);
    if (observedByPid.has(process.pid)) {
      throw new Error(`observed nemoclaw-start process PID ${process.pid} appeared more than once`);
    }
    observedByPid.set(process.pid, process);
    observedIdentityKeys.add(stableProcessIdentityKey(process));
  }
  for (const process of childSupervisors) {
    if (!observedIdentityKeys.has(stableProcessIdentityKey(process))) {
      throw new Error(
        `final nemoclaw-start process PID ${process.pid} was absent from the observed census`,
      );
    }
  }
  return {
    childSupervisors,
    observedChildSupervisors,
    observedProcEntries,
    sandboxGid,
    sandboxUid,
    supervisor,
    version: 2,
  };
}

export function parseSplitProcessSecurityReport(
  output: string,
  expectedCapabilityMask = OPENSHELL_SUPERVISOR_CAPABILITY_MASK,
): SplitProcessSecurityReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch (error) {
    throw new Error("split-process security probe emitted invalid JSON", { cause: error });
  }
  return validateSplitProcessSecurityReport(parsed, expectedCapabilityMask);
}

export function securityPostureEnabled(): boolean {
  return securityPostureExpectations().enabled;
}

export function securityPostureExpectations(
  env: NodeJS.ProcessEnv = process.env,
): SecurityPostureExpectations {
  const enabled = truthy(env.NEMOCLAW_E2E_SECURITY_POSTURE);
  return {
    enabled,
    openshellSplitProcess: enabled && truthy(env.NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS),
  };
}

export function securityPostureModeEnv(): NodeJS.ProcessEnv {
  const expectations = securityPostureExpectations();
  if (!expectations.enabled) return {};
  return {
    NEMOCLAW_E2E_EXPECT_NON_ROOT_HOST: "1",
    NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS: expectations.openshellSplitProcess ? "1" : "0",
    NEMOCLAW_E2E_SECURITY_POSTURE: "1",
  };
}

export async function assertSecurityPosture(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  agent: SecurityPostureAgent,
  dependencies: SecurityPostureDependencies = {},
): Promise<SecurityPostureSummary> {
  const expectations = securityPostureExpectations();
  if (!expectations.openshellSplitProcess) {
    throw new Error("security-posture mode requires NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS=1");
  }
  const hostUser = await host.command(
    "sh",
    ["-lc", 'uid="$(id -u)"; gid="$(id -g)"; echo "uid=$uid gid=$gid"; test "$uid" -ne 0'],
    {
      artifactName: "security-posture-host-user",
      env: probeEnv(),
      timeoutMs: 15_000,
    },
  );
  requireSuccess("non-root host user", hostUser);

  const resolvePrivilegedTarget =
    dependencies.resolvePrivilegedTarget ?? resolvePrivilegedSandboxTarget;
  const executePrivilegedCommand =
    dependencies.executePrivilegedCommand ?? executePrivilegedSandboxCommand;
  const splitProcessProbeCommand = ["/usr/bin/python3", "-I", "-c", SPLIT_PROCESS_SECURITY_PROBE];
  const initialTarget: RuntimeProviderPrivilegedSandboxTarget =
    resolvePrivilegedTarget(sandboxName);
  const splitProcessProbe: RuntimeProviderPrivilegedSandboxCommandResult = executePrivilegedCommand(
    sandboxName,
    splitProcessProbeCommand,
    {
      expectedResourceHandle: initialTarget.resourceHandle,
      sanitizeEnvironment: true,
      timeout: 30_000,
    },
  );
  const finalTarget = resolvePrivilegedTarget(sandboxName);
  if (
    finalTarget.providerId !== initialTarget.providerId ||
    finalTarget.resourceHandle !== initialTarget.resourceHandle
  ) {
    throw new Error("runtime provider resource identity changed during privileged inspection");
  }
  if (splitProcessProbe.status !== 0 || splitProcessProbe.signal || splitProcessProbe.error) {
    const detail = [
      splitProcessProbe.stdout.toString("utf8"),
      splitProcessProbe.stderr.toString("utf8"),
      splitProcessProbe.error?.message,
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `OpenShell and nemoclaw-start child supervisor security posture failed: ${detail}`,
    );
  }
  const splitProcess = parseSplitProcessSecurityReport(
    splitProcessProbe.stdout.toString("utf8"),
    supervisorCapabilityMask(initialTarget.providerId),
  );

  const rcFiles = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(String.raw`
bad=0
for f in /sandbox/.bashrc /sandbox/.profile; do
  test -f "$f" || { echo "MISSING $f"; bad=1; continue; }
  test ! -L "$f" || { echo "SYMLINK $f"; bad=1; }
  set -- $(stat -c "%a %U:%G" "$f")
  echo "META $f $1 $2"
  test "$1" = 444 || { echo "BAD_MODE $f $1"; bad=1; }
  test "$2" = root:root || { echo "BAD_OWNER $f $2"; bad=1; }
  grep -Eq "nemoclaw-configure-guard|^(openclaw|hermes)\(\)" "$f" && {
    echo "INLINE_GUARD $f"
    bad=1
  }
done
exit "$bad"
`),
    {
      artifactName: "security-posture-rc-files",
      env: probeEnv(),
      timeoutMs: 30_000,
    },
  );
  requireSuccess("locked sandbox rc files", rcFiles);

  const functionName = agent === "hermes" ? "hermes" : "openclaw";
  const guardArg = agent === "hermes" ? "setup" : "configure";
  // Security-posture mode is fail-closed on the non-root host invariant. The
  // runtime proxy file may therefore be owned by that current sandbox user.
  const allowNonRootOwner = "1";
  const proxyEnv = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(String.raw`
f=/tmp/nemoclaw-proxy-env.sh
bad=0
test -f "$f" || { echo MISSING_PROXY_ENV; exit 1; }
test ! -L "$f" || { echo SYMLINK_PROXY_ENV; bad=1; }
set -- $(stat -c "%a %U:%G" "$f")
echo "META $f $1 $2"
test "$1" = 444 || { echo "BAD_PROXY_ENV_MODE $1"; bad=1; }
current_owner="$(id -un):$(id -gn)"
if test "$2" != root:root; then
  test "${allowNonRootOwner}" = 1 && test "$2" = "$current_owner" || {
    echo "BAD_PROXY_ENV_OWNER $2"
    bad=1
  }
fi
grep -Fq '# nemoclaw-configure-guard begin' "$f" || { echo MISSING_GUARD_BEGIN; bad=1; }
grep -Fq '${functionName}() {' "$f" || { echo MISSING_AGENT_GUARD_FUNCTION; bad=1; }
grep -Fq '# nemoclaw-configure-guard end' "$f" || { echo MISSING_GUARD_END; bad=1; }
exit "$bad"
`),
    {
      artifactName: "security-posture-proxy-env",
      env: probeEnv(),
      timeoutMs: 30_000,
    },
  );
  requireSuccess("locked runtime proxy environment", proxyEnv);

  const configureGuard = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(String.raw`
. /tmp/nemoclaw-proxy-env.sh
if ${functionName} ${guardArg} >/tmp/nemoclaw-security-guard-probe.out 2>&1; then
  echo GUARD_DID_NOT_BLOCK
  cat /tmp/nemoclaw-security-guard-probe.out
  exit 1
fi
cat /tmp/nemoclaw-security-guard-probe.out
grep -q 'cannot modify config inside the sandbox' /tmp/nemoclaw-security-guard-probe.out
`),
    {
      artifactName: "security-posture-configure-guard",
      env: probeEnv(),
      timeoutMs: 30_000,
    },
  );
  requireSuccess(`${functionName} ${guardArg} runtime guard`, configureGuard);

  const launchPattern =
    agent === "hermes" ? "hermes gateway launched" : "openclaw gateway launched";
  const startLog = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(String.raw`
log=/tmp/nemoclaw-start.log
test -f "$log" || { echo MISSING_START_LOG; exit 1; }
grep -qi '${launchPattern}' "$log" || { echo MISSING_GATEWAY_LAUNCH_MARKER; exit 1; }
if grep -E 'mktemp:.*(/sandbox/\.\.(bashrc|profile)\.tmp|/sandbox/\.nemoclaw.*tmp)|Permission denied.*(/sandbox/\.bashrc|/sandbox/\.profile)' "$log"; then
  echo START_LOG_HAS_RC_WRITE_FAILURE
  exit 1
fi
tail -n 20 "$log"
`),
    {
      artifactName: "security-posture-start-log",
      env: probeEnv(),
      timeoutMs: 30_000,
    },
  );
  requireSuccess("sandbox startup log security posture", startLog);

  return {
    configureGuard: true,
    hostNonRoot: true,
    rcFilesLocked: true,
    runtimeProxyEnvLocked: true,
    splitProcess: {
      childSupervisor: selectNemoclawStartSupervisor(splitProcess.childSupervisors),
      supervisor: splitProcess.supervisor,
    },
    startupLogClean: true,
  };
}
