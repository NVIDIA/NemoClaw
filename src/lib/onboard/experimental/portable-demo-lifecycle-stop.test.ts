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
  portableDemoLifecycleInternals,
  type PortablePodmanLifecycleCommandResult,
  stopPortableDemoSandboxLifecycle,
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

function createPodman() {
  let running = true;
  let status: string | null = "running";
  let containerId = CONTAINER_ID;
  const podman = vi.fn(
    (args: readonly string[], _env?: NodeJS.ProcessEnv): PortablePodmanLifecycleCommandResult => {
      const command = args[0] === "--url" ? args.slice(2) : args;
      switch (command[0]) {
        case "version":
          return { status: 0, stdout: JSON.stringify({ Server: { Version: "5.6.1" } }) };
        case "ps":
          return { status: 0, stdout: `${CONTAINER_ID}\n` };
        case "inspect":
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                Id: containerId,
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
                State: { Running: running, Status: status },
              },
            ]),
          };
        case "stop":
          running = false;
          status = "exited";
          return { status: 0 };
        case "update":
          return { status: 0 };
        default:
          throw new Error(`Unexpected Podman command: ${args.join(" ")}`);
      }
    },
  );
  return {
    podman,
    setContainerId(value: string) {
      containerId = value;
    },
    setState(value: boolean, nextStatus: string | null) {
      running = value;
      status = nextStatus;
    },
  };
}

function lifecycleDeps(
  stateDir: string,
  podman: ReturnType<typeof createPodman>["podman"],
  overrides: Partial<PortableDemoLifecycleDeps> = {},
): PortableDemoLifecycleDeps {
  return {
    platform: "linux",
    podman,
    podmanSocketAuthorityDeps: socketAuthorityDeps(),
    stateDir,
    hardenSocketDirectory: vi.fn(),
    runtimeReadiness: {
      uid: 1001,
      home: RUNTIME_AUTHORITY.homeDir,
      systemctl: () => ({ status: 0 }),
      podmanCapture: () => ({
        status: 0,
        stdout: JSON.stringify({ Server: { Version: "5.6.1" } }),
        stderr: "",
      }),
    },
    log: vi.fn(),
    ...overrides,
  };
}

function createStopHarness() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-portable-stop-"));
  temporaryDirectories.push(stateDir);
  const runtime = createPodman();
  installPortableDemoSandboxLifecycle(
    "alpha",
    STARTUP_ARGV,
    { HOME: stateDir, NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
    {
      ...lifecycleDeps(stateDir, runtime.podman),
      runtimeAuthority: RUNTIME_AUTHORITY,
    },
  );
  const receiptPath = portableDemoLifecycleInternals.receiptPath("alpha", stateDir);
  const receiptBefore = fs.readFileSync(receiptPath, "utf8");
  const originalPodman = runtime.podman.getMockImplementation()!;
  runtime.podman.mockClear();
  return { originalPodman, receiptBefore, receiptPath, runtime, stateDir };
}

function stopSandbox(
  harness: ReturnType<typeof createStopHarness>,
  overrides: Partial<PortableDemoLifecycleDeps> = {},
  beforeStop = vi.fn(),
) {
  return stopPortableDemoSandboxLifecycle(
    "alpha",
    {
      agent: "openclaw",
      gatewayName: "nemoclaw",
      lifecycleGeneration: CONTAINER_ID,
      openshellDriver: "docker",
    },
    beforeStop,
    lifecycleDeps(harness.stateDir, harness.runtime.podman, overrides),
  );
}

function timedOutStop(
  harness: ReturnType<typeof createStopHarness>,
  afterStop?: (command: readonly string[]) => PortablePodmanLifecycleCommandResult | undefined,
) {
  const timeout = Object.assign(new Error("spawnSync podman ETIMEDOUT"), {
    code: "ETIMEDOUT",
  });
  let stopAttempted = false;
  harness.runtime.podman.mockImplementation((args, env) => {
    const command = args[0] === "--url" ? args.slice(2) : args;
    switch (command[0]) {
      case "stop":
        stopAttempted = true;
        return { status: null, error: timeout };
      default: {
        const result = stopAttempted ? afterStop?.(command) : undefined;
        return result ?? harness.originalPodman(args, env);
      }
    }
  });
}

