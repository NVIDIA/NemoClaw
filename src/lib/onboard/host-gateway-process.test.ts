// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  getDockerDriverGatewayRuntimeMarkerPath,
  writeDockerDriverGatewayRuntimeMarkerForStateDir,
} from "./docker-driver-gateway-runtime-marker";
import {
  clearHostGatewayRuntimeFiles,
  HOST_GATEWAY_PGREP_PATTERN,
  type HostGatewayProcessDeps,
  isHostPortFree,
  type RunResult,
  stopHostGatewayProcesses,
} from "./host-gateway-process";

const PGREP_KEY = `pgrep -f ${HOST_GATEWAY_PGREP_PATTERN}`;

interface RunArgs {
  args: string[];
  command: string;
}

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function notFound(): RunResult {
  return { status: 1, stdout: "", stderr: "" };
}

function makeRun(responses: Map<string, RunResult | ((args: string[]) => RunResult)>): {
  calls: RunArgs[];
  run: HostGatewayProcessDeps["run"];
} {
  const calls: RunArgs[] = [];
  const run: HostGatewayProcessDeps["run"] = (command, args) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(" ")}`;
    const exact = responses.get(key);
    if (exact !== undefined) {
      return typeof exact === "function" ? exact(args) : exact;
    }
    if (command === "pgrep") return notFound();
    if (command === "ps") return notFound();
    return ok();
  };
  return { calls, run };
}

function psResponses(
  pid: number,
  opts: {
    cmdline?: string;
    exited: Set<number>;
    owner?: string;
  },
): [string, RunResult | ((args: string[]) => RunResult)][] {
  return [
    [`ps -p ${pid} -o pid=`, () => (opts.exited.has(pid) ? notFound() : ok(`${pid}\n`))],
    [`ps -p ${pid} -o user=`, ok(`${opts.owner ?? "tester"}\n`)],
    [
      `ps -p ${pid} -o args=`,
      ok(opts.cmdline ?? `/home/test/.local/bin/openshell-gateway --port 8080\n`),
    ],
  ];
}

const CURRENT_UID = typeof process.getuid === "function" ? process.getuid() : 1_000;

type ScopedGatewayFixtureOptions = {
  cmdline?: string;
  compatContainerPid?: number;
  listenerPids?: readonly number[];
  markerPid?: number;
  markerPort?: number;
  omitMarker?: boolean;
  omitPidFile?: boolean;
  pidFilePid?: number;
  portFree?: boolean;
  processAlive?: boolean;
  processExecutable?: string | null;
  processUid?: number;
  startIdentities?: readonly string[];
  usePgrepFallback?: boolean;
};

function scopedGatewayFixture(options: ScopedGatewayFixtureOptions = {}) {
  const selectedPid = 9_991_880;
  const siblingPid = 9_990_808;
  const selectedPort = 18_080;
  const selectedName = "nemoclaw-18080";
  const directGatewayBin = "/opt/openshell/openshell";
  const selectedCompatContainerName = "nemoclaw-openshell-gateway-18080";
  const selectedCompatContainerId = "a".repeat(64);
  const siblingCompatContainerName = "nemoclaw-openshell-gateway";
  const selectedStateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nemoclaw-host-gateway-scoped-selected-"),
  );
  const siblingStateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nemoclaw-host-gateway-scoped-sibling-"),
  );
  const selectedPidFile = path.join(selectedStateDir, "openshell-gateway.pid");
  const siblingPidFile = path.join(siblingStateDir, "openshell-gateway.pid");
  const selectedCmdline =
    options.cmdline ??
    `${directGatewayBin} gateway start --name ${selectedName} --port ${String(selectedPort)}\n`;
  const compatibilityMode = selectedCmdline.includes("/opt/nemoclaw/openshell-gateway");
  const writeSelectedPidFile = options.omitPidFile
    ? () => undefined
    : () => fs.writeFileSync(selectedPidFile, `${String(options.pidFilePid ?? selectedPid)}\n`);
  writeSelectedPidFile();
  fs.writeFileSync(siblingPidFile, `${String(siblingPid)}\n`);
  const writeSelectedMarker = options.omitMarker
    ? () => undefined
    : () =>
        writeDockerDriverGatewayRuntimeMarkerForStateDir(selectedStateDir, {
          desiredEnv: {},
          dockerHost: null,
          endpoint: `https://127.0.0.1:${String(options.markerPort ?? selectedPort)}`,
          gatewayBin: compatibilityMode ? null : directGatewayBin,
          pid: options.markerPid ?? selectedPid,
        });
  writeSelectedMarker();
  writeDockerDriverGatewayRuntimeMarkerForStateDir(siblingStateDir, {
    desiredEnv: {},
    endpoint: "https://127.0.0.1:8080",
    pid: siblingPid,
  });

  const recordedPid = options.pidFilePid ?? selectedPid;
  const exited = new Set<number>(options.processAlive === false ? [recordedPid] : []);
  const compatContainerPid = options.compatContainerPid;
  const compatibilityResponses: [string, RunResult | ((args: string[]) => RunResult)][] =
    compatContainerPid === undefined
      ? []
      : [
          [
            `docker inspect --type container ${selectedCompatContainerName}`,
            ok(
              `${JSON.stringify([
                {
                  Args: [],
                  HostConfig: { NetworkMode: "host" },
                  Id: selectedCompatContainerId,
                  Name: `/${selectedCompatContainerName}`,
                  Path: "/opt/nemoclaw/openshell-gateway",
                  State: { Pid: compatContainerPid, Running: true },
                },
              ])}\n`,
            ),
          ],
          [
            `docker rm -f ${selectedCompatContainerId}`,
            () => {
              exited.add(recordedPid);
              return ok(`${selectedCompatContainerName}\n`);
            },
          ],
        ];
  const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
    // A host-wide fallback would discover both gateways. Scoped teardown must
    // never execute this response.
    [PGREP_KEY, ok(`${String(siblingPid)}\n${String(selectedPid)}\n`)],
    [
      `ps -p ${String(recordedPid)} -o pid=`,
      () => (exited.has(recordedPid) ? notFound() : ok(`${String(recordedPid)}\n`)),
    ],
    [`ps -p ${String(recordedPid)} -o uid=`, ok(`${String(options.processUid ?? CURRENT_UID)}\n`)],
    [`ps -p ${String(recordedPid)} -o args=`, ok(selectedCmdline)],
    [
      `lsof -ti :${String(selectedPort)} -sTCP:LISTEN`,
      ok((options.listenerPids ?? [recordedPid]).map(String).join("\n") + "\n"),
    ],
    ...compatibilityResponses,
  ]);
  const { calls, run } = makeRun(responses);
  let startIdentityRead = 0;
  const signalHandlers = new Map<NodeJS.Signals | number | undefined, (pid: number) => void>([
    ["SIGKILL", (pid) => void exited.add(pid)],
  ]);
  const kill = vi.fn<HostGatewayProcessDeps["kill"]>((pid, signal) => {
    signalHandlers.get(signal)?.(pid);
    return true;
  });

  const result = stopHostGatewayProcesses(
    {
      run,
      kill,
      env: { USER: "tester" },
      commandExists: () => true,
      dockerForceRm: (containerId) => run("docker", ["rm", "-f", containerId]),
      dockerInspect: (args) => run("docker", ["inspect", ...args]),
      isPortFree: () => options.portFree ?? true,
      log: vi.fn(),
      readProcessExecutable: () =>
        options.processExecutable === undefined ? directGatewayBin : options.processExecutable,
      readProcessEnvironment: () => ({}),
      readProcessStartIdentity: (pid) => {
        const identities = options.startIdentities ?? ["fixture-start-identity"];
        const identity = identities[Math.min(startIdentityRead, identities.length - 1)] ?? null;
        startIdentityRead += 1;
        return exited.has(pid) ? null : identity;
      },
    },
    {
      killWaitMs: 0,
      gatewayBin: directGatewayBin,
      openShellGatewayName: selectedName,
      openShellGatewayPort: selectedPort,
      pollIntervalMs: 0,
      scopedGatewayStop: true,
      stateDir: selectedStateDir,
      usePgrepFallback: options.usePgrepFallback,
    },
  );

  return {
    calls,
    cleanup: () => {
      fs.rmSync(selectedStateDir, { recursive: true, force: true });
      fs.rmSync(siblingStateDir, { recursive: true, force: true });
    },
    kill,
    recordedPid,
    result,
    selectedPid,
    selectedPidFile,
    selectedCompatContainerName,
    selectedCompatContainerId,
    selectedRuntimeMarker: getDockerDriverGatewayRuntimeMarkerPath(selectedStateDir),
    siblingCompatContainerName,
    siblingPid,
    siblingPidFile,
    siblingRuntimeMarker: getDockerDriverGatewayRuntimeMarkerPath(siblingStateDir),
  };
}

