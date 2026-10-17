// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeProviderPrivilegedSandboxCommandResult } from "../../../src/lib/onboard/runtime-provider/contract.ts";
import {
  MANAGED_IMAGE_REPOSITORIES,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  assertSecurityPosture,
  parseCapabilitySurfaceReport,
  parseExpectedOpenShellVersion,
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
import type { SecurityContainerPair } from "../fixtures/security-posture-containers.ts";

const CONTAINER_PAIR: SecurityContainerPair = {
  evidence: "container-launch-configuration-and-supervisor-health",
  workload: {
    id: "a".repeat(64),
    image: "b".repeat(64),
    startedAt: "2026-10-15T00:00:00Z",
    pid: 100,
    user: "998:998",
    entrypoint: ["/.openshell/runtime/openshell-sandbox"],
    sandboxId: "sandbox-id",
    namespace: "default",
  },
  supervisor: {
    id: "c".repeat(64),
    image: "d".repeat(64),
    startedAt: "2026-10-15T00:00:00Z",
    pid: 101,
    user: "65534:65534",
    entrypoint: ["/openshell-supervisor"],
    sandboxId: "sandbox-id",
    namespace: "default",
  },
};

const ZERO_CAPABILITIES = "0000000000000000";
const BOUNDARY_EXECUTABLE = "/.openshell/runtime/openshell-sandbox";
const SANDBOX_NAME = "secure-sandbox";
const RESOURCE_HANDLE = "opaque-runtime-resource";
const MANAGED_IMAGE_REVISION = "a".repeat(40);
const CONTROLLED_PROC_HARNESS = String.raw`import contextlib
import grp
import json
import os
import pathlib
import pwd
import sys
import types

probe, proc_root_arg, censuses_json, options_json = sys.argv[1:5]
options = json.loads(options_json)
real_path = type(pathlib.Path())
real_scandir = os.scandir
real_stat = os.stat
real_readlink = os.readlink
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

def controlled_readlink(path, *args, **kwargs):
    if str(path) == str(proc_root / "1" / "exe"):
        if options.get("boundaryRead") == "missing":
            raise FileNotFoundError(2, "fixture missing process")
        if options.get("boundaryRead") == "readable":
            return "/.openshell/runtime/openshell-sandbox"
        raise PermissionError(13, "fixture permission denied")
    if options.get("denyChildRead"):
        raise PermissionError(13, "fixture child permission denied")
    return real_readlink(path, *args, **kwargs)

os.readlink = controlled_readlink
os.getresuid = lambda: tuple(options.get("observerUids", [1000, 1000, 1000]))
os.getresgid = lambda: tuple(options.get("observerGids", [1000, 1000, 1000]))
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

function setProcessIdentity(process: ProcessSecurityIdentity, id: number): void {
  process.status.uid = repeatedId(id);
  process.status.gid = repeatedId(id);
  process.status.groups = [String(id)];
}

function validReport(): SplitProcessSecurityReport {
  const childSupervisor = validNemoclawStartProcess();
  return {
    childSupervisors: [childSupervisor],
    observedChildSupervisors: [structuredClone(childSupervisor)],
    observedProcEntries: 12,
    sandboxGid: 1000,
    sandboxUid: 1000,
    workloadBoundary: {
      argv: [BOUNDARY_EXECUTABLE, "--bootstrap", "/.openshell/channel/sandbox/bootstrap.json"],
      executable: null,
      pid: 1,
      ppid: 0,
      state: "S",
      startTime: "101",
      status: {
        capAmb: ZERO_CAPABILITIES,
        capBnd: ZERO_CAPABILITIES,
        capEff: ZERO_CAPABILITIES,
        capInh: ZERO_CAPABILITIES,
        capPrm: ZERO_CAPABILITIES,
        gid: repeatedId(1000),
        groups: ["1000"],
        noNewPrivs: "1",
        uid: repeatedId(1000),
      },
    },
    version: 3,
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
  process.executable !== null &&
    symlinkSync(process.executable, path.join(processDirectory, "exe"));
}

function runSplitProcessProbeWithCensuses(
  censuses: ControlledCensus[],
  options: {
    boundaryRead?: "missing" | "readable";
    boundaryArgv?: string[];
    denyChildRead?: boolean;
    observerUids?: number[];
    observerGids?: number[];
  } = {},
) {
  const procRoot = mkdtempSync(path.join(os.tmpdir(), "nemoclaw-security-posture-proc-"));
  const report = validReport();
  report.workloadBoundary.argv = options.boundaryArgv ?? report.workloadBoundary.argv;
  try {
    writeProcProcess(procRoot, report.workloadBoundary);
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
        JSON.stringify(options),
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

function capabilitySurfaceProof(
  surface: "connect" | "exec",
  overrides: Partial<Record<"CapInh" | "CapPrm" | "CapEff" | "CapBnd" | "CapAmb", string>> = {},
): string {
  const capabilities = {
    CapInh: ZERO_CAPABILITIES,
    CapPrm: ZERO_CAPABILITIES,
    CapEff: ZERO_CAPABILITIES,
    CapBnd: ZERO_CAPABILITIES,
    CapAmb: ZERO_CAPABILITIES,
    ...overrides,
  };
  return `NEMOCLAW_SECURITY_CAPABILITY_SURFACE surface=${surface} uid=1000 gid=1000 ${Object.entries(
    capabilities,
  )
    .map(([name, value]) => `${name}=${value}`)
    .join(" ")}\n`;
}

function inlineManagedImageCatalogEnvironment(): NodeJS.ProcessEnv {
  const catalog = Object.fromEntries(
    SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => {
      const image = MANAGED_IMAGE_REPOSITORIES[agent];
      const digest = `sha256:${String(index + 1).repeat(64)}`;
      return [
        agent,
        {
          agent,
          capabilityContractVersion: 1,
          contractVersion: 1,
          digest,
          image,
          platform: "linux/amd64",
          reference: `${image}@${digest}`,
          source: {
            cohort: "ghrun-1-1",
            release: "v0.0.124",
            repository: "NVIDIA/NemoClaw",
            revision: MANAGED_IMAGE_REVISION,
          },
          startupProfileContractVersion: 1,
        },
      ];
    }),
  );
  return {
    GITHUB_ACTIONS: "true",
    NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON: JSON.stringify(catalog),
    NEMOCLAW_RUN_LIVE_E2E: "1",
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("security posture fixture", () => {
  it("accepts only the exact stable OpenShell version token", () => {
    expect(parseExpectedOpenShellVersion(successfulProbe("openshell 0.1.3\n"))).toBe("0.1.3");
    expect(() => parseExpectedOpenShellVersion(successfulProbe("openshell 0.1.3-rc.1\n"))).toThrow(
      /expected OpenShell 0\.1\.3/u,
    );
    expect(() => parseExpectedOpenShellVersion(successfulProbe("openshell 0.1.3+dev\n"))).toThrow(
      /expected OpenShell 0\.1\.3/u,
    );
  });

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
    expect(report.workloadBoundary.executable).toBeNull();
    expect(report.childSupervisors.map(({ pid }) => pid)).toEqual([42, 43]);
    expect(report.observedChildSupervisors.map(({ pid }) => pid)).toEqual([42, 43]);
  });

  it.each([
    {
      options: { observerUids: [0, 0, 0] },
      error: /observer must run as the sandbox owner/u,
      name: "root observer",
    },
    {
      options: { observerUids: [1000, 1000, 0] },
      error: /observer must run as the sandbox owner/u,
      name: "saved root identity",
    },
    {
      options: { observerGids: [1001, 1001, 1001] },
      error: /observer must run as the sandbox owner/u,
      name: "wrong observer group",
    },
    {
      options: { boundaryRead: "missing" as const },
      error: /FileNotFoundError/u,
      name: "missing PID 1 executable",
    },
    {
      options: { denyChildRead: true },
      error: /child permission denied/u,
      name: "denied child executable",
    },
  ])("rejects $name without fabricating a process report", ({ options, error }) => {
    const result = runSplitProcessProbeWithCensuses(
      [{ children: [validNemoclawStartProcess()] }],
      options,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(error);
    expect(result.stdout).toBe("");
  });

  it("rejects a readable PID 1 executable instead of claiming nondumpable protection", () => {
    const result = runSplitProcessProbeWithCensuses([{ children: [validNemoclawStartProcess()] }], {
      boundaryRead: "readable",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(() => parseSplitProcessSecurityReport(result.stdout)).toThrow(
      /must deny executable-link access/u,
    );
  });

  it("rejects an unobserved child executable", () => {
    const report = validReport();
    report.childSupervisors[0]!.executable = null;
    expect(() => validateSplitProcessSecurityReport(report)).toThrow(
      /expected the system Bash executable/u,
    );
  });

  it("rejects unexpected boundary arguments without printing them", () => {
    const result = runSplitProcessProbeWithCensuses([{ children: [validNemoclawStartProcess()] }], {
      boundaryArgv: [BOUNDARY_EXECUTABLE, "credential=DO_NOT_LOG"],
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unexpected OpenShell workload boundary command/u);
    expect(result.stdout + result.stderr).not.toContain("DO_NOT_LOG");
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

  it("accepts the non-root workload boundary and nemoclaw-start child supervisor", () => {
    const report = validReport();

    expect(validateSplitProcessSecurityReport(report)).toEqual(report);
    expect(parseSplitProcessSecurityReport(JSON.stringify(report))).toEqual(report);
  });

  it.each(["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"] as const)(
    "rejects a nonzero %s set from an exec child",
    (field) => {
      const reportField = `${field[0]!.toLowerCase()}${field.slice(1)}`;
      expect(() =>
        parseCapabilitySurfaceReport(
          successfulProbe(capabilitySurfaceProof("exec", { [field]: "0000000000000001" })),
          "exec",
          1000,
          1000,
        ),
      ).toThrow(new RegExp(`exec child ${reportField} expected 0`, "u"));
    },
  );

  it.each(["unknown", "toString"])("rejects unreviewed runtime provider %s", (providerId) => {
    expect(() => validateSplitProcessSecurityReport(validReport(), providerId)).toThrow(
      /no reviewed workload boundary/u,
    );
  });

  it("rejects a workload boundary with a root supplementary group", () => {
    const report = validReport();
    report.workloadBoundary.status.groups = ["0"];
    expect(() => validateSplitProcessSecurityReport(report)).toThrow(
      /Groups expected exactly 1000/u,
    );
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
      report.workloadBoundary.status.uid = repeatedId(998);
      report.workloadBoundary.status.gid = repeatedId(sandboxGid);
      report.workloadBoundary.status.groups = [String(sandboxGid)];
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
        report.workloadBoundary.ppid = 2;
      },
      name: "parent process",
    },
    {
      error: /must deny executable-link access/u,
      mutate: (report) => {
        report.workloadBoundary.executable = "/usr/bin/bash";
      },
      name: "executable",
    },
    {
      error: /does not have the expected OpenShell workload boundary command/u,
      mutate: (report) => {
        report.workloadBoundary.argv.push("--unexpected");
      },
      name: "command arguments",
    },
    {
      error: /workload boundary Uid expected 1000/u,
      mutate: (report) => {
        report.workloadBoundary.status.uid = repeatedId(0);
      },
      name: "user identity",
    },
    {
      error: /workload boundary Gid expected 1000/u,
      mutate: (report) => {
        report.workloadBoundary.status.gid = repeatedId(0);
      },
      name: "group identity",
    },
    {
      error: /workload boundary Groups expected exactly 1000/u,
      mutate: (report) => {
        report.workloadBoundary.status.groups = ["0", "44"];
      },
      name: "wrong sandbox supplementary group",
    },
    {
      error: /workload boundary Groups expected exactly 1000/u,
      mutate: (report) => {
        report.workloadBoundary.status.groups = ["0", "1000", "44"];
      },
      name: "extra supplementary group",
    },
    {
      error: /workload boundary Groups expected exactly 1000/u,
      mutate: (report) => {
        report.workloadBoundary.status.groups = ["0", "0"];
      },
      name: "duplicate supplementary group",
    },
    {
      error: /workloadBoundary\.state must be one of D, R, S/u,
      mutate: (report) => {
        report.workloadBoundary.state = "T";
      },
      name: "process state",
    },
    {
      error: /workload boundary\.capInh expected 0/u,
      mutate: (report) => {
        report.workloadBoundary.status.capInh = "0000000000000001";
      },
      name: "inheritable capability",
    },
    {
      error: /workload boundary\.capPrm expected/u,
      mutate: (report) => {
        report.workloadBoundary.status.capPrm = "0000000000000001";
      },
      name: "permitted capability",
    },
    {
      error: /workload boundary\.capEff expected/u,
      mutate: (report) => {
        report.workloadBoundary.status.capEff = "0000000000000001";
      },
      name: "effective capability",
    },
    {
      error: /workload boundary\.capBnd expected/u,
      mutate: (report) => {
        report.workloadBoundary.status.capBnd = "0000000000000001";
      },
      name: "bounding capability",
    },
    {
      error: /workload boundary\.capAmb expected 0/u,
      mutate: (report) => {
        report.workloadBoundary.status.capAmb = "0000000000000001";
      },
      name: "ambient capability",
    },
    {
      error: /workload boundary expected NoNewPrivs=1/u,
      mutate: (report) => {
        report.workloadBoundary.status.noNewPrivs = "0";
      },
      name: "NoNewPrivs",
    },
  ])("rejects OpenShell workload boundary $name drift", ({ error, mutate }) => {
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
      error: /must not replace the OpenShell workload boundary at PID 1/u,
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
      /version must be 3/u,
    );
    expect(() => validateSplitProcessSecurityReport({ ...validReport(), version: 1 })).toThrow(
      /version must be 3/u,
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
    { providerId: "docker", executable: BOUNDARY_EXECUTABLE },
    { providerId: "podman", executable: "/opt/openshell/bin/openshell-sandbox" },
  ])(
    "checks the split-process report through the selected $providerId provider",
    async ({ executable, providerId }) => {
      vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "1");
      vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "1");
      const report = validReport();
      report.workloadBoundary.argv[0] = executable;
      report.sandboxUid = report.sandboxGid = 998;
      setProcessIdentity(report.workloadBoundary, 998);
      setProcessIdentity(report.childSupervisors[0]!, 998);
      const directChildSupervisor = report.childSupervisors[0]!;
      setCurrentChildSupervisors(report, [
        validNemoclawStartProcess({
          pid: 43,
          ppid: directChildSupervisor.pid,
          startTime: "203",
          sandboxUid: 998,
          sandboxGid: 998,
        }),
        directChildSupervisor,
      ]);
      const command = vi
        .fn<HostCliClient["command"]>()
        .mockResolvedValueOnce(successfulProbe("uid=1000 gid=1000\n"))
        .mockResolvedValueOnce(successfulProbe("openshell 0.1.3\n"))
        .mockResolvedValueOnce(
          successfulProbe(
            capabilitySurfaceProof("connect").replace("uid=1000 gid=1000", "uid=998 gid=998"),
          ),
        );
      const execShell = vi.fn<SandboxClient["execShell"]>(async (_name, script) =>
        String(script).includes("surface=exec")
          ? successfulProbe(
              capabilitySurfaceProof("exec").replace("uid=1000 gid=1000", "uid=998 gid=998"),
            )
          : successfulProbe(),
      );
      const host = {
        command,
        commandPath: "/tmp/nemoclaw",
        openshellCommandPath: "/tmp/openshell",
      } as unknown as HostCliClient;
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
      const inspectContainerPair = vi.fn(() => CONTAINER_PAIR);

      const summary = await assertSecurityPosture(host, sandbox, SANDBOX_NAME, "openclaw", {
        environment: inlineManagedImageCatalogEnvironment(),
        inspectContainerPair,
        executePrivilegedCommand,
        resolvePrivilegedTarget,
      });

      expect(summary).toEqual({
        processScope: "workload-container",
        containerPair: CONTAINER_PAIR,
        capabilitySurfaces: {
          connect: {
            surface: "connect",
            uid: 998,
            gid: 998,
            capInh: ZERO_CAPABILITIES,
            capPrm: ZERO_CAPABILITIES,
            capEff: ZERO_CAPABILITIES,
            capBnd: ZERO_CAPABILITIES,
            capAmb: ZERO_CAPABILITIES,
          },
          entrypoint: {
            surface: "entrypoint",
            uid: 998,
            gid: 998,
            capInh: ZERO_CAPABILITIES,
            capPrm: ZERO_CAPABILITIES,
            capEff: ZERO_CAPABILITIES,
            capBnd: ZERO_CAPABILITIES,
            capAmb: ZERO_CAPABILITIES,
          },
          exec: {
            surface: "exec",
            uid: 998,
            gid: 998,
            capInh: ZERO_CAPABILITIES,
            capPrm: ZERO_CAPABILITIES,
            capEff: ZERO_CAPABILITIES,
            capBnd: ZERO_CAPABILITIES,
            capAmb: ZERO_CAPABILITIES,
          },
        },
        configurationBoundary: true,
        hostNonRoot: true,
        rcFilesMutable: true,
        runtimeProxyEnvLocked: true,
        runtimeVersions: {
          managedImageRevision: MANAGED_IMAGE_REVISION,
          openshell: "0.1.3",
        },
        splitProcess: {
          childSupervisor: directChildSupervisor,
          workloadBoundary: report.workloadBoundary,
        },
        startupLogClean: true,
      });
      expect(command).toHaveBeenCalledTimes(3);
      expect(command.mock.calls[2]?.[1]?.[3]).toMatch(/\nexit 0$/u);
      expect(resolvePrivilegedTarget).toHaveBeenCalledTimes(2);
      expect(inspectContainerPair.mock.calls).toEqual([
        [
          SANDBOX_NAME,
          { providerId, resourceHandle: RESOURCE_HANDLE },
          { uid: 998, gid: 998, workdir: "/sandbox" },
        ],
        [
          SANDBOX_NAME,
          { providerId, resourceHandle: RESOURCE_HANDLE },
          { uid: 998, gid: 998, workdir: "/sandbox" },
        ],
      ]);
      expect(executePrivilegedCommand).toHaveBeenCalledWith(
        SANDBOX_NAME,
        ["/usr/bin/python3", "-I", "-c", SPLIT_PROCESS_SECURITY_PROBE],
        {
          expectedResourceHandle: RESOURCE_HANDLE,
          sandboxUser: "998:998",
          sanitizeEnvironment: true,
          timeout: 30_000,
        },
      );
      expect(execShell).toHaveBeenCalledTimes(5);
      const sandboxScripts = execShell.mock.calls.map((call) => String(call[1]));
      expect(sandboxScripts.some((script) => script.includes("openclaw config validate"))).toBe(
        true,
      );
      expect(
        sandboxScripts.some((script) => script.includes("cannot modify config inside the sandbox")),
      ).toBe(false);

      command
        .mockReset()
        .mockResolvedValueOnce(successfulProbe("uid=1000 gid=1000\n"))
        .mockResolvedValueOnce(successfulProbe("openshell 0.1.3\n"));
      execShell.mockClear();
      inspectContainerPair
        .mockReset()
        .mockReturnValueOnce(CONTAINER_PAIR)
        .mockReturnValueOnce({
          ...CONTAINER_PAIR,
          supervisor: { ...CONTAINER_PAIR.supervisor, pid: 999 },
        });
      await expect(
        assertSecurityPosture(host, sandbox, SANDBOX_NAME, "openclaw", {
          environment: inlineManagedImageCatalogEnvironment(),
          inspectContainerPair,
          executePrivilegedCommand,
          resolvePrivilegedTarget,
        }),
      ).rejects.toThrow(/container pair changed/u);
      expect(execShell).not.toHaveBeenCalled();
    },
  );

  it("rejects a report for a different managed-image owner before child commands", async () => {
    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "1");
    vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "1");
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce(successfulProbe("uid=1000 gid=1000\n"))
      .mockResolvedValueOnce(successfulProbe("openshell 0.1.3\n"));
    const execShell = vi.fn<SandboxClient["execShell"]>();
    const executePrivilegedCommand = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: Buffer.from(JSON.stringify(validReport())),
      stderr: Buffer.alloc(0),
    }));
    await expect(
      assertSecurityPosture(
        { command, openshellCommandPath: "/tmp/openshell" } as unknown as HostCliClient,
        { execShell } as unknown as SandboxClient,
        SANDBOX_NAME,
        "hermes",
        {
          environment: inlineManagedImageCatalogEnvironment(),
          inspectContainerPair: () => CONTAINER_PAIR,
          executePrivilegedCommand,
          resolvePrivilegedTarget: () => ({
            providerId: "docker",
            resourceHandle: RESOURCE_HANDLE,
          }),
        },
      ),
    ).rejects.toThrow(/different managed-image sandbox identity/u);
    expect(executePrivilegedCommand).toHaveBeenCalledWith(
      SANDBOX_NAME,
      expect.any(Array),
      expect.objectContaining({ sandboxUser: "998:999", expectedResourceHandle: RESOURCE_HANDLE }),
    );
    expect(execShell).not.toHaveBeenCalled();
  });

  it("rejects runtime provider resource identity drift during privileged inspection", async () => {
    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "1");
    vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "1");
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce(successfulProbe("uid=1000 gid=1000\n"))
      .mockResolvedValueOnce(successfulProbe("openshell 0.1.3\n"));
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
        { command, openshellCommandPath: "/tmp/openshell" } as unknown as HostCliClient,
        { execShell } as unknown as SandboxClient,
        SANDBOX_NAME,
        "openclaw",
        {
          environment: inlineManagedImageCatalogEnvironment(),
          inspectContainerPair: () => CONTAINER_PAIR,
          executePrivilegedCommand,
          resolvePrivilegedTarget,
        },
      ),
    ).rejects.toThrow(/runtime provider resource identity changed/u);

    expect(command).toHaveBeenCalledTimes(2);
    expect(executePrivilegedCommand).toHaveBeenCalledOnce();
    expect(execShell).not.toHaveBeenCalled();
  });

  it("rejects a failed provider-owned privileged security probe", async () => {
    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "1");
    vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "1");
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce(successfulProbe("uid=1000 gid=1000\n"))
      .mockResolvedValueOnce(successfulProbe("openshell 0.1.3\n"));
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
        { command, openshellCommandPath: "/tmp/openshell" } as unknown as HostCliClient,
        { execShell } as unknown as SandboxClient,
        SANDBOX_NAME,
        "openclaw",
        {
          environment: inlineManagedImageCatalogEnvironment(),
          inspectContainerPair: () => CONTAINER_PAIR,
          executePrivilegedCommand,
          resolvePrivilegedTarget,
        },
      ),
    ).rejects.toThrow(/provider probe failed/u);

    expect(command).toHaveBeenCalledTimes(2);
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
