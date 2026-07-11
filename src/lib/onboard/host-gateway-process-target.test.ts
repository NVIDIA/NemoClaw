// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  HOST_GATEWAY_PGREP_PATTERN,
  type HostGatewayProcessDeps,
  type RunResult,
  stopHostGatewayProcesses,
} from "./host-gateway-process";

const PGREP_KEY = `pgrep -f ${HOST_GATEWAY_PGREP_PATTERN}`;

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
    cmdline: string;
    exited: Set<number>;
  },
): [string, RunResponse][] {
  return [
    [`ps -p ${pid} -o pid=`, () => (opts.exited.has(pid) ? notFound() : ok(`${pid}\n`))],
    [`ps -p ${pid} -o user=`, staticResponse(ok("tester\n"))],
    [`ps -p ${pid} -o args=`, staticResponse(ok(opts.cmdline))],
  ];
}

function stopTargetedPid(pid: number, cmdline: string, targeted = true) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-gateway-target-"));
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