describe("host gateway cleanup boundaries", () => {
  it.each([
    ["free", 0, true],
    ["occupied", 1, false],
    ["inconclusive", null, false],
  ] as const)("reports a host port as %s from the bind probe", (_case, status, expected) => {
    const spawnSyncImpl = vi.fn(() => ({
      status,
    })) as unknown as typeof import("node:child_process").spawnSync;

    expect(isHostPortFree(8080, spawnSyncImpl)).toBe(expected);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      process.execPath,
      ["-e", expect.stringContaining("server.listen(8080, '127.0.0.1'")],
      { stdio: "ignore", timeout: 2_000 },
    );
  });

  it("clears the exact gateway PID file and runtime marker", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-clear-"));
    try {
      const pidFile = path.join(stateDir, "openshell-gateway.pid");
      const markerFile = path.join(stateDir, "runtime.json");
      const unrelatedFile = path.join(stateDir, "unrelated.txt");
      fs.writeFileSync(pidFile, "4242\n");
      fs.writeFileSync(markerFile, "{}\n");
      fs.writeFileSync(unrelatedFile, "keep\n");

      clearHostGatewayRuntimeFiles(stateDir, pidFile);

      expect(fs.existsSync(pidFile)).toBe(false);
      expect(fs.existsSync(markerFile)).toBe(false);
      expect(fs.existsSync(unrelatedFile)).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves the gateway PID file when runtime marker removal fails", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-clear-"));
    const pidFile = path.join(stateDir, "openshell-gateway.pid");
    const markerFile = path.join(stateDir, "runtime.json");
    fs.writeFileSync(pidFile, "4242\n");
    fs.writeFileSync(markerFile, "{}\n");
    const rmSync = vi.spyOn(fs, "rmSync").mockImplementation((candidate) => {
      expect(candidate).toBe(markerFile);
      throw new Error("marker cleanup failed");
    });

    try {
      expect(() => clearHostGatewayRuntimeFiles(stateDir, pidFile)).toThrow(
        "marker cleanup failed",
      );
      expect(fs.existsSync(pidFile)).toBe(true);
    } finally {
      rmSync.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("stopHostGatewayProcesses", () => {
  it("uses pgrep fallback when the Docker-driver gateway PID file is missing", () => {
    const exited = new Set<number>();
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      [PGREP_KEY, ok("9999887\n")],
      ...psResponses(9999887, { exited }),
    ]);
    const { run } = makeRun(responses);
    const kill = vi.fn<HostGatewayProcessDeps["kill"]>((pid) => {
      exited.add(pid);
      return true;
    });
    const log = vi.fn();

    const result = stopHostGatewayProcesses(
      { run, kill, env: { USER: "tester" }, commandExists: () => true, log },
      { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-")) },
    );

    expect(result.stopped).toEqual([9999887]);
    expect(kill).toHaveBeenCalledWith(9999887, "SIGTERM");
    expect(log).toHaveBeenCalledWith("Stopped host openshell-gateway process 9999887");
  });

  it("polls for host gateway exit before escalating to SIGKILL", () => {
    const pid = 9999333;
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    let pidChecks = 0;
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      [PGREP_KEY, ok(`${pid}\n`)],
      [`ps -p ${pid} -o user=`, ok("tester\n")],
      [`ps -p ${pid} -o args=`, ok("/home/test/.local/bin/openshell-gateway --port 8080\n")],
      [
        `ps -p ${pid} -o pid=`,
        () => {
          pidChecks += 1;
          return pidChecks >= 3 ? notFound() : ok(`${pid}\n`);
        },
      ],
    ]);
    const { run } = makeRun(responses);
    const kill = vi.fn<HostGatewayProcessDeps["kill"]>((_pid, signal) => {
      signals.push(signal);
      return true;
    });

    const result = stopHostGatewayProcesses(
      { run, kill, env: { USER: "tester" }, commandExists: () => true, log: vi.fn() },
      {
        pollIntervalMs: 0,
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-")),
        termWaitMs: 20,
      },
    );

    expect(result.stopped).toEqual([pid]);
    expect(signals).toEqual(["SIGTERM"]);
    expect(pidChecks).toBe(3);
  });

  it("accepts the docker-compat parent PID whose argv0 is docker", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-"));
    const pidFile = path.join(stateDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, "9999551\n");
    const exited = new Set<number>();
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      [PGREP_KEY, notFound()],
      ...psResponses(9999551, {
        cmdline:
          "/usr/bin/docker run --rm --name nemoclaw-openshell-gateway --network host /opt/nemoclaw/openshell-gateway\n",
        exited,
      }),
    ]);
    const { run } = makeRun(responses);
    const kill = vi.fn<HostGatewayProcessDeps["kill"]>((pid, signal) => {
      switch (signal) {
        case "SIGTERM":
          exited.add(pid);
          break;
      }
      return true;
    });

    const result = stopHostGatewayProcesses(
      { run, kill, env: { USER: "tester" }, commandExists: () => true, log: vi.fn() },
      { stateDir },
    );

    expect(result.stopped).toEqual([9999551]);
    expect(kill).toHaveBeenCalledWith(9999551, "SIGTERM");
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("accepts the OpenShell CLI gateway-start process recorded in the PID file", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-"));
    const pidFile = path.join(stateDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, "9999552\n");
    const exited = new Set<number>();
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      [PGREP_KEY, notFound()],
      ...psResponses(9999552, {
        cmdline: "/Users/test/.local/bin/openshell gateway start --name nemoclaw --port 8080\n",
        exited,
      }),
    ]);
    const { run } = makeRun(responses);
    const kill = vi.fn<HostGatewayProcessDeps["kill"]>((pid, signal) => {
      switch (signal) {
        case "SIGTERM":
          exited.add(pid);
          break;
      }
      return true;
    });

    const result = stopHostGatewayProcesses(
      { run, kill, env: { USER: "tester" }, commandExists: () => true, log: vi.fn() },
      { stateDir },
    );

    expect(result.stopped).toEqual([9999552]);
    expect(kill).toHaveBeenCalledWith(9999552, "SIGTERM");
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("rejects a PID whose argv0 is not docker even if it touches the mount path", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-"));
    const pidFile = path.join(stateDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, "9999662\n");
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      [PGREP_KEY, notFound()],
      ...psResponses(9999662, {
        cmdline: "/usr/bin/vim /opt/nemoclaw/openshell-gateway\n",
        exited: new Set(),
      }),
    ]);
    const { run } = makeRun(responses);
    const kill = vi.fn<HostGatewayProcessDeps["kill"]>(() => true);

    const result = stopHostGatewayProcesses(
      { run, kill, env: { USER: "tester" }, commandExists: () => true, log: vi.fn() },
      { stateDir },
    );

    expect(result.skippedNonMatchingPids).toEqual([9999662]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("warns instead of claiming success when pgrep is unavailable", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-"));
    const { run } = makeRun(new Map());
    const warn = vi.fn();
    const log = vi.fn();

    const result = stopHostGatewayProcesses(
      {
        run,
        kill: () => true,
        env: { USER: "tester" },
        commandExists: (cmd) => cmd !== "pgrep",
        warn,
        log,
      },
      { logNoProcesses: true, stateDir },
    );

    expect(result.stopped).toEqual([]);
    expect(result.orphanScanComplete).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "pgrep not found; could not scan for orphan host openshell-gateway processes. " +
        "Inspect any remaining listener and stop only the matching gateway process.",
    );
    expect(log).not.toHaveBeenCalledWith("No host openshell-gateway processes found");
  });

  it("ignores unrelated command lines that merely mention openshell-gateway", () => {
    const exited = new Set<number>();
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      [PGREP_KEY, ok("9999111\n9999222\n")],
      ...psResponses(9999111, { exited }),
      ...psResponses(9999222, {
        cmdline: "node /home/test/.npm-global/bin/codex issue text mentions openshell-gateway\n",
        exited,
      }),
    ]);
    const { run } = makeRun(responses);
    const kill = vi.fn<HostGatewayProcessDeps["kill"]>((pid, signal) => {
      if (pid === 9999111 && signal === "SIGTERM") exited.add(pid);
      return true;
    });

    const result = stopHostGatewayProcesses(
      { run, kill, env: { USER: "tester" }, commandExists: () => true, log: vi.fn() },
      { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-")) },
    );

    expect(result.stopped).toEqual([9999111]);
    expect(result.skippedNonMatchingPids).toEqual([9999222]);
    expect(kill).not.toHaveBeenCalledWith(9999222, expect.anything());
  });

  it("prints sudo remediation when a privileged host gateway cannot be killed", () => {
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      [PGREP_KEY, ok("9999042\n")],
      ...psResponses(9999042, { exited: new Set(), owner: "root" }),
    ]);
    const { run } = makeRun(responses);
    const warn = vi.fn();

    const result = stopHostGatewayProcesses(
      {
        run,
        kill: () => false,
        env: { USER: "tester" },
        commandExists: () => true,
        warn,
      },
      {
        killWaitMs: 0,
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-")),
        termWaitMs: 0,
      },
    );

    expect(result.failed).toEqual([9999042]);
    expect(result.sudoRemediationPids).toEqual([9999042]);
    expect(warn).toHaveBeenCalledWith(
      "Cannot stop root-owned host openshell-gateway process 9999042. Run: sudo kill -9 9999042",
    );
  });

  it("skips pgrep sweep when explicit PIDs are passed (drift restart)", () => {
    // Use a PID above the Linux kernel pid_max default (4194304) so that the
    // production code's `/proc/<pid>/cmdline` probe always misses and the
    // mocked `ps -o args=` response wins. Without this guard a real process
    // happening to hold the chosen PID on a busy CI runner makes the
    // cmdline-matcher reject the candidate and the test flakes.
    const driftPid = 9999777;
    const exited = new Set<number>();
    const pgrepCalls: string[][] = [];
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      ...psResponses(driftPid, { exited }),
    ]);
    const { run } = makeRun(responses);
    // Wrap run so we can detect any pgrep invocation: pgrep MUST NOT run when
    // an explicit drift PID is supplied.
    const tracedRun: HostGatewayProcessDeps["run"] = (command, args) => {
      if (command === "pgrep") pgrepCalls.push(args);
      return run(command, args);
    };
    const kill = vi.fn<HostGatewayProcessDeps["kill"]>((pid, signal) => {
      if (signal === "SIGTERM") exited.add(pid);
      return true;
    });

    const result = stopHostGatewayProcesses(
      { run: tracedRun, kill, env: { USER: "tester" }, commandExists: () => true, log: vi.fn() },
      {
        pids: [driftPid],
        stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-")),
      },
    );

    expect(result.stopped).toEqual([driftPid]);
    expect(pgrepCalls).toEqual([]);
  });

  it("clears stale PID files and still scans for orphaned host gateways", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-"));
    const pidFile = path.join(stateDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, "9999123\n");
    const exited = new Set<number>();
    const responses = new Map<string, RunResult | ((args: string[]) => RunResult)>([
      [PGREP_KEY, ok("9999456\n")],
      ...(psResponses(9999123, { exited: new Set() }).map(([key, value]) =>
        key === "ps -p 9999123 -o pid=" ? [key, notFound()] : [key, value],
      ) as [string, RunResult | ((args: string[]) => RunResult)][]),
      ...psResponses(9999456, { exited }),
    ]);
    const { run } = makeRun(responses);
    const kill: HostGatewayProcessDeps["kill"] = (pid, signal) => {
      if (pid === 9999456 && signal === "SIGTERM") exited.add(pid);
      return true;
    };

    const result = stopHostGatewayProcesses(
      { run, kill, env: { USER: "tester" }, commandExists: () => true, log: vi.fn() },
      { stateDir },
    );

    expect(result.skippedDeadPids).toEqual([9999123]);
    expect(result.stopped).toEqual([9999456]);
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});

