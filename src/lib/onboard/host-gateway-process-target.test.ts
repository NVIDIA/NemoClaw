// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
} from "./docker-driver-gateway-config";
import { writeDockerDriverGatewayRuntimeMarkerForStateDir } from "./docker-driver-gateway-runtime-marker";
import { prepareNativePodmanGatewayHostRuntime } from "./runtime-provider/podman-runtime-surfaces";
import {
  HOST_GATEWAY_PGREP_PATTERN,
  type HostGatewayProcessDeps,
  type RunResult,
  stopHostGatewayProcesses,
} from "./host-gateway-process";

const PGREP_KEY = `pgrep -f ${HOST_GATEWAY_PGREP_PATTERN}`;
const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  tempRoots.clear();
});

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

type RunResponse = (args: string[]) => RunResult;

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function notFound(): RunResult {
  return { status: 1, stdout: "", stderr: "" };
}

function staticResponse(result: RunResult): RunResponse {
  return () => result;
}

function commandKey(command: string, args: string[]): string {
  return `${command} ${args.join(" ")}`;
}

function makeRun(responses: Map<string, RunResponse>): HostGatewayProcessDeps["run"] {
  const fallback = staticResponse(notFound());
  return (command, args) => (responses.get(commandKey(command, args)) ?? fallback)(args);
}

function psResponses(
  pid: number,
  opts: {
    cmdline: string | (() => string);
    exited: Set<number>;
    processStatus?: RunResult;
    provider?: "docker" | "podman";
  },
): [string, RunResponse][] {
  return [
    [
      `ps -p ${pid} -o stat=`,
      () => (opts.exited.has(pid) ? notFound() : (opts.processStatus ?? ok("S\n"))),
    ],
    [`ps -p ${pid} -o uid=`, staticResponse(ok(`${String(process.getuid?.() ?? 501)}\n`))],
    [`ps -p ${pid} -o user=`, staticResponse(ok("tester\n"))],
    [
      `ps -p ${pid} -o args=`,
      () => ok(typeof opts.cmdline === "function" ? opts.cmdline() : opts.cmdline),
    ],
  ];
}

function stopScopedTarget(
  overrides: {
    cmdline?: string;
    cmdlineAfterProof?: string;
    markerPort?: number;
    name?: string;
    namespace?: string;
    pidFilePid?: number;
    port?: number;
    processStatus?: RunResult;
    provider?: "docker" | "podman";
    signalDenied?: boolean;
  } = {},
) {
  const selectedPid = 9_999_601;
  const pid = overrides.pidFilePid ?? selectedPid;
  const stateDir = makeTempRoot("nemoclaw-scoped-target-");
  const provider = overrides.provider ?? "docker";
  const pidFile = path.join(stateDir, "openshell-gateway.pid");
  fs.writeFileSync(pidFile, `${String(pid)}\n`);
  const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
  fs.writeFileSync(
    path.join(stateDir, "openshell-gateway.toml"),
    buildDockerDriverGatewayConfigToml(
      {
        OPENSHELL_GRPC_ENDPOINT:
          provider === "podman" ? "https://169.254.2.2:18080" : "https://127.0.0.1:18080",
        OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
        ...(provider === "podman"
          ? { OPENSHELL_PODMAN_SOCKET: path.join(stateDir, "podman.sock") }
          : {}),
      },
      "/usr/bin/openshell-sandbox",
      jwtBundle,
      gatewayIdForStateDir(stateDir),
      provider === "podman"
        ? prepareNativePodmanGatewayHostRuntime({
            environment: {},
            platform: "linux",
            socketPath: path.join(stateDir, "podman.sock"),
          })
        : undefined,
    ),
    { mode: 0o600 },
  );
  writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDir, {
    desiredEnv: { NEMOCLAW_RUNTIME_PROVIDER_ID: provider },
    endpoint: `https://127.0.0.1:${String(overrides.markerPort ?? 18080)}`,
    pid: selectedPid,
    platform: provider === "podman" ? "linux" : process.platform,
  });
  const exited = new Set<number>();
  const markExited = (pid: number): true => {
    exited.add(pid);
    return true;
  };
  let cmdlineReads = 0;
  const cmdline = overrides.cmdline ?? "openshell-gateway[nemoclaw=nemoclaw-18080;port=18080]";
  const run = vi.fn(
    makeRun(
      new Map([
        ...psResponses(pid, {
          cmdline: () => {
            cmdlineReads += 1;
            return cmdlineReads > 1 && overrides.cmdlineAfterProof
              ? overrides.cmdlineAfterProof
              : cmdline;
          },
          exited,
          ...(overrides.processStatus ? { processStatus: overrides.processStatus } : {}),
        }),
      ]),
    ),
  );
  const kill = vi.fn<HostGatewayProcessDeps["kill"]>((killedPid, signal) => {
    switch (signal) {
      case "SIGTERM":
        return overrides.signalDenied ? false : markExited(killedPid);
    }
    return overrides.signalDenied !== true;
  });
  const result = stopHostGatewayProcesses(
    {
      run,
      kill,
      env: {},
      isPortFree: () => true,
      log: vi.fn(),
      readProcessEnvironment: () => ({
        [NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]:
          overrides.namespace ?? gatewayIdForStateDir(stateDir),
      }),
      warn: vi.fn(),
    },
    {
      ...(overrides.signalDenied ? { killWaitMs: 0, pollIntervalMs: 0, termWaitMs: 0 } : {}),
      openShellGatewayName: overrides.name ?? "nemoclaw-18080",
      openShellGatewayPort: overrides.port ?? 18080,
      scopedGatewayStop: true,
      stateDir,
      usePgrepFallback: false,
    },
  );
  return { kill, pidFile, result, run };
}