function settleAfterSecondInspection(harness: ReturnType<typeof createStopHarness>) {
  let inspectionsAfterStop = 0;
  return (command: readonly string[]): undefined => {
    switch (command[0]) {
      case "inspect":
        inspectionsAfterStop += 1;
        switch (inspectionsAfterStop) {
          case 2:
            harness.runtime.setState(false, "exited");
        }
    }
  };
}

function successfulStop(
  harness: ReturnType<typeof createStopHarness>,
  afterStop?: (command: readonly string[]) => PortablePodmanLifecycleCommandResult | undefined,
) {
  let stopAttempted = false;
  harness.runtime.podman.mockImplementation((args, env) => {
    const command = args[0] === "--url" ? args.slice(2) : args;
    switch (command[0]) {
      case "stop":
        stopAttempted = true;
        harness.runtime.setState(false, "stopping");
        return { status: 0 };
      default: {
        const result = stopAttempted ? afterStop?.(command) : undefined;
        return result ?? harness.originalPodman(args, env);
      }
    }
  });
}

function replaceContainerOnInspection(harness: ReturnType<typeof createStopHarness>) {
  return (command: readonly string[]): undefined => {
    switch (command[0]) {
      case "inspect":
        harness.runtime.setContainerId("b".repeat(64));
    }
  };
}

function expectOnlyExactStopAndInspects(harness: ReturnType<typeof createStopHarness>): void {
  const commands = harness.runtime.podman.mock.calls.map(([args]) =>
    args[0] === "--url" ? args.slice(2) : args,
  );
  expect(commands.filter(([command]) => command === "stop")).toEqual([["stop", CONTAINER_ID]]);
  expect(commands.every(([command]) => command === "inspect" || command === "stop")).toBe(true);
}