describe("scoped host gateway stop isolation (#8663)", () => {
  it("stops only the selected gateway after proving its PID, marker, owner, command line, and listener", () => {
    const fixture = scopedGatewayFixture();
    try {
      expect(fixture.result).toMatchObject({
        failed: [],
        ownershipFailures: [],
        skippedNonMatchingPids: [],
        stopped: [fixture.selectedPid],
      });
      expect(fixture.kill.mock.calls).toEqual([[fixture.selectedPid, "SIGKILL"]]);
      expect(fixture.kill).not.toHaveBeenCalledWith(fixture.siblingPid, expect.anything());
      expect(fixture.calls.filter(({ command }) => command === "pgrep")).toEqual([]);
      expect(fs.existsSync(fixture.selectedPidFile)).toBe(false);
      expect(fs.existsSync(fixture.selectedRuntimeMarker)).toBe(false);
      expect(fs.readFileSync(fixture.siblingPidFile, "utf-8")).toBe(
        `${String(fixture.siblingPid)}\n`,
      );
      expect(fs.existsSync(fixture.siblingRuntimeMarker)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("removes only the selected per-port Docker compatibility container after correlating its listener", () => {
    const compatContainerPid = 7_771_880;
    const fixture = scopedGatewayFixture({
      cmdline:
        "/usr/local/bin/docker run --rm --name nemoclaw-openshell-gateway-18080 --network host ubuntu:24.04 /opt/nemoclaw/openshell-gateway\n",
      compatContainerPid,
      listenerPids: [compatContainerPid],
    });
    try {
      expect(fixture.result).toMatchObject({
        failed: [],
        ownershipFailures: [],
        skippedNonMatchingPids: [],
        stopped: [fixture.selectedPid],
      });
      expect(fixture.kill).not.toHaveBeenCalled();
      const dockerCalls = fixture.calls.filter(({ command }) => command === "docker");
      expect(dockerCalls).toContainEqual({
        args: ["inspect", "--type", "container", fixture.selectedCompatContainerName],
        command: "docker",
      });
      expect(dockerCalls).toContainEqual({
        args: ["rm", "-f", fixture.selectedCompatContainerId],
        command: "docker",
      });
      expect(
        dockerCalls.some(({ args }) => args.includes(fixture.siblingCompatContainerName)),
      ).toBe(false);
      expect(fs.existsSync(fixture.selectedPidFile)).toBe(false);
      expect(fs.existsSync(fixture.selectedRuntimeMarker)).toBe(false);
      expect(fs.existsSync(fixture.siblingPidFile)).toBe(true);
      expect(fs.existsSync(fixture.siblingRuntimeMarker)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves selected state when the Docker compatibility container does not own the selected listener", () => {
    const compatContainerPid = 7_771_880;
    const siblingContainerPid = 7_770_808;
    const fixture = scopedGatewayFixture({
      cmdline:
        "/usr/local/bin/docker run --rm --name nemoclaw-openshell-gateway-18080 --network host ubuntu:24.04 /opt/nemoclaw/openshell-gateway\n",
      compatContainerPid,
      listenerPids: [siblingContainerPid],
    });
    try {
      expect(fixture.result.stopped).toEqual([]);
      expect(fixture.result.skippedNonMatchingPids).toEqual([fixture.selectedPid]);
      expect(fixture.result.ownershipFailures).toEqual([
        `PID ${String(fixture.selectedPid)}: compatibility container '${fixture.selectedCompatContainerName}' does not solely own the listener on port 18080`,
      ]);
      expect(fixture.kill).not.toHaveBeenCalled();
      const dockerCalls = fixture.calls.filter(({ command }) => command === "docker");
      expect(dockerCalls).toContainEqual({
        args: ["inspect", "--type", "container", fixture.selectedCompatContainerName],
        command: "docker",
      });
      expect(dockerCalls.some(({ args }) => args[0] === "rm")).toBe(false);
      expect(
        dockerCalls.some(({ args }) => args.includes(fixture.siblingCompatContainerName)),
      ).toBe(false);
      expect(fs.existsSync(fixture.selectedPidFile)).toBe(true);
      expect(fs.existsSync(fixture.selectedRuntimeMarker)).toBe(true);
      expect(fs.existsSync(fixture.siblingPidFile)).toBe(true);
      expect(fs.existsSync(fixture.siblingRuntimeMarker)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it.each([
    {
      label: "the selected PID file points at the sibling PID",
      options: { pidFilePid: 9_990_808 },
      reason: "runtime marker PID 9991880 does not match PID file 9990808",
    },
    {
      label: "the process command line names the sibling gateway",
      options: {
        cmdline: "/opt/openshell/openshell gateway start --name nemoclaw --port 18080\n",
      },
      reason: "process command line does not prove gateway 'nemoclaw-18080' on port 18080",
    },
    {
      label: "the process command line names the selected gateway on the sibling port",
      options: {
        cmdline: "/opt/openshell/openshell gateway start --name nemoclaw-18080 --port 8080\n",
      },
      reason: "process command line does not prove gateway 'nemoclaw-18080' on port 18080",
    },
    {
      label: "the runtime marker identifies the sibling port",
      options: { markerPort: 8_080 },
      reason: "runtime marker endpoint does not identify port 18080",
    },
    {
      label: "the runtime marker is missing",
      options: { omitMarker: true },
      reason: "runtime marker is missing or not a regular file",
    },
    {
      label: "the process owner differs from the runtime evidence owner",
      options: { processUid: CURRENT_UID + 1 },
      reason: "gateway process owner does not match the scoped runtime evidence owner",
    },
    {
      label: "the process executable differs from the runtime marker",
      options: { processExecutable: "/opt/foreign/openshell" },
      reason: "gateway process executable does not match the runtime marker",
    },
    {
      label: "the process executable has been deleted",
      options: { processExecutable: "/opt/openshell/openshell (deleted)" },
      reason: "gateway process executable does not match the runtime marker",
    },
    {
      label: "the selected port listener belongs to the sibling PID",
      options: { listenerPids: [9_990_808] },
      reason: "PID 9991880 is not the sole listener owner for port 18080",
    },
  ] as const)("fails closed and preserves evidence when $label", ({ options, reason }) => {
    const fixture = scopedGatewayFixture(options);
    try {
      expect(fixture.result.stopped).toEqual([]);
      expect(fixture.result.failed).toEqual([]);
      expect(fixture.result.skippedNonMatchingPids).toEqual([fixture.recordedPid]);
      expect(fixture.result.ownershipFailures).toEqual([
        `PID ${String(fixture.recordedPid)}: ${reason}`,
      ]);
      expect(fixture.kill).not.toHaveBeenCalled();
      expect(fixture.calls.filter(({ command }) => command === "pgrep")).toEqual([]);
      expect(fs.existsSync(fixture.selectedPidFile)).toBe(true);
      expect(fs.existsSync(fixture.selectedRuntimeMarker)).toBe(!options.omitMarker);
      expect(fs.existsSync(fixture.siblingPidFile)).toBe(true);
      expect(fs.existsSync(fixture.siblingRuntimeMarker)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when the selected port is occupied without PID ownership evidence", () => {
    const fixture = scopedGatewayFixture({
      listenerPids: [9_990_808],
      omitMarker: true,
      omitPidFile: true,
      portFree: false,
    });
    try {
      expect(fixture.result.ownershipFailures).toEqual([
        "gateway port 18080 is occupied without PID-file ownership evidence",
      ]);
      expect(fixture.kill).not.toHaveBeenCalled();
      expect(fixture.calls.filter(({ command }) => command === "pgrep")).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when the recorded PID is dead but the selected port remains occupied", () => {
    const fixture = scopedGatewayFixture({
      listenerPids: [9_990_808],
      portFree: false,
      processAlive: false,
    });
    try {
      expect(fixture.result.skippedDeadPids).toEqual([fixture.selectedPid]);
      expect(fixture.result.ownershipFailures).toEqual([
        `recorded PID ${String(fixture.selectedPid)} is dead but port 18080 remains occupied`,
      ]);
      expect(fixture.kill).not.toHaveBeenCalled();
      expect(fs.existsSync(fixture.selectedPidFile)).toBe(true);
      expect(fs.existsSync(fixture.selectedRuntimeMarker)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects a requested host-wide fallback without scanning or signaling", () => {
    const fixture = scopedGatewayFixture({ usePgrepFallback: true });
    try {
      expect(fixture.result.ownershipFailures).toEqual([
        "scoped gateway stop forbids host-wide process discovery",
      ]);
      expect(fixture.calls.filter(({ command }) => command === "pgrep")).toEqual([]);
      expect(fixture.kill).not.toHaveBeenCalled();
      expect(fs.existsSync(fixture.selectedPidFile)).toBe(true);
      expect(fs.existsSync(fixture.selectedRuntimeMarker)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when the selected process identity changes immediately before signaling", () => {
    const fixture = scopedGatewayFixture({ startIdentities: ["original", "replacement"] });
    try {
      expect(fixture.result.stopped).toEqual([]);
      expect(fixture.result.skippedNonMatchingPids).toEqual([fixture.selectedPid]);
      expect(fixture.result.ownershipFailures).toEqual([
        `PID ${String(fixture.selectedPid)}: gateway process identity changed immediately before signaling`,
      ]);
      expect(fixture.kill).not.toHaveBeenCalled();
      expect(fs.existsSync(fixture.selectedPidFile)).toBe(true);
      expect(fs.existsSync(fixture.selectedRuntimeMarker)).toBe(true);
      expect(fs.existsSync(fixture.siblingPidFile)).toBe(true);
      expect(fs.existsSync(fixture.siblingRuntimeMarker)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
