// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  assertSecurityPosture,
  dockerRuntimeEndpointArgs,
  OPENSHELL_SUPERVISOR_CAPABILITY_MASK,
  parseOpenShellContainerId,
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
const CONTAINER_ID = "a".repeat(64);
const SANDBOX_NAME = "secure-sandbox";
const SANDBOX_ID = "sandbox-id";
const CONTAINER_NAME = `openshell-default--${SANDBOX_NAME}-${SANDBOX_ID}`;
const PORTABLE_DOCKER_HOST = "unix:///run/user/1000/podman/podman.sock";

type ReportMutationCase = {
  error: RegExp;
  mutate: (report: SplitProcessSecurityReport) => void;
  name: string;
};

function repeatedId(id: number): string[] {
  return Array.from({ length: 4 }, () => String(id));
}

function validReport(): SplitProcessSecurityReport {
  return {
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
        groups: ["0"],
        noNewPrivs: "1",
        uid: repeatedId(0),
      },
    },
    version: 1,
    childSupervisors: [
      {
        argv: ["/usr/bin/bash", "/usr/local/bin/nemoclaw-start"],
        executable: "/usr/bin/bash",
        pid: 42,
        ppid: 1,
        state: "S",
        startTime: "202",
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
    ],
  };
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
      error: /supervisor Groups expected only 0/u,
      mutate: (report) => {
        report.supervisor.status.groups = ["0", "44"];
      },
      name: "supplementary groups",
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
    [0, /found 0/u],
    [2, /found 2/u],
  ])("rejects a census with %i nemoclaw-start child supervisors", (count, error) => {
    const report = validReport();
    report.childSupervisors = Array.from(
      { length: count },
      () => validReport().childSupervisors[0]!,
    );

    expect(() => validateSplitProcessSecurityReport(report)).toThrow(error);
  });

  it.each<ReportMutationCase>([
    {
      error: /direct PID 1 child/u,
      mutate: (report) => {
        report.childSupervisors[0]!.ppid = 10;
      },
      name: "that is not a direct child of PID 1",
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
      error: /child supervisor Uid expected 1000/u,
      mutate: (report) => {
        report.childSupervisors[0]!.status.uid = repeatedId(0);
      },
      name: "that runs as root",
    },
    {
      error: /child supervisor Uid expected 1000/u,
      mutate: (report) => {
        report.childSupervisors[0]!.status.uid = repeatedId(1001);
      },
      name: "with a different non-root user",
    },
    {
      error: /child supervisor Gid expected 1000/u,
      mutate: (report) => {
        report.childSupervisors[0]!.status.gid = repeatedId(1001);
      },
      name: "with a different non-root group",
    },
    {
      error: /child supervisor Groups expected only 1000/u,
      mutate: (report) => {
        report.childSupervisors[0]!.status.groups = ["0", "1000"];
      },
      name: "with a privileged supplementary group",
    },
    {
      error: /child supervisor expected NoNewPrivs=1/u,
      mutate: (report) => {
        report.childSupervisors[0]!.status.noNewPrivs = "0";
      },
      name: "without NoNewPrivs",
    },
  ])("rejects a nemoclaw-start child supervisor $name", ({ error, mutate }) => {
    const report = validReport();
    mutate(report);

    expect(() => validateSplitProcessSecurityReport(report)).toThrow(error);
  });

  it.each([
    "capInh",
    "capPrm",
    "capEff",
    "capBnd",
    "capAmb",
  ] as const)("rejects a nemoclaw-start child supervisor with a nonzero %s set", (field) => {
    const report = validReport();
    report.childSupervisors[0]!.status[field] = "0000000000000001";

    expect(() => validateSplitProcessSecurityReport(report)).toThrow(
      new RegExp(`child supervisor\\.${field} expected 0`, "u"),
    );
  });

  it("rejects malformed and overflowing split-process reports", () => {
    expect(() => parseSplitProcessSecurityReport("not-json")).toThrow(/emitted invalid JSON/u);
    expect(() => validateSplitProcessSecurityReport({ childSupervisors: [] })).toThrow(
      /version must be 1/u,
    );

    const malformed = { ...validReport(), childSupervisors: "one" };
    expect(() => validateSplitProcessSecurityReport(malformed)).toThrow(
      /childSupervisors must be an array/u,
    );

    const overflow = validReport();
    overflow.observedProcEntries = 32_769;
    expect(() => validateSplitProcessSecurityReport(overflow)).toThrow(
      /exceeded 32768 process entries/u,
    );
  });

  it("selects one exact OpenShell container identity", () => {
    const row = `${CONTAINER_ID}\t${CONTAINER_NAME}\t${SANDBOX_ID}\tdefault\n`;

    expect(parseOpenShellContainerId(row, SANDBOX_NAME)).toBe(CONTAINER_ID);
  });

  it("derives Docker discovery from the privileged execution endpoint", () => {
    expect(dockerRuntimeEndpointArgs(["exec", "--user", "root"])).toEqual([]);
    expect(
      dockerRuntimeEndpointArgs(["--host", PORTABLE_DOCKER_HOST, "exec", "--user", "root"]),
    ).toEqual(["--host", PORTABLE_DOCKER_HOST]);
    expect(() => dockerRuntimeEndpointArgs(["--host", "", "exec"])).toThrow(
      /supported runtime endpoint/u,
    );
    expect(() => dockerRuntimeEndpointArgs(["--context", "remote", "exec"])).toThrow(
      /supported runtime endpoint/u,
    );
  });

  it.each([
    ["", /found 0/u],
    [
      `${CONTAINER_ID}\t${CONTAINER_NAME}\t${SANDBOX_ID}\tdefault\n${"b".repeat(64)}\t${CONTAINER_NAME}\t${SANDBOX_ID}\tdefault`,
      /found 2/u,
    ],
    [
      `abc\t${CONTAINER_NAME}\t${SANDBOX_ID}\tdefault`,
      /unexpected OpenShell Docker container identity/u,
    ],
    [
      `${CONTAINER_ID}\twrong-name\t${SANDBOX_ID}\tdefault`,
      /unexpected OpenShell Docker container identity/u,
    ],
    [
      `${CONTAINER_ID}\t${CONTAINER_NAME}\t${SANDBOX_ID}\tother`,
      /unexpected OpenShell Docker container identity/u,
    ],
    [
      `${CONTAINER_ID}\t${CONTAINER_NAME}\tunsafe/id\tdefault`,
      /unexpected OpenShell Docker container identity/u,
    ],
  ])("rejects a container selection that is absent, ambiguous, or inexact", (output, error) => {
    expect(() => parseOpenShellContainerId(output, SANDBOX_NAME)).toThrow(error);
  });

  it.each([
    ["direct Docker", []],
    ["portable container runtime", ["--host", PORTABLE_DOCKER_HOST]],
  ])("checks the split-process report through %s before the remaining posture", async (_runtime, dockerEndpointArgs) => {
    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "1");
    vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "1");
    vi.stubEnv("DOCKER_HOST", "unix:///run/trusted-docker.sock");
    vi.stubEnv("DOCKER_CONTEXT", "untrusted-context");
    vi.stubEnv("DOCKER_CONFIG", "/tmp/untrusted-docker-config");
    vi.stubEnv("DOCKER_TLS_VERIFY", "1");
    vi.stubEnv("DOCKER_CERT_PATH", "/tmp/untrusted-docker-certs");
    const report = validReport();
    const containerRow = `${CONTAINER_ID}\t${CONTAINER_NAME}\t${SANDBOX_ID}\tdefault\n`;
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce(successfulProbe("uid=1000 gid=1000\n"))
      .mockResolvedValueOnce(successfulProbe(containerRow))
      .mockResolvedValueOnce(successfulProbe(JSON.stringify(report)));
    const execShell = vi.fn<SandboxClient["execShell"]>(async () => successfulProbe());
    const host = { command } as unknown as HostCliClient;
    const sandbox = { execShell } as unknown as SandboxClient;
    const privilegedProbeArgs = [
      ...dockerEndpointArgs,
      "exec",
      "--env",
      "LD_PRELOAD=",
      "--env",
      "PYTHONPATH=",
      "--user",
      "root",
      CONTAINER_ID,
      "/usr/bin/python3",
      "-I",
      "-c",
      SPLIT_PROCESS_SECURITY_PROBE,
    ];
    const privilegedExecArgv = vi.fn(
      (
        _sandboxName: string,
        _command: string[],
        _stdin?: boolean,
        _sanitizeEnvironment?: boolean,
        _expectedContainerId?: string,
      ) => privilegedProbeArgs,
    );

    const summary = await assertSecurityPosture(host, sandbox, SANDBOX_NAME, "openclaw", {
      privilegedExecArgv,
    });

    expect(summary).toEqual({
      configureGuard: true,
      hostNonRoot: true,
      rcFilesLocked: true,
      runtimeProxyEnvLocked: true,
      splitProcess: {
        childSupervisor: report.childSupervisors[0],
        supervisor: report.supervisor,
      },
      startupLogClean: true,
    });
    expect(command).toHaveBeenCalledTimes(3);
    expect(command).toHaveBeenNthCalledWith(
      2,
      "docker",
      [
        ...dockerEndpointArgs,
        "ps",
        "--no-trunc",
        "--filter",
        "label=openshell.ai/managed-by=openshell",
        "--filter",
        `label=openshell.ai/sandbox-name=${SANDBOX_NAME}`,
        "--format",
        '{{.ID}}\t{{.Names}}\t{{.Label "openshell.ai/sandbox-id"}}\t{{.Label "openshell.ai/sandbox-workspace"}}',
      ],
      expect.objectContaining({ artifactName: "security-posture-container-identity" }),
    );
    expect(command).toHaveBeenNthCalledWith(
      3,
      "docker",
      privilegedProbeArgs,
      expect.objectContaining({ artifactName: "security-posture-split-processes" }),
    );
    expect(privilegedExecArgv).toHaveBeenNthCalledWith(
      1,
      SANDBOX_NAME,
      ["/usr/bin/python3", "-I", "-c", SPLIT_PROCESS_SECURITY_PROBE],
      false,
      true,
    );
    expect(privilegedExecArgv).toHaveBeenNthCalledWith(
      2,
      SANDBOX_NAME,
      ["/usr/bin/python3", "-I", "-c", SPLIT_PROCESS_SECURITY_PROBE],
      false,
      true,
      CONTAINER_ID,
    );
    for (const callIndex of [1, 2]) {
      const dockerEnv = command.mock.calls[callIndex]?.[2]?.env;
      expect(dockerEnv).toMatchObject({ DOCKER_HOST: "unix:///run/trusted-docker.sock" });
      expect(dockerEnv).not.toHaveProperty("DOCKER_CONTEXT");
      expect(dockerEnv).not.toHaveProperty("DOCKER_CONFIG");
      expect(dockerEnv).not.toHaveProperty("DOCKER_TLS_VERIFY");
      expect(dockerEnv).not.toHaveProperty("DOCKER_CERT_PATH");
    }
    expect(execShell).toHaveBeenCalledTimes(4);
  });

  it("rejects container runtime endpoint drift before privileged inspection", async () => {
    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "1");
    vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "1");
    const containerRow = `${CONTAINER_ID}\t${CONTAINER_NAME}\t${SANDBOX_ID}\tdefault\n`;
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce(successfulProbe("uid=1000 gid=1000\n"))
      .mockResolvedValueOnce(successfulProbe(containerRow));
    const execShell = vi.fn<SandboxClient["execShell"]>();
    let invocation = 0;
    const privilegedExecArgv = vi.fn(
      (
        _sandboxName: string,
        _command: string[],
        _stdin?: boolean,
        _sanitizeEnvironment?: boolean,
        _expectedContainerId?: string,
      ) => [
        "--host",
        invocation++ === 0 ? "unix:///run/podman-a.sock" : "unix:///run/podman-b.sock",
        "exec",
      ],
    );

    await expect(
      assertSecurityPosture(
        { command } as unknown as HostCliClient,
        { execShell } as unknown as SandboxClient,
        SANDBOX_NAME,
        "openclaw",
        { privilegedExecArgv },
      ),
    ).rejects.toThrow(/runtime endpoint changed/u);

    expect(command).toHaveBeenCalledTimes(2);
    expect(execShell).not.toHaveBeenCalled();
  });

  it("rejects Docker environment drift before privileged inspection", async () => {
    vi.stubEnv("NEMOCLAW_E2E_SECURITY_POSTURE", "1");
    vi.stubEnv("NEMOCLAW_E2E_EXPECT_OPENSHELL_SPLIT_PROCESS", "1");
    vi.stubEnv("DOCKER_HOST", "unix:///run/docker-a.sock");
    const containerRow = `${CONTAINER_ID}\t${CONTAINER_NAME}\t${SANDBOX_ID}\tdefault\n`;
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce(successfulProbe("uid=1000 gid=1000\n"))
      .mockImplementationOnce(async () => {
        vi.stubEnv("DOCKER_HOST", "unix:///run/docker-b.sock");
        return successfulProbe(containerRow);
      });
    const execShell = vi.fn<SandboxClient["execShell"]>();
    const privilegedExecArgv = vi.fn(
      (
        _sandboxName: string,
        _command: string[],
        _stdin?: boolean,
        _sanitizeEnvironment?: boolean,
        _expectedContainerId?: string,
      ) => ["exec"],
    );

    await expect(
      assertSecurityPosture(
        { command } as unknown as HostCliClient,
        { execShell } as unknown as SandboxClient,
        SANDBOX_NAME,
        "openclaw",
        { privilegedExecArgv },
      ),
    ).rejects.toThrow(/privileged Docker environment changed/u);

    expect(privilegedExecArgv).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledTimes(2);
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
