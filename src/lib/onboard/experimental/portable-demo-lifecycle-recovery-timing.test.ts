// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PodmanSocketAuthorityDeps } from "../../adapters/podman";
import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import {
  installPortableDemoSandboxLifecycle,
  type PortableDemoLifecycleDeps,
  recoverPortableDemoSandboxLifecycle,
} from "./portable-demo-lifecycle";
import {
  PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_MISSING_STATUS,
  PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_PATH,
  PORTABLE_OPENCLAW_GATEWAY_STARTUP_TIMING_PREFIX,
} from "./portable-demo-lifecycle-timing";

const CONTAINER_ID = "a".repeat(64);
const SANDBOX_ID = "sandbox-id-alpha";
const SOCKET_PATH = "/run/user/1001/podman/podman.sock";
const RUNTIME_AUTHORITY: CheckpointPortableRuntimeAuthority = {
  schemaVersion: 1,
  kind: "podman",
  ownership: "current-user",
  uid: 1001,
  homeDir: "/home/tester",
  configHome: "/home/tester/.config",
  runtimeDir: "/run/user/1001",
  socketPath: SOCKET_PATH,
};
const STARTUP_ARGV = [
  "env",
  "CHAT_UI_URL=http://127.0.0.1:18789",
  "NEMOCLAW_DASHBOARD_PORT=18789",
  "OPENCLAW_HOME=/sandbox",
  "OPENCLAW_STATE_DIR=/sandbox/.openclaw",
  "OPENCLAW_WORKSPACE_DIR=/sandbox/.openclaw/workspace",
  "NEMOCLAW_SANDBOX_NAME=alpha",
  "/usr/local/bin/nemoclaw-start",
];
const EPOCH_BASE_MS = 1_700_000_000_000;

function epochSeconds(offsetMs: number): string {
  return ((EPOCH_BASE_MS + offsetMs) / 1_000).toFixed(6);
}

function startupTimingRecord(): string {
  return `schema=1 entry=${epochSeconds(10)} configStart=${epochSeconds(20)} configEnd=${epochSeconds(35)} providerEnd=${epochSeconds(46)} tokenEnd=${epochSeconds(59)} messagingEnd=${epochSeconds(80)} workspaceEnd=${epochSeconds(100)} spawnEnd=${epochSeconds(110)}\n`;
}

const temporaryDirectories: string[] = [];

function temporaryStateDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-timing-"));
  temporaryDirectories.push(directory);
  return directory;
}

function socketAuthorityDeps(): PodmanSocketAuthorityDeps {
  const directoryInodes = new Map<string, bigint>();
  return {
    uid: 1001,
    lstat: (filePath) => {
      const socket = filePath === SOCKET_PATH;
      const directoryInode = directoryInodes.get(filePath) ?? BigInt(7000 + directoryInodes.size);
      directoryInodes.set(filePath, directoryInode);
      return {
        dev: 8n,
        ino: socket ? 9001n : directoryInode,
        mode: socket ? 0o660n : filePath === path.dirname(SOCKET_PATH) ? 0o700n : 0o755n,
        uid: socket ? 1001n : filePath.startsWith("/run/user/1001") ? 1001n : 0n,
        isDirectory: () => !socket,
        isSocket: () => socket,
      };
    },
  };
}

function createPodman(runningInitially: boolean) {
  let running = runningInitially;
  return vi.fn((args: readonly string[]) => {
    const command = args[0] === "--url" ? args.slice(2) : args;
    switch (command[0]) {
      case "version":
        return {
          status: 0,
          stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
        };
      case "ps":
        return { status: 0, stdout: `${CONTAINER_ID}\n` };
      case "inspect":
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              Id: CONTAINER_ID,
              Name: `openshell-default--alpha-${SANDBOX_ID}`,
              Config: {
                Labels: {
                  "openshell.managed": "true",
                  "openshell.ai/sandbox-id": SANDBOX_ID,
                  "openshell.ai/sandbox-name": "alpha",
                  "openshell.ai/sandbox-namespace": "",
                  "openshell.ai/sandbox-workspace": "default",
                },
              },
              State: {
                Running: running,
                Status: running ? "running" : "exited",
              },
            },
          ]),
        };
      case "start":
        running = true;
        return { status: 0 };
      case "update":
        return { status: 0 };
      default:
        throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
    }
  });
}

