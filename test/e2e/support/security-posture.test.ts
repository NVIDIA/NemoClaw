// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeProviderPrivilegedSandboxCommandResult } from "../../../src/lib/onboard/runtime-provider/contract.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  assertSecurityPosture,
  OPENSHELL_SUPERVISOR_CAPABILITY_MASK,
  PODMAN_OPENSHELL_SUPERVISOR_CAPABILITY_MASK,
  type ProcessSecurityIdentity,
  parseSplitProcessSecurityReport,
  SPLIT_PROCESS_SECURITY_PROBE,
  type SplitProcessSecurityReport,
  securityPostureEnabled,
  securityPostureExpectations,
  securityPostureModeEnv,
  validateSplitProcessSecurityReport,
} from "../fixtures/security-posture.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const ZERO_CAPABILITIES = "0000000000000000";
const SUPERVISOR_EXECUTABLE = "/opt/openshell/bin/openshell-sandbox";
const SANDBOX_NAME = "secure-sandbox";
const RESOURCE_HANDLE = "opaque-runtime-resource";
const CONTROLLED_PROC_HARNESS = String.raw`import contextlib
import grp
import json
import os
import pathlib
import pwd
import sys
import types

probe, proc_root_arg, censuses_json = sys.argv[1:4]
real_path = type(pathlib.Path())
real_scandir = os.scandir
real_stat = os.stat
proc_root = real_path(proc_root_arg)
censuses = json.loads(censuses_json)
scan_index = 0
active_links = set()
stable_targets = {}

def controlled_path(value="."):
    if str(value) == "/proc":
        return proc_root
    return real_path(value)

def controlled_scandir(root):
    global scan_index
    if real_path(root) != proc_root:
        return real_scandir(root)
    census = censuses[min(scan_index, len(censuses) - 1)]
    scan_index += 1
    for link in active_links:
        link.unlink(missing_ok=True)
    active_links.clear()
    stable_targets.clear()
    entries = []
    for record in census:
        name = str(record["pid"])
        link = proc_root / name
        if name != "1":
            os.symlink(record["selectedPath"], link, target_is_directory=True)
            active_links.add(link)
            if record["stablePath"] != record["selectedPath"]:
                stable_targets[str(link)] = record["stablePath"]
        entries.append(types.SimpleNamespace(name=name, path=str(link)))
    return contextlib.nullcontext(iter(entries))

def controlled_stat(path, *args, **kwargs):
    target = stable_targets.pop(str(path), None)
    if target is not None:
        link = real_path(path)
        link.unlink()
        os.symlink(target, link, target_is_directory=True)
    return real_stat(path, *args, **kwargs)

pathlib.Path = controlled_path
os.scandir = controlled_scandir
os.stat = controlled_stat
pwd.getpwnam = lambda _name: types.SimpleNamespace(pw_uid=1000, pw_gid=1000)
grp.getgrnam = lambda _name: types.SimpleNamespace(gr_gid=1000)
exec(compile(probe, "<security-posture-split-process>", "exec"), {"__name__": "__main__"})`;

type ControlledCensus = {
  children: ProcessSecurityIdentity[];
  selectedChildren?: ProcessSecurityIdentity[];
};

type ReportMutationCase = {
  error: RegExp;
  mutate: (report: SplitProcessSecurityReport) => void;
  name: string;
};

function repeatedId(id: number): string[] {
  return Array.from({ length: 4 }, () => String(id));
}

function validNemoclawStartProcess({
  pid = 42,
  ppid = 1,
  sandboxGid = 1000,
  sandboxUid = 1000,
  startTime = "202",
}: {
  pid?: number;
  ppid?: number;
  sandboxGid?: number;
  sandboxUid?: number;
  startTime?: string;
} = {}): ProcessSecurityIdentity {
  return {
    argv: ["/usr/bin/bash", "/usr/local/bin/nemoclaw-start"],
    executable: "/usr/bin/bash",
    pid,
    ppid,
    state: "S",
    startTime,
    status: {
      capAmb: ZERO_CAPABILITIES,
      capBnd: ZERO_CAPABILITIES,
      capEff: ZERO_CAPABILITIES,
      capInh: ZERO_CAPABILITIES,
      capPrm: ZERO_CAPABILITIES,
      gid: repeatedId(sandboxGid),
      groups: [String(sandboxGid)],
      noNewPrivs: "1",
      uid: repeatedId(sandboxUid),
    },
  };
}