function stopTargetedPid(pid: number, cmdline: string, targeted = true) {
  const stateDir = makeTempRoot("nemoclaw-host-gateway-target-");
  const pidFile = path.join(stateDir, "openshell-gateway.pid");
  fs.writeFileSync(pidFile, `${pid}\n`);
  const exited = new Set<number>();
  const responses = new Map<string, RunResponse>([
    [PGREP_KEY, staticResponse(notFound())],
    ...psResponses(pid, { cmdline, exited }),
  ]);
  const kill = vi.fn<HostGatewayProcessDeps["kill"]>((killedPid, signal) => {
    switch (signal) {
      case "SIGTERM":
        exited.add(killedPid);
        break;
    }
    return true;
  });

  const result = stopHostGatewayProcesses(
    {
      run: makeRun(responses),
      kill,
      env: { USER: "tester" },
      commandExists: () => true,
      log: vi.fn(),
    },
    {
      ...(targeted ? { openShellGatewayName: "nemoclaw-8081", openShellGatewayPort: 8081 } : {}),
      stateDir,
    },
  );

  return { kill, pidFile, result };
}

describe("stopHostGatewayProcesses target filtering", () => {
  it("stops only the fully proven scoped PID without running pgrep (#8663)", () => {
    const { kill, pidFile, result, run } = stopScopedTarget();

    expect(result.stopped).toEqual([9_999_601]);
    expect(result.ownershipFailures).toEqual([]);
    expect(kill).toHaveBeenCalledWith(9_999_601, "SIGTERM");
    expect(run.mock.calls.some(([command]) => command === "pgrep")).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("uses the native provider runtime marker when its gateway schema omits namespaces", () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      const { kill, pidFile, result, run } = stopScopedTarget({ provider: "podman" });

      expect(result.stopped).toEqual([9_999_601]);
      expect(result.ownershipFailures).toEqual([]);
      expect(kill).toHaveBeenCalledWith(9_999_601, "SIGTERM");
      expect(run.mock.calls.some(([command]) => command === "pgrep")).toBe(false);
      expect(fs.existsSync(pidFile)).toBe(false);
    } finally {
      platform.mockRestore();
    }
  });

  it.each([
    ["PID file", { pidFilePid: 9_999_602 }],
    ["command line", { cmdline: "openshell-gateway[nemoclaw=nemoclaw;port=8080]" }],
    ["gateway name", { name: "nemoclaw", port: 18080 }],
    ["gateway port", { name: "nemoclaw", port: 8080 }],
    ["loaded namespace", { namespace: "default" }],
  ])("fails closed when a sibling cross-matches by %s (#8663)", (_case, overrides) => {
    const { kill, pidFile, result } = stopScopedTarget(overrides);

    expect(result.stopped).toEqual([]);
    expect(result.ownershipFailures?.length).toBe(1);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it("revalidates process ownership immediately before signaling (#8663)", () => {
    const { kill, pidFile, result } = stopScopedTarget({
      cmdlineAfterProof: "openshell-gateway[nemoclaw=nemoclaw;port=8080]",
    });

    expect(result.stopped).toEqual([]);
    expect(result.ownershipFailures).toEqual([
      "PID 9999601: process ownership changed immediately before signaling",
    ]);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it.each([
    ["ps fails", { status: 2, stdout: "", stderr: "ps failed" }],
    ["ps returns an error-bearing no-match", { status: 1, stdout: "", stderr: "bad process ID" }],
    ["ps returns an invalid state", { status: 0, stdout: "?\n", stderr: "" }],
  ])("fails closed when scoped process status cannot be proven: %s (#7744)", (_case, status) => {
    const { kill, pidFile, result } = stopScopedTarget({ processStatus: status });

    expect(result.stopped).toEqual([]);
    expect(result.ownershipFailures).toEqual([
      "PID 9999601: recorded process status cannot be proven",
    ]);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it("retains scoped ownership evidence when signaling is denied (#7744)", () => {
    const { kill, pidFile, result } = stopScopedTarget({ signalDenied: true });

    expect(result.stopped).toEqual([]);
    expect(result.failed).toEqual([9_999_601]);
    expect(kill).toHaveBeenCalledWith(9_999_601, "SIGTERM");
    expect(kill).toHaveBeenCalledWith(9_999_601, "SIGKILL");
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it("accepts a matching OpenShell CLI gateway-start process for the cleanup target", () => {
    const { kill, pidFile, result } = stopTargetedPid(
      9999553,
      "/Users/test/.local/bin/openshell gateway start --name nemoclaw-8081 --port 8081\n",
    );

    expect(result.stopped).toEqual([9999553]);
    expect(kill).toHaveBeenCalledWith(9999553, "SIGTERM");
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("skips a stale PID-file OpenShell CLI gateway-start process for another gateway", () => {
    const { kill, pidFile, result } = stopTargetedPid(
      9999554,
      "/Users/test/.local/bin/openshell gateway start --name other --port 9999\n",
    );

    expect(result.skippedNonMatchingPids).toEqual([9999554]);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("skips a bare openclaw-gateway process when cleanup supplies a target", () => {
    const { kill, pidFile, result } = stopTargetedPid(9999560, "openclaw-gateway\n");

    expect(result.skippedNonMatchingPids).toEqual([9999560]);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("keeps legacy openclaw-gateway matching when cleanup has no target", () => {
    const { kill, pidFile, result } = stopTargetedPid(9999561, "openclaw-gateway\n", false);

    expect(result.stopped).toEqual([9999561]);
    expect(kill).toHaveBeenCalledWith(9999561, "SIGTERM");
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("accepts the owned no-argument host launch for the cleanup target", () => {
    const { kill, pidFile, result } = stopTargetedPid(
      9999555,
      "openshell-gateway[nemoclaw=nemoclaw-8081;port=8081]\n",
    );

    expect(result.stopped).toEqual([9999555]);
    expect(kill).toHaveBeenCalledWith(9999555, "SIGTERM");
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("skips an untagged legacy no-argument launch until onboarding migrates it", () => {
    const { kill, pidFile, result } = stopTargetedPid(
      9999559,
      "/opt/openshell/openshell-gateway\n",
    );

    expect(result.skippedNonMatchingPids).toEqual([9999559]);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("skips an owned no-argument host launch for another port", () => {
    const { kill, pidFile, result } = stopTargetedPid(
      9999556,
      "openshell-gateway[nemoclaw=nemoclaw;port=8080]\n",
    );

    expect(result.skippedNonMatchingPids).toEqual([9999556]);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("accepts a Docker compatibility gateway with the cleanup target container name", () => {
    const { kill, pidFile, result } = stopTargetedPid(
      9999557,
      "docker run --rm --name nemoclaw-openshell-gateway-8081 ubuntu:24.04 /opt/nemoclaw/openshell-gateway\n",
    );

    expect(result.stopped).toEqual([9999557]);
    expect(kill).toHaveBeenCalledWith(9999557, "SIGTERM");
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("skips a stale PID-file Docker compatibility gateway for another port", () => {
    const { kill, pidFile, result } = stopTargetedPid(
      9999558,
      "docker run --rm --name nemoclaw-openshell-gateway ubuntu:24.04 /opt/nemoclaw/openshell-gateway\n",
    );

    expect(result.skippedNonMatchingPids).toEqual([9999558]);
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});