function readinessDeps() {
  return {
    uid: 1001,
    home: RUNTIME_AUTHORITY.homeDir,
    systemctl: () => ({ status: 0 }),
    podmanCapture: () => ({
      status: 0,
      stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
      stderr: "",
    }),
  };
}

function installReceipt(stateDir: string, podman: ReturnType<typeof createPodman>): void {
  installPortableDemoSandboxLifecycle(
    "alpha",
    STARTUP_ARGV,
    { HOME: stateDir, NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
    {
      platform: "linux",
      podman,
      stateDir,
      runtimeAuthority: RUNTIME_AUTHORITY,
      podmanSocketAuthorityDeps: socketAuthorityDeps(),
      hardenSocketDirectory: vi.fn(),
      runtimeReadiness: readinessDeps(),
      log: vi.fn(),
    },
  );
}

function recover(stateDir: string, deps: PortableDemoLifecycleDeps, provider?: string | null) {
  return recoverPortableDemoSandboxLifecycle(
    "alpha",
    {
      agent: "openclaw",
      gatewayName: "nemoclaw",
      lifecycleGeneration: CONTAINER_ID,
      openshellDriver: "docker",
      provider,
    },
    {
      platform: "linux",
      stateDir,
      podmanSocketAuthorityDeps: socketAuthorityDeps(),
      hardenSocketDirectory: vi.fn(),
      runtimeReadiness: readinessDeps(),
      ...deps,
    },
  );
}

function timingLines(log: ReturnType<typeof vi.fn>): string[] {
  return log.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith("  Portable lifecycle timing:"));
}