function validReport(): SplitProcessSecurityReport {
  const childSupervisor = validNemoclawStartProcess();
  return {
    childSupervisors: [childSupervisor],
    observedChildSupervisors: [structuredClone(childSupervisor)],
    observedProcEntries: 12,
    sandboxGid: 1000,
    sandboxUid: 1000,
    supervisor: {
      argv: [SUPERVISOR_EXECUTABLE, "--workdir", "/sandbox"],
      executable: SUPERVISOR_EXECUTABLE,
      pid: 1,
      ppid: 0,
      state: "S",
      startTime: "101",
      status: {
        capAmb: ZERO_CAPABILITIES,
        capBnd: OPENSHELL_SUPERVISOR_CAPABILITY_MASK,
        capEff: OPENSHELL_SUPERVISOR_CAPABILITY_MASK,
        capInh: ZERO_CAPABILITIES,
        capPrm: OPENSHELL_SUPERVISOR_CAPABILITY_MASK,
        gid: repeatedId(0),
        groups: ["0", "1000"],
        noNewPrivs: "1",
        uid: repeatedId(0),
      },
    },
    version: 2,
  };
}

function setCurrentChildSupervisors(
  report: SplitProcessSecurityReport,
  childSupervisors: ProcessSecurityIdentity[],
): void {
  report.childSupervisors = childSupervisors;
  report.observedChildSupervisors = structuredClone(childSupervisors);
}