function expectReceiptUnchanged(harness: ReturnType<typeof createStopHarness>): void {
  expect(fs.readFileSync(harness.receiptPath, "utf8")).toBe(harness.receiptBefore);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("portable demo sandbox stop reconciliation", () => {
  it("returns already-stopped for an exited container without another mutation (#9200)", () => {
    const harness = createStopHarness();
    harness.runtime.setState(false, "exited");
    const beforeStop = vi.fn();

    expect(stopSandbox(harness, {}, beforeStop)).toEqual({ kind: "already-stopped" });

    expect(beforeStop).not.toHaveBeenCalled();
    expectReceiptUnchanged(harness);
    expect(
      harness.runtime.podman.mock.calls.some(([args]) => {
        const command = args[0] === "--url" ? args.slice(2) : args;
        return command[0] === "stop";
      }),
    ).toBe(false);
  });

  it("rejects a non-running container with no Podman status (#9200)", () => {
    const harness = createStopHarness();
    harness.runtime.setState(false, null);
    const beforeStop = vi.fn();

    expect(() => stopSandbox(harness, {}, beforeStop)).toThrow("is not in the exited state");

    expect(beforeStop).not.toHaveBeenCalled();
    expectReceiptUnchanged(harness);
    expect(
      harness.runtime.podman.mock.calls.some(([args]) => {
        const command = args[0] === "--url" ? args.slice(2) : args;
        return command[0] === "stop";
      }),
    ).toBe(false);
  });

  it("waits for an already-stopping container to settle without another mutation (#9200)", () => {
    const harness = createStopHarness();
    let now = 0;
    let inspections = 0;
    harness.runtime.setState(false, "stopping");
    harness.runtime.podman.mockImplementation((args, env) => {
      const command = args[0] === "--url" ? args.slice(2) : args;
      switch (command[0]) {
        case "inspect":
          inspections += 1;
          switch (inspections) {
            case 3:
              harness.runtime.setState(false, "exited");
          }
      }
      return harness.originalPodman(args, env);
    });
    const beforeStop = vi.fn();

    expect(
      stopSandbox(
        harness,
        {
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        },
        beforeStop,
      ),
    ).toEqual({ kind: "already-stopped" });

    expect(beforeStop).not.toHaveBeenCalled();
    expect(now).toBe(1_000);
    expectReceiptUnchanged(harness);
    expect(
      harness.runtime.podman.mock.calls.some(([args]) => {
        const command = args[0] === "--url" ? args.slice(2) : args;
        return command[0] === "stop";
      }),
    ).toBe(false);
  });

  it("waits for a successful stop to settle before returning (#9200)", () => {
    const harness = createStopHarness();
    let now = 0;
    successfulStop(harness, settleAfterSecondInspection(harness));
    const beforeStop = vi.fn();

    expect(
      stopSandbox(
        harness,
        {
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        },
        beforeStop,
      ),
    ).toEqual({ kind: "stopped" });

    expect(beforeStop).toHaveBeenCalledExactlyOnceWith();
    expect(now).toBe(1_000);
    expectReceiptUnchanged(harness);
    expectOnlyExactStopAndInspects(harness);
  });

  it("fails after bounded settlement when a successful stop remains transitional (#9200)", () => {
    const harness = createStopHarness();
    let now = 0;
    successfulStop(harness);

    expect(() =>
      stopSandbox(harness, {
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).toThrow("did not settle into the exited state");

    expect(now).toBe(30_000);
    expectReceiptUnchanged(harness);
    expectOnlyExactStopAndInspects(harness);
  });

  it("reconciles an ETIMEDOUT stop to the exact receipt-owned container state (#9200)", () => {
    const harness = createStopHarness();
    let now = 0;
    timedOutStop(harness, settleAfterSecondInspection(harness));
    const beforeStop = vi.fn();

    expect(
      stopSandbox(
        harness,
        {
          now: () => now,
          sleep: (milliseconds) => {
            now += milliseconds;
          },
        },
        beforeStop,
      ),
    ).toEqual({ kind: "stopped" });

    expect(beforeStop).toHaveBeenCalledExactlyOnceWith();
    expect(now).toBe(1_000);
    expectReceiptUnchanged(harness);
    expectOnlyExactStopAndInspects(harness);
  });

  it("fails after bounded reconciliation when an ETIMEDOUT container remains running (#9200)", () => {
    const harness = createStopHarness();
    let now = 0;
    timedOutStop(harness);

    expect(() =>
      stopSandbox(harness, {
        now: () => now,
        sleep: (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).toThrow("ETIMEDOUT");

    expect(now).toBe(30_000);
    expectReceiptUnchanged(harness);
    expectOnlyExactStopAndInspects(harness);
  });

  it("rejects container identity drift while reconciling an ETIMEDOUT stop (#9200)", () => {
    const harness = createStopHarness();
    timedOutStop(harness, replaceContainerOnInspection(harness));

    expect(() => stopSandbox(harness, { now: () => 0, sleep: vi.fn() })).toThrow(
      "OpenShell identity does not match sandbox 'alpha'",
    );

    expectReceiptUnchanged(harness);
    expectOnlyExactStopAndInspects(harness);
  });

  it("rejects a missing receipt-owned container while reconciling an ETIMEDOUT stop (#9200)", () => {
    const harness = createStopHarness();
    timedOutStop(harness, (command) =>
      command[0] === "inspect" ? { status: 125, stderr: "Error: no such container" } : undefined,
    );

    expect(() => stopSandbox(harness, { now: () => 0, sleep: vi.fn() })).toThrow(
      "no longer has its recorded Podman container",
    );

    expectReceiptUnchanged(harness);
    expectOnlyExactStopAndInspects(harness);
  });

  it("rejects an inspection failure while reconciling an ETIMEDOUT stop (#9200)", () => {
    const harness = createStopHarness();
    timedOutStop(harness, (command) =>
      command[0] === "inspect" ? { status: 125, stderr: "permission denied" } : undefined,
    );

    expect(() => stopSandbox(harness, { now: () => 0, sleep: vi.fn() })).toThrow(
      "Inspecting portable sandbox 'alpha' failed: exit 125",
    );

    expectReceiptUnchanged(harness);
    expectOnlyExactStopAndInspects(harness);
  });
});