function gatewayTimingLines(log: ReturnType<typeof vi.fn>): string[] {
  return log.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith(PORTABLE_OPENCLAW_GATEWAY_STARTUP_TIMING_PREFIX));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable lifecycle recovery timing output", () => {
  it("waits for the startup record before emitting recovered timing (#9200)", () => {
    const stateDir = temporaryStateDir();
    const podman = createPodman(false);
    const launchOpenshell = vi.fn();
    const log = vi.fn();
    const readTimeouts: number[] = [];
    const sleeps: number[] = [];
    let deadlineNow = 0;
    let diagnosticNow = 0;
    let epochNow = EPOCH_BASE_MS;
    let timingReadAttempts = 0;
    installReceipt(stateDir, podman);

    expect(
      recover(stateDir, {
        podman,
        captureOpenshell: (args, timeoutMs) => {
          const command = args.find((arg) => ["true", "pgrep", "curl", "node"].includes(arg));
          switch (command) {
            case "true":
              return { status: 0 };
            case "pgrep":
              return { status: 1 };
            case "curl": {
              const launched = launchOpenshell.mock.calls.length > 0;
              epochNow = launched ? EPOCH_BASE_MS + 2_110 : epochNow;
              return { status: 0, stdout: launched ? "200" : "000" };
            }
            case "node":
              timingReadAttempts += 1;
              readTimeouts.push(timeoutMs);
              diagnosticNow += 5;
              return timingReadAttempts === 1
                ? { status: PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_MISSING_STATUS }
                : { status: 0, stdout: startupTimingRecord() };
            default:
              throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
          }
        },
        launchOpenshell,
        log,
        now: () => deadlineNow,
        timingNow: () => diagnosticNow,
        gatewayStartupEpochNow: () => epochNow,
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          deadlineNow += milliseconds;
          diagnosticNow += milliseconds;
        },
      }),
    ).toEqual({ kind: "recovered" });
    expect(timingReadAttempts).toBe(2);
    expect(readTimeouts).toEqual([1_000, 1_000]);
    expect(sleeps).toEqual([100]);
    expect(timingLines(log)).toEqual([
      "  Portable lifecycle timing: authority=0ms inspect=0ms containerStart=0ms execReady=0ms ollama=0ms gatewayHealth=0ms startupProbe=0ms startupLaunch=0ms gatewayReady=0ms total=110ms containerAction=started gatewayAction=started ollamaAction=not-applicable ollamaAttempts=0 execAttempts=1 execNotReady=0 execTimeouts=0 execErrors=0 gatewayAttempts=2 gatewayNotReady=1 gatewayTimeouts=0 gatewayErrors=0 result=recovered",
    ]);
    const gatewayLine = gatewayTimingLines(log)[0];
    expect(gatewayLine).toBe(
      "  Portable OpenClaw gateway startup timing: launchToEntry=10ms entrySetup=10ms configIntegrity=15ms providerModelCors=11ms tokenPlaceholderHash=13ms messagingChannelsPreloadsScan=21ms workspaceAuthTemp=20ms gatewaySpawn=10ms spawnToFirstHealth=2000ms launchToFirstHealth=2110ms probe=0ms sleep=0ms firstReadyAttempt=1 lastFailure=none diagnosticRead=10ms diagnosticReadOutcome=recorded",
    );
  });

  it("emits one already-running timing line from the lifecycle caller (#9200)", () => {
    const stateDir = temporaryStateDir();
    const podman = createPodman(true);
    const log = vi.fn();
    installReceipt(stateDir, podman);

    expect(
      recover(stateDir, {
        podman,
        captureOpenshell: (args) =>
          args.includes("curl") ? { status: 0, stdout: "401" } : { status: 0 },
        log,
        now: () => 0,
        timingNow: () => 0,
      }),
    ).toEqual({ kind: "already-running" });
    expect(timingLines(log)).toEqual([
      "  Portable lifecycle timing: authority=0ms inspect=0ms containerStart=0ms execReady=0ms ollama=0ms gatewayHealth=0ms startupProbe=0ms startupLaunch=0ms gatewayReady=0ms total=0ms containerAction=reused gatewayAction=reused ollamaAction=not-applicable ollamaAttempts=0 execAttempts=1 execNotReady=0 execTimeouts=0 execErrors=0 gatewayAttempts=1 gatewayNotReady=0 gatewayTimeouts=0 gatewayErrors=0 result=already-running",
    ]);
    expect(gatewayTimingLines(log)).toEqual([
      "  Portable OpenClaw gateway startup timing: launchToEntry=0ms entrySetup=0ms configIntegrity=0ms providerModelCors=0ms tokenPlaceholderHash=0ms messagingChannelsPreloadsScan=0ms workspaceAuthTemp=0ms gatewaySpawn=0ms spawnToFirstHealth=0ms launchToFirstHealth=0ms probe=0ms sleep=0ms firstReadyAttempt=0 lastFailure=none diagnosticRead=0ms diagnosticReadOutcome=not-applicable",
    ]);
  });

  it("preserves recovered lifecycle semantics when the startup timing read throws (#9200)", () => {
    const stateDir = temporaryStateDir();
    const podman = createPodman(false);
    const launchOpenshell = vi.fn();
    const log = vi.fn();
    let epochNow = EPOCH_BASE_MS;
    installReceipt(stateDir, podman);

    expect(
      recover(stateDir, {
        podman,
        captureOpenshell: (args) => {
          const command = args.find((arg) => ["true", "pgrep", "curl", "node"].includes(arg));
          switch (command) {
            case "true":
              return { status: 0 };
            case "pgrep":
              return { status: 1 };
            case "curl": {
              const launched = launchOpenshell.mock.calls.length > 0;
              epochNow += launched ? 1_000 : 0;
              return { status: 0, stdout: launched ? "200" : "000" };
            }
            case "node":
              throw new Error("credential-bearing diagnostic failure");
            default:
              throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
          }
        },
        launchOpenshell,
        log,
        now: () => 0,
        timingNow: () => 0,
        gatewayStartupEpochNow: () => epochNow,
      }),
    ).toEqual({ kind: "recovered" });
    expect(timingLines(log)[0]).toContain("result=recovered");
    expect(gatewayTimingLines(log)[0]).toContain("diagnosticReadOutcome=error");
    expect(gatewayTimingLines(log)[0]).not.toContain("credential-bearing");
  });

  it.each([
    ["absent", "missing"],
    ["a directory", "error"],
  ] as const)("classifies an actual %s timing-record read as %s (#9200)", (kind, outcome) => {
    const stateDir = temporaryStateDir();
    const podman = createPodman(false);
    const launchOpenshell = vi.fn();
    const log = vi.fn();
    const sleep = vi.fn();
    const testRecordPath = kind === "absent" ? path.join(stateDir, "absent-record") : stateDir;
    let deadlineNow = 0;
    let epochNow = EPOCH_BASE_MS;
    installReceipt(stateDir, podman);

    expect(
      recover(stateDir, {
        podman,
        captureOpenshell: (args, timeoutMs) => {
          const command = args.find((arg) => ["true", "pgrep", "curl", "node"].includes(arg));
          switch (command) {
            case "true":
              return { status: 0 };
            case "pgrep":
              return { status: 1 };
            case "curl": {
              const launched = launchOpenshell.mock.calls.length > 0;
              epochNow = launched ? EPOCH_BASE_MS + 2_110 : epochNow;
              return { status: 0, stdout: launched ? "200" : "000" };
            }
            case "node": {
              const separator = args.lastIndexOf("--");
              const readCommand = args.slice(separator + 1);
              const recordPathIndex = readCommand.indexOf(
                PORTABLE_OPENCLAW_GATEWAY_STARTUP_RECORD_PATH,
              );
              expect(recordPathIndex).toBeGreaterThan(0);
              expect(readCommand[0]).toBe("node");
              readCommand[recordPathIndex] = testRecordPath;
              const result = spawnSync("node", readCommand.slice(1), {
                encoding: "utf8",
                timeout: timeoutMs,
              });
              deadlineNow = 2_000;
              return result;
            }
            default:
              throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
          }
        },
        launchOpenshell,
        log,
        now: () => deadlineNow,
        timingNow: () => 0,
        gatewayStartupEpochNow: () => epochNow,
        sleep,
      }),
    ).toEqual({ kind: "recovered" });

    expect(sleep).not.toHaveBeenCalled();
    expect(gatewayTimingLines(log)[0]).toContain(`diagnosticReadOutcome=${outcome}`);
  });

  it("measures launched gateway probes and sleeps without changing polling (#9200)", () => {
    const stateDir = temporaryStateDir();
    const podman = createPodman(false);
    const launchOpenshell = vi.fn();
    const log = vi.fn();
    const sleeps: number[] = [];
    let deadlineNow = 0;
    let diagnosticNow = 0;
    let epochNow = EPOCH_BASE_MS;
    let gatewayAttempts = 0;
    installReceipt(stateDir, podman);

    expect(
      recover(stateDir, {
        podman,
        captureOpenshell: (args) => {
          const command = args.find((arg) => ["true", "pgrep", "curl", "node"].includes(arg));
          switch (command) {
            case "true":
              return { status: 0 };
            case "pgrep":
              return { status: 1 };
            case "curl": {
              diagnosticNow += 25;
              gatewayAttempts += 1;
              const ready = gatewayAttempts >= 3;
              epochNow = ready ? EPOCH_BASE_MS + 2_110 : epochNow;
              return { status: 0, stdout: ready ? "200" : "000" };
            }
            case "node":
              diagnosticNow += 20;
              return { status: 0, stdout: startupTimingRecord() };
            default:
              throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
          }
        },
        launchOpenshell,
        log,
        now: () => deadlineNow,
        timingNow: () => diagnosticNow,
        gatewayStartupEpochNow: () => epochNow,
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          deadlineNow += milliseconds;
          diagnosticNow += milliseconds;
        },
      }),
    ).toEqual({ kind: "recovered" });
    expect(gatewayAttempts).toBe(3);
    expect(sleeps).toEqual([1_000]);
    expect(timingLines(log)[0]).toContain("gatewayReady=1050ms");
    expect(gatewayTimingLines(log)[0]).toContain(
      "probe=50ms sleep=1000ms firstReadyAttempt=2 lastFailure=not-ready diagnosticRead=20ms diagnosticReadOutcome=recorded",
    );
  });

  it("emits one redacted failed timing line before preserving the recovery error (#9200)", () => {
    const stateDir = temporaryStateDir();
    const podman = createPodman(true);
    const log = vi.fn();
    let deadlineNow = 0;
    let diagnosticNow = 0;
    installReceipt(stateDir, podman);

    expect(() =>
      recover(stateDir, {
        podman,
        captureOpenshell: (args) =>
          args.includes("curl") ? { status: 0, stdout: "000" } : { status: 0 },
        launchOpenshell: vi.fn(),
        log,
        now: () => deadlineNow,
        timingNow: () => {
          diagnosticNow += 50_000;
          return diagnosticNow;
        },
        sleep: (milliseconds) => {
          deadlineNow += milliseconds;
        },
      }),
    ).toThrow("has a startup process, but its agent gateway did not pass");
    expect(timingLines(log)).toHaveLength(1);
    expect(timingLines(log)[0]).toContain(
      "gatewayAttempts=91 gatewayNotReady=91 gatewayTimeouts=0 gatewayErrors=0",
    );
    expect(timingLines(log)[0]).toContain("result=failed failedStage=gatewayReady");
    expect(timingLines(log)[0]).not.toContain("has a startup process");
  });

  it("classifies exec and gateway polling outcomes without command details (#9200)", () => {
    const stateDir = temporaryStateDir();
    const podman = createPodman(true);
    const log = vi.fn();
    let deadlineNow = 0;
    const execResults = [
      { status: 1 },
      {
        status: 1,
        error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      },
      {
        status: 1,
        error: Object.assign(new Error("transport"), { code: "EPIPE" }),
      },
      { status: 0 },
    ];
    const gatewayResults = [
      {
        status: 1,
        error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      },
      {
        status: 1,
        error: Object.assign(new Error("transport"), { code: "EPIPE" }),
      },
      { status: 0, stdout: "200" },
    ];
    installReceipt(stateDir, podman);

    expect(
      recover(stateDir, {
        podman,
        captureOpenshell: (args) => {
          const command = args.find((arg) => ["true", "pgrep", "curl"].includes(arg));
          switch (command) {
            case "true":
              return execResults.shift() ?? { status: 0 };
            case "curl":
              return gatewayResults.shift() ?? { status: 0, stdout: "200" };
            case "pgrep":
              return { status: 0 };
            default:
              throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
          }
        },
        log,
        now: () => deadlineNow,
        timingNow: () => 0,
        sleep: (milliseconds) => {
          deadlineNow += milliseconds;
        },
      }),
    ).toEqual({ kind: "already-running" });

    expect(timingLines(log)).toHaveLength(1);
    expect(timingLines(log)[0]).toContain(
      "execAttempts=4 execNotReady=1 execTimeouts=1 execErrors=1",
    );
    expect(timingLines(log)[0]).toContain(
      "gatewayAttempts=3 gatewayNotReady=0 gatewayTimeouts=1 gatewayErrors=1",
    );
    expect(timingLines(log)[0]).not.toContain("timeout");
    expect(timingLines(log)[0]).not.toContain("transport");
  });

  it("reports a healthy managed Ollama probe as reused (#9200)", () => {
    const stateDir = temporaryStateDir();
    const podman = createPodman(true);
    const log = vi.fn();
    installReceipt(stateDir, podman);

    expect(
      recover(
        stateDir,
        {
          podman,
          captureHost: () => ({
            status: 0,
            stdout: JSON.stringify({ models: [] }),
          }),
          captureOpenshell: (args) =>
            args.includes("curl") ? { status: 0, stdout: "401" } : { status: 0 },
          log,
          now: () => 0,
          timingNow: () => 0,
        },
        "ollama-local",
      ),
    ).toEqual({ kind: "already-running" });
    expect(timingLines(log)).toHaveLength(1);
    expect(timingLines(log)[0]).toContain("ollamaAction=reused ollamaAttempts=1");
  });

  it("attributes an errored startup probe to startupProbe (#9200)", () => {
    const stateDir = temporaryStateDir();
    const podman = createPodman(true);
    const log = vi.fn();
    installReceipt(stateDir, podman);

    expect(() =>
      recover(stateDir, {
        podman,
        captureOpenshell: (args) => {
          const command = args.find((arg) => ["true", "pgrep", "curl"].includes(arg));
          switch (command) {
            case "true":
              return { status: 0 };
            case "curl":
              return { status: 0, stdout: "000" };
            case "pgrep":
              return {
                status: 0,
                error: Object.assign(new Error("transport"), { code: "EPIPE" }),
              };
            default:
              throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
          }
        },
        log,
        now: () => 0,
        timingNow: () => 0,
      }),
    ).toThrow("startup process state could not be determined");
    expect(timingLines(log)).toHaveLength(1);
    expect(timingLines(log)[0]).toContain("result=failed failedStage=startupProbe");
    expect(timingLines(log)[0]).not.toContain("transport");
  });

  it("preserves recovery when the diagnostic clock and writer throw (#9200)", () => {
    const stateDir = temporaryStateDir();
    const podman = createPodman(true);
    const timingWrite = vi.fn((_line: string) => {
      throw new Error("diagnostic writer failed");
    });
    const log = vi.fn((line: string) =>
      line.startsWith("  Portable lifecycle timing:") ? timingWrite(line) : undefined,
    );
    installReceipt(stateDir, podman);

    expect(
      recover(stateDir, {
        podman,
        captureOpenshell: (args) =>
          args.includes("curl") ? { status: 0, stdout: "401" } : { status: 0 },
        log,
        now: () => 0,
        timingNow: () => {
          throw new Error("diagnostic clock failed");
        },
      }),
    ).toEqual({ kind: "already-running" });
    expect(timingWrite).toHaveBeenCalledOnce();
  });
});