function writeProcProcess(root: string, process: ProcessSecurityIdentity): void {
  const processDirectory = path.join(root, String(process.pid));
  mkdirSync(processDirectory, { recursive: true });
  const statFields = [
    process.state,
    String(process.ppid),
    ...Array.from({ length: 17 }, () => "0"),
    process.startTime,
  ];
  writeFileSync(
    path.join(processDirectory, "stat"),
    `${process.pid} (fixture) ${statFields.join(" ")}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(processDirectory, "status"),
    [
      `Uid:\t${process.status.uid.join("\t")}`,
      `Gid:\t${process.status.gid.join("\t")}`,
      `Groups:\t${process.status.groups.join("\t")}`,
      `CapInh:\t${process.status.capInh}`,
      `CapPrm:\t${process.status.capPrm}`,
      `CapEff:\t${process.status.capEff}`,
      `CapBnd:\t${process.status.capBnd}`,
      `CapAmb:\t${process.status.capAmb}`,
      `NoNewPrivs:\t${process.status.noNewPrivs}`,
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(processDirectory, "cmdline"),
    Buffer.from(`${process.argv.join("\0")}\0`, "utf8"),
  );
  symlinkSync(process.executable, path.join(processDirectory, "exe"));
}

function runSplitProcessProbeWithCensuses(censuses: ControlledCensus[]) {
  const procRoot = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-security-posture-proc-"));
  const report = validReport();
  try {
    writeProcProcess(procRoot, report.supervisor);
    const controlledCensuses = censuses.map((census, index) => {
      const snapshotRoot = path.join(procRoot, "snapshots", String(index));
      const stableRoot = path.join(snapshotRoot, "stable");
      const selectedRoot = path.join(snapshotRoot, "selected");
      const selectedChildren = census.selectedChildren ?? census.children;
      const children = census.children.map((stable, childIndex) => {
        const selected = selectedChildren[childIndex]!;
        writeProcProcess(stableRoot, stable);
        writeProcProcess(selectedRoot, selected);
        return {
          pid: stable.pid,
          selectedPath: path.join(selectedRoot, String(stable.pid)),
          stablePath: path.join(stableRoot, String(stable.pid)),
        };
      });
      const supervisorPath = path.join(procRoot, "1");
      return [{ pid: 1, selectedPath: supervisorPath, stablePath: supervisorPath }, ...children];
    });
    return spawnSync(
      "python3",
      [
        "-I",
        "-c",
        CONTROLLED_PROC_HARNESS,
        SPLIT_PROCESS_SECURITY_PROBE,
        procRoot,
        JSON.stringify(controlledCensuses),
      ],
      { encoding: "utf8", killSignal: "SIGKILL", timeout: 10_000 },
    );
  } finally {
    rmSync(procRoot, { force: true, recursive: true });
  }
}

function reportsWithEachNemoclawStartProcessFirst(): SplitProcessSecurityReport[] {
  const directFirst = validReport();
  const descendantFirst = validReport();
  const direct = descendantFirst.childSupervisors[0]!;
  setCurrentChildSupervisors(descendantFirst, [
    validNemoclawStartProcess({ pid: 43, ppid: direct.pid, startTime: "203" }),
    direct,
  ]);
  return [directFirst, descendantFirst];
}

function successfulProbe(stdout = ""): ShellProbeResult {
  return {
    artifacts: { result: "result.json", stderr: "stderr.txt", stdout: "stdout.txt" },
    command: [],
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout,
    timedOut: false,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("security posture fixture", () => {
  it("compiles the embedded split-process probe as Python", () => {
    const compiled = spawnSync(
      "python3",
      [
        "-c",
        "import sys; compile(sys.argv[1], '<security-posture-split-process>', 'exec')",
        SPLIT_PROCESS_SECURITY_PROBE,
      ],
      { encoding: "utf8" },
    );

    expect(compiled.error, "python3 is required to compile the embedded probe").toBeUndefined();
    expect(compiled.status, compiled.stderr).toBe(0);
  });

  it("accepts equal split-process censuses with different enumeration order", () => {
    const direct = validNemoclawStartProcess();
    const descendant = validNemoclawStartProcess({ pid: 43, ppid: 42, startTime: "203" });
    const result = runSplitProcessProbeWithCensuses([
      { children: [direct, descendant] },
      { children: [descendant, direct] },
    ]);

    expect(result.error, "python3 is required to run the embedded probe").toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const report = parseSplitProcessSecurityReport(result.stdout);
    expect(report.childSupervisors.map(({ pid }) => pid)).toEqual([42, 43]);
    expect(report.observedChildSupervisors.map(({ pid }) => pid)).toEqual([42, 43]);
  });

  it("separates the final stable census from every process observed during acquisition", () => {
    const direct = validNemoclawStartProcess();
    const firstDescendant = validNemoclawStartProcess({
      pid: 43,
      ppid: 42,
      startTime: "203",
    });
    const finalDescendant = validNemoclawStartProcess({
      pid: 44,
      ppid: 42,
      startTime: "204",
    });
    const result = runSplitProcessProbeWithCensuses([
      { children: [direct, firstDescendant] },
      { children: [direct, finalDescendant] },
      { children: [finalDescendant, direct] },
    ]);

    expect(result.error, "python3 is required to run the embedded probe").toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const report = parseSplitProcessSecurityReport(result.stdout);
    expect(report.childSupervisors.map(({ pid }) => pid)).toEqual([42, 44]);
    expect(report.observedChildSupervisors.map(({ pid }) => pid)).toEqual([42, 43, 44]);
  });

  it("rejects a privileged process retained from before census stability", () => {
    const direct = validNemoclawStartProcess();
    const privileged = validNemoclawStartProcess({ pid: 43, ppid: 42, startTime: "203" });
    privileged.status.capEff = "0000000000000001";
    const finalDescendant = validNemoclawStartProcess({
      pid: 44,
      ppid: 42,
      startTime: "204",
    });
    const result = runSplitProcessProbeWithCensuses([
      { children: [direct, privileged] },
      { children: [direct, finalDescendant] },
      { children: [direct, finalDescendant] },
    ]);

    expect(result.error, "python3 is required to run the embedded probe").toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(() => parseSplitProcessSecurityReport(result.stdout)).toThrow(
      /nemoclaw-start process\.capEff expected 0/u,
    );
  });

  it("rejects a stable final census with no direct child despite an earlier match", () => {
    const result = runSplitProcessProbeWithCensuses([
      { children: [validNemoclawStartProcess()] },
      { children: [] },
      { children: [] },
    ]);

    expect(result.error, "python3 is required to run the embedded probe").toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(() => parseSplitProcessSecurityReport(result.stdout)).toThrow(
      /expected exactly one direct nemoclaw-start child supervisor, found 0/u,
    );
  });

  it("rejects one process identity that changes across census attempts", () => {
    const direct = validNemoclawStartProcess();
    const changed = structuredClone(direct);
    changed.status.capEff = "0000000000000001";
    const result = runSplitProcessProbeWithCensuses([
      { children: [direct] },
      { children: [changed] },
    ]);

    expect(result.error, "python3 is required to run the embedded probe").toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/identity changed across census attempts.*fields=status/u);
  });

  it("rejects PID reuse during census acquisition", () => {
    const result = runSplitProcessProbeWithCensuses([
      { children: [validNemoclawStartProcess({ startTime: "202" })] },
      { children: [validNemoclawStartProcess({ startTime: "303" })] },
    ]);

    expect(result.error, "python3 is required to run the embedded probe").toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/PID 42 was reused during census acquisition/u);
  });

  it("rejects a process that changes after census selection without logging its arguments", () => {
    const selected = validNemoclawStartProcess();
    const changed = structuredClone(selected);
    changed.argv = ["/usr/bin/bash", "credential=DO_NOT_LOG"];
    const result = runSplitProcessProbeWithCensuses([
      { children: [changed], selectedChildren: [selected] },
    ]);

    expect(result.error, "python3 is required to run the embedded probe").toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/process changed after census selection/u);
    expect(result.stderr).not.toContain("DO_NOT_LOG");
  });

  it("rejects same-command PID reuse after census selection", () => {
    const selected = validNemoclawStartProcess({ startTime: "202" });
    selected.status.capEff = "0000000000000001";
    const reused = validNemoclawStartProcess({ startTime: "303" });
    const result = runSplitProcessProbeWithCensuses([
      { children: [reused], selectedChildren: [selected] },
    ]);

    expect(result.error, "python3 is required to run the embedded probe").toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/process changed after census selection/u);
  });

  it("rejects a retained census that grows beyond the observed process bound", () => {
    const direct = validNemoclawStartProcess();
    const descendant = (pid: number) =>
      validNemoclawStartProcess({ pid, ppid: 42, startTime: String(160 + pid) });
    const result = runSplitProcessProbeWithCensuses([
      { children: [direct, descendant(43)] },
      { children: [direct, descendant(44)] },
      { children: [direct, descendant(45)] },
    ]);

    expect(result.error, "python3 is required to run the embedded probe").toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/retained process census exceeded the observed process bound/u);
  });

  it("reports both census identities when bounded acquisition does not stabilize", () => {
    const direct = validNemoclawStartProcess();
    const firstDescendant = validNemoclawStartProcess({
      pid: 43,
      ppid: 42,
      startTime: "203",
    });
    const secondDescendant = validNemoclawStartProcess({
      pid: 44,
      ppid: 42,
      startTime: "204",
    });
    const result = runSplitProcessProbeWithCensuses([
      { children: [direct, firstDescendant] },
      { children: [direct, secondDescendant] },
      { children: [direct, firstDescendant] },
      { children: [direct, secondDescendant] },
    ]);

    expect(result.error, "python3 is required to run the embedded probe").toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /did not stabilize after 4 attempts: first=.*"pid": 43.*second=.*"pid": 44/su,
    );
    expect(result.stderr).not.toMatch(/argv|executable|status/u);
  });

  it("keeps isolated Python from importing a sandbox-controlled module", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-security-posture-python-"));
    try {
      writeFileSync(path.join(directory, "json.py"), "raise SystemExit(73)\n", "utf8");
      const isolated = spawnSync(
        "python3",
        ["-I", "-c", 'import json; print(json.dumps({"isolated": True}))'],
        {
          cwd: directory,
          encoding: "utf8",
          env: { ...process.env, PYTHONPATH: directory },
        },
      );

      expect(isolated.error, "python3 is required to verify isolated mode").toBeUndefined();
      expect(isolated.status, isolated.stderr).toBe(0);
      expect(isolated.stdout.trim()).toBe('{"isolated": true}');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("forwards only an enabled split-process expectation", () => {
    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", undefined);
    vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "1");
    expect(securityPostureEnabled()).toBe(false);
    expect(securityPostureExpectations()).toEqual({
      enabled: false,
      openshellSplitProcess: false,
    });
    expect(securityPostureModeEnv()).toEqual({});

    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "yes");
    vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "on");
    expect(securityPostureEnabled()).toBe(true);
    expect(securityPostureExpectations()).toEqual({
      enabled: true,
      openshellSplitProcess: true,
    });
    expect(securityPostureModeEnv()).toEqual({
      NEMOCLAW_E2E_EXPECT_NON_ROOT_HOST: "1",
      NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS: "1",
      NEMOCLAW_E2E_SECURITY_POSTURE: "1",
    });
  });

  it("normalizes a disabled split-process expectation", () => {
    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "1");
    vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "0");

    expect(securityPostureExpectations()).toEqual({
      enabled: true,
      openshellSplitProcess: false,
    });
    expect(securityPostureModeEnv()).toEqual({
      NEMOCLAW_E2E_EXPECT_NON_ROOT_HOST: "1",
      NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS: "0",
      NEMOCLAW_E2E_SECURITY_POSTURE: "1",
    });
  });

  it("accepts the expected OpenShell supervisor and non-root nemoclaw-start child supervisor", () => {
    const report = validReport();

    expect(OPENSHELL_SUPERVISOR_CAPABILITY_MASK).toBe("00000004a82c35fb");
    expect(validateSplitProcessSecurityReport(report)).toEqual(report);
    expect(parseSplitProcessSecurityReport(JSON.stringify(report))).toEqual(report);
  });

  it("accepts the exact OpenShell supervisor groups in either report order", () => {
    const report = validReport();
    report.supervisor.status.groups.reverse();

    expect(validateSplitProcessSecurityReport(report)).toEqual(report);
  });

  it("accepts a root-only OpenShell supervisor without an engine-added sandbox group", () => {
    const report = validReport();
    report.supervisor.status.groups = ["0"];

    expect(validateSplitProcessSecurityReport(report)).toEqual(report);
  });

  it.each([
    {
      agent: "OpenClaw",
      observedProcEntries: 14,
      processes: [
        { pid: 453, ppid: 37, startTime: "58621" },
        { pid: 463, ppid: 37, startTime: "58622" },
        { pid: 473, ppid: 37, startTime: "58623" },
        { pid: 37, ppid: 1, startTime: "58448" },
      ],
      sandboxGid: 998,
    },
    {
      agent: "Hermes",
      observedProcEntries: 16,
      processes: [
        { pid: 54_461, ppid: 38, startTime: "52022" },
        { pid: 38, ppid: 1, startTime: "30812" },
      ],
      sandboxGid: 999,
    },
  ])(
    "accepts the observed $agent process tree with one direct supervisor and secure descendants",
    ({ observedProcEntries, processes, sandboxGid }) => {
      const report = validReport();
      report.observedProcEntries = observedProcEntries;
      report.sandboxUid = 998;
      report.sandboxGid = sandboxGid;
      report.supervisor.status.groups = ["0", String(sandboxGid)];
      setCurrentChildSupervisors(
        report,
        processes.map(({ pid, ppid, startTime }) =>
          validNemoclawStartProcess({ pid, ppid, sandboxGid, sandboxUid: 998, startTime }),
        ),
      );

      expect(validateSplitProcessSecurityReport(report)).toEqual(report);
      expect(parseSplitProcessSecurityReport(JSON.stringify(report))).toEqual(report);
    },
  );

  it("accepts a nested canonical descendant tree", () => {
    const report = validReport();
    setCurrentChildSupervisors(report, [
      validNemoclawStartProcess({ pid: 44, ppid: 43, startTime: "204" }),
      report.childSupervisors[0]!,
      validNemoclawStartProcess({ pid: 43, ppid: 42, startTime: "203" }),
    ]);

    expect(validateSplitProcessSecurityReport(report)).toEqual(report);
  });

  it.each<ReportMutationCase>([
    {
      error: /expected pid=1 ppid=0/u,
      mutate: (report) => {
        report.supervisor.ppid = 2;
      },
      name: "parent process",
    },
    {
      error: /does not have the expected OpenShell supervisor command/u,
      mutate: (report) => {
        report.supervisor.executable = "/usr/bin/bash";
      },
      name: "executable",
    },
    {
      error: /does not have the expected OpenShell supervisor command/u,
      mutate: (report) => {
        report.supervisor.argv.push("--unexpected");
      },
      name: "command arguments",
    },
    {
      error: /supervisor Uid expected 0/u,
      mutate: (report) => {
        report.supervisor.status.uid = repeatedId(1000);
      },
      name: "user identity",
    },
    {
      error: /supervisor Gid expected 0/u,
      mutate: (report) => {
        report.supervisor.status.gid = repeatedId(1000);
      },
      name: "group identity",
    },
    {
      error: /supervisor Groups expected exactly 0 or 0 1000/u,
      mutate: (report) => {
        report.supervisor.status.groups = ["0", "44"];
      },
      name: "wrong sandbox supplementary group",
    },
    {
      error: /supervisor Groups expected exactly 0 or 0 1000/u,
      mutate: (report) => {
        report.supervisor.status.groups = ["0", "1000", "44"];
      },
      name: "extra supplementary group",
    },
    {
      error: /supervisor Groups expected exactly 0 or 0 1000/u,
      mutate: (report) => {
        report.supervisor.status.groups = ["0", "0"];
      },
      name: "duplicate supplementary group",
    },
    {
      error: /supervisor\.state must be one of D, R, S/u,
      mutate: (report) => {
        report.supervisor.state = "T";
      },
      name: "process state",
    },
    {
      error: /supervisor CapInh drifted/u,
      mutate: (report) => {
        report.supervisor.status.capInh = "0000000000000001";
      },
      name: "inheritable capability",
    },
    {
      error: /supervisor capPrm expected/u,
      mutate: (report) => {
        report.supervisor.status.capPrm = ZERO_CAPABILITIES;
      },
      name: "permitted capability",
    },
    {
      error: /supervisor capEff expected/u,
      mutate: (report) => {
        report.supervisor.status.capEff = ZERO_CAPABILITIES;
      },
      name: "effective capability",
    },
    {
      error: /supervisor capBnd expected/u,
      mutate: (report) => {
        report.supervisor.status.capBnd = ZERO_CAPABILITIES;
      },
      name: "bounding capability",
    },
    {
      error: /supervisor CapAmb drifted/u,
      mutate: (report) => {
        report.supervisor.status.capAmb = "0000000000000001";
      },
      name: "ambient capability",
    },
    {
      error: /supervisor expected NoNewPrivs=1/u,
      mutate: (report) => {
        report.supervisor.status.noNewPrivs = "0";
      },
      name: "NoNewPrivs",
    },
  ])("rejects OpenShell supervisor $name drift", ({ error, mutate }) => {
    const report = validReport();
    mutate(report);

    expect(() => validateSplitProcessSecurityReport(report)).toThrow(error);
  });

  it.each([
    {
      directCount: 0,
      mutate: (report: SplitProcessSecurityReport) => {
        report.childSupervisors[0]!.ppid = 43;
      },
    },
    {
      directCount: 2,
      mutate: (report: SplitProcessSecurityReport) => {
        report.childSupervisors.push(
          validNemoclawStartProcess({ pid: 43, ppid: 1, startTime: "203" }),
        );
      },
    },
  ])(
    "rejects a census with $directCount direct nemoclaw-start child supervisors",
    ({ directCount, mutate }) => {
      const report = validReport();
      mutate(report);

      expect(() => validateSplitProcessSecurityReport(report)).toThrow(
        new RegExp(`found ${directCount}`, "u"),
      );
    },
  );

  it.each(["202", "303"])(
    "rejects a repeated nemoclaw-start PID with reported start time %s",
    (startTime) => {
      const report = validReport();
      const duplicatePid = structuredClone(report.childSupervisors[0]!);
      duplicatePid.startTime = startTime;
      report.childSupervisors.push(duplicatePid);

      expect(() => validateSplitProcessSecurityReport(report)).toThrow(
        /PID 42 appeared more than once/u,
      );
    },
  );

  it.each([
    {
      name: "missing parent",
      processes: [validNemoclawStartProcess({ pid: 43, ppid: 99, startTime: "203" })],
    },
    {
      name: "parent cycle",
      processes: [
        validNemoclawStartProcess({ pid: 43, ppid: 44, startTime: "203" }),
        validNemoclawStartProcess({ pid: 44, ppid: 43, startTime: "204" }),
      ],
    },
  ])("rejects a canonical descendant with a $name", ({ processes }) => {
    const report = validReport();
    report.childSupervisors.push(...processes);

    expect(() => validateSplitProcessSecurityReport(report)).toThrow(
      /is not a descendant of the direct child supervisor/u,
    );
  });

  it.each<ReportMutationCase>([
    {
      error: /must not replace the OpenShell supervisor at PID 1/u,
      mutate: (report) => {
        report.childSupervisors[0]!.pid = 1;
      },
      name: "at PID 1",
    },
    {
      error: /does not have the expected argv/u,
      mutate: (report) => {
        report.childSupervisors[0]!.argv = [
          "/usr/bin/bash",
          "/usr/local/bin/nemoclaw-start",
          "--unexpected",
        ];
      },
      name: "with extra command arguments",
    },
    {
      error: /argv must contain only nonempty arguments/u,
      mutate: (report) => {
        report.childSupervisors[0]!.argv.push("");
      },
      name: "with a trailing empty command argument",
    },
    {
      error: /expected the system Bash executable/u,
      mutate: (report) => {
        report.childSupervisors[0]!.executable = "/usr/bin/python3";
      },
      name: "with a different executable",
    },
    {
      error: /childSupervisors\[0\]\.state must be one of D, R, S/u,
      mutate: (report) => {
        report.childSupervisors[0]!.state = "T";
      },
      name: "with a stopped or traced process state",
    },
    {
      error: /nemoclaw-start process Uid expected 1000/u,
      mutate: (report) => {
        report.childSupervisors[0]!.status.uid = repeatedId(0);
      },
      name: "that runs as root",
    },
    {
      error: /nemoclaw-start process Uid expected 1000/u,
      mutate: (report) => {
        report.childSupervisors[0]!.status.uid = repeatedId(1001);
      },
      name: "with a different non-root user",
    },
    {
      error: /nemoclaw-start process Gid expected 1000/u,
      mutate: (report) => {
        report.childSupervisors[0]!.status.gid = repeatedId(1001);
      },
      name: "with a different non-root group",
    },
    {
      error: /nemoclaw-start process Groups expected exactly 1000/u,
      mutate: (report) => {
        report.childSupervisors[0]!.status.groups = ["0", "1000"];
      },
      name: "with a privileged supplementary group",
    },
    {
      error: /nemoclaw-start process expected NoNewPrivs=1/u,
      mutate: (report) => {
        report.childSupervisors[0]!.status.noNewPrivs = "0";
      },
      name: "without NoNewPrivs",
    },
  ])("rejects every nemoclaw-start process $name", ({ error, mutate }) => {
    reportsWithEachNemoclawStartProcessFirst().forEach((report) => {
      mutate(report);

      expect(() => validateSplitProcessSecurityReport(report)).toThrow(error);
    });
  });

  it.each(["capInh", "capPrm", "capEff", "capBnd", "capAmb"] as const)(
    "rejects every nemoclaw-start process with a nonzero %s set",
    (field) => {
      reportsWithEachNemoclawStartProcessFirst().forEach((report) => {
        report.childSupervisors[0]!.status[field] = "0000000000000001";

        expect(() => validateSplitProcessSecurityReport(report)).toThrow(
          new RegExp(`nemoclaw-start process\\.${field} expected 0`, "u"),
        );
      });
    },
  );

  it("rejects malformed and overflowing split-process reports", () => {
    expect(() => parseSplitProcessSecurityReport("not-json")).toThrow(/emitted invalid JSON/u);
    expect(() => validateSplitProcessSecurityReport({ childSupervisors: [] })).toThrow(
      /version must be 2/u,
    );
    expect(() => validateSplitProcessSecurityReport({ ...validReport(), version: 1 })).toThrow(
      /version must be 2/u,
    );

    const malformed = { ...validReport(), childSupervisors: "one" };
    expect(() => validateSplitProcessSecurityReport(malformed)).toThrow(
      /childSupervisors must be an array/u,
    );
    expect(() =>
      validateSplitProcessSecurityReport({
        ...validReport(),
        observedChildSupervisors: "one",
      }),
    ).toThrow(/observedChildSupervisors must be an array/u);

    const overflow = validReport();
    overflow.observedProcEntries = 32_769;
    expect(() => validateSplitProcessSecurityReport(overflow)).toThrow(
      /exceeded 32768 process entries/u,
    );
  });

  it("validates historical observations without using them as the final topology", () => {
    const report = validReport();
    report.observedChildSupervisors.unshift(
      validNemoclawStartProcess({ pid: 41, ppid: 1, startTime: "201" }),
    );

    expect(validateSplitProcessSecurityReport(report)).toEqual(report);

    report.observedChildSupervisors[0]!.status.capEff = "0000000000000001";
    expect(() => validateSplitProcessSecurityReport(report)).toThrow(
      /nemoclaw-start process\.capEff expected 0/u,
    );
  });

  it("rejects an incomplete, reused, or over-retained observed census", () => {
    const absentFinal = validReport();
    absentFinal.observedChildSupervisors[0]!.ppid = 99;
    expect(() => validateSplitProcessSecurityReport(absentFinal)).toThrow(
      /final nemoclaw-start process PID 42 was absent from the observed census/u,
    );

    const reusedPid = validReport();
    reusedPid.observedChildSupervisors.push(
      validNemoclawStartProcess({ pid: 42, startTime: "303" }),
    );
    expect(() => validateSplitProcessSecurityReport(reusedPid)).toThrow(
      /observed nemoclaw-start process PID 42 appeared more than once/u,
    );

    const overRetained = validReport();
    overRetained.observedProcEntries = 1;
    overRetained.observedChildSupervisors.push(
      validNemoclawStartProcess({ pid: 43, ppid: 42, startTime: "203" }),
    );
    expect(() => validateSplitProcessSecurityReport(overRetained)).toThrow(
      /retained more child supervisors than observed processes/u,
    );
  });

  it.each([
    { capabilityMask: OPENSHELL_SUPERVISOR_CAPABILITY_MASK, providerId: "docker" },
    { capabilityMask: PODMAN_OPENSHELL_SUPERVISOR_CAPABILITY_MASK, providerId: "podman" },
  ])(
    "checks the split-process report through the selected $providerId provider",
    async ({ capabilityMask, providerId }) => {
      vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "1");
      vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "1");
      const report = validReport();
      report.supervisor.status.capBnd = capabilityMask;
      report.supervisor.status.capEff = capabilityMask;
      report.supervisor.status.capPrm = capabilityMask;
      const directChildSupervisor = report.childSupervisors[0]!;
      setCurrentChildSupervisors(report, [
        validNemoclawStartProcess({
          pid: 43,
          ppid: directChildSupervisor.pid,
          startTime: "203",
        }),
        directChildSupervisor,
      ]);
      const command = vi
        .fn<HostCliClient["command"]>()
        .mockResolvedValueOnce(successfulProbe("uid=1000 gid=1000\n"));
      const execShell = vi.fn<SandboxClient["execShell"]>(async () => successfulProbe());
      const host = { command } as unknown as HostCliClient;
      const sandbox = { execShell } as unknown as SandboxClient;
      const resolvePrivilegedTarget = vi.fn(() => ({
        providerId,
        resourceHandle: RESOURCE_HANDLE,
      }));
      const executePrivilegedCommand = vi.fn((): RuntimeProviderPrivilegedSandboxCommandResult => ({
        status: 0,
        signal: null,
        stdout: Buffer.from(JSON.stringify(report), "utf8"),
        stderr: Buffer.alloc(0),
      }));

      const summary = await assertSecurityPosture(host, sandbox, SANDBOX_NAME, "openclaw", {
        executePrivilegedCommand,
        resolvePrivilegedTarget,
      });

      expect(summary).toEqual({
        configureGuard: true,
        hostNonRoot: true,
        rcFilesLocked: true,
        runtimeProxyEnvLocked: true,
        splitProcess: {
          childSupervisor: directChildSupervisor,
          supervisor: report.supervisor,
        },
        startupLogClean: true,
      });
      expect(command).toHaveBeenCalledTimes(1);
      expect(resolvePrivilegedTarget).toHaveBeenCalledTimes(2);
      expect(executePrivilegedCommand).toHaveBeenCalledWith(
        SANDBOX_NAME,
        ["/usr/bin/python3", "-I", "-c", SPLIT_PROCESS_SECURITY_PROBE],
        {
          expectedResourceHandle: RESOURCE_HANDLE,
          sanitizeEnvironment: true,
          timeout: 30_000,
        },
      );
      expect(execShell).toHaveBeenCalledTimes(4);
    },
  );

  it("rejects runtime provider resource identity drift during privileged inspection", async () => {
    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "1");
    vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "1");
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce(successfulProbe("uid=1000 gid=1000\n"));
    const execShell = vi.fn<SandboxClient["execShell"]>();
    const resolvePrivilegedTarget = vi
      .fn()
      .mockReturnValueOnce({ providerId: "podman", resourceHandle: "first" })
      .mockReturnValueOnce({ providerId: "podman", resourceHandle: "second" });
    const executePrivilegedCommand = vi.fn((): RuntimeProviderPrivilegedSandboxCommandResult => ({
      status: 0,
      signal: null,
      stdout: Buffer.from(JSON.stringify(validReport()), "utf8"),
      stderr: Buffer.alloc(0),
    }));

    await expect(
      assertSecurityPosture(
        { command } as unknown as HostCliClient,
        { execShell } as unknown as SandboxClient,
        SANDBOX_NAME,
        "openclaw",
        { executePrivilegedCommand, resolvePrivilegedTarget },
      ),
    ).rejects.toThrow(/runtime provider resource identity changed/u);

    expect(command).toHaveBeenCalledTimes(1);
    expect(executePrivilegedCommand).toHaveBeenCalledOnce();
    expect(execShell).not.toHaveBeenCalled();
  });

  it("rejects a failed provider-owned privileged security probe", async () => {
    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "1");
    vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "1");
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce(successfulProbe("uid=1000 gid=1000\n"));
    const execShell = vi.fn<SandboxClient["execShell"]>();
    const resolvePrivilegedTarget = vi.fn(() => ({
      providerId: "podman",
      resourceHandle: RESOURCE_HANDLE,
    }));
    const executePrivilegedCommand = vi.fn((): RuntimeProviderPrivilegedSandboxCommandResult => ({
      status: 125,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("provider probe failed", "utf8"),
    }));

    await expect(
      assertSecurityPosture(
        { command } as unknown as HostCliClient,
        { execShell } as unknown as SandboxClient,
        SANDBOX_NAME,
        "openclaw",
        { executePrivilegedCommand, resolvePrivilegedTarget },
      ),
    ).rejects.toThrow(/provider probe failed/u);

    expect(command).toHaveBeenCalledTimes(1);
    expect(executePrivilegedCommand).toHaveBeenCalledOnce();
    expect(execShell).not.toHaveBeenCalled();
  });

  it("rejects a disabled split-process expectation before running a command", async () => {
    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "1");
    vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "0");
    const command = vi.fn<HostCliClient["command"]>();
    const execShell = vi.fn<SandboxClient["execShell"]>();

    await expect(
      assertSecurityPosture(
        { command } as unknown as HostCliClient,
        { execShell } as unknown as SandboxClient,
        SANDBOX_NAME,
        "openclaw",
      ),
    ).rejects.toThrow(/requires NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS=1/u);
    expect(command).not.toHaveBeenCalled();
    expect(execShell).not.toHaveBeenCalled();
  });
});
