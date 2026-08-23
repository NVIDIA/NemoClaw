// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable lifecycle recovery timing output", () => {
  it("emits one recovered timing line from the lifecycle caller (#9200)", () => {
    const stateDir = temporaryStateDir();
    const podman = createPodman(false);
    const launchOpenshell = vi.fn();
    const log = vi.fn();
    installReceipt(stateDir, podman);

    expect(
      recover(stateDir, {
        podman,
        captureOpenshell: (args) => {
          const command = args.find((arg) => ["true", "pgrep", "curl"].includes(arg));
          switch (command) {
            case "true":
              return { status: 0 };
            case "pgrep":
              return { status: 1 };
            case "curl":
              return launchOpenshell.mock.calls.length === 0
                ? { status: 0, stdout: "000" }
                : { status: 0, stdout: "200" };
            default:
              throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
          }
        },
        launchOpenshell,
        log,
        now: () => 0,
        timingNow: () => 0,
      }),
    ).toEqual({ kind: "recovered" });
    expect(timingLines(log)).toEqual([
      "  Portable lifecycle timing: authority=0ms inspect=0ms containerStart=0ms execReady=0ms ollama=0ms gatewayHealth=0ms startupProbe=0ms startupLaunch=0ms gatewayReady=0ms total=0ms containerAction=started gatewayAction=started ollamaAction=not-applicable ollamaAttempts=0 execAttempts=1 execNotReady=0 execTimeouts=0 execErrors=0 gatewayAttempts=2 gatewayNotReady=1 gatewayTimeouts=0 gatewayErrors=0 result=recovered",
    ]);
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
