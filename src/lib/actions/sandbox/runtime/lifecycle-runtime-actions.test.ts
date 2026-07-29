// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
} from "../../../onboard/compute/podman/sandbox-recreate-spec";
import type { SandboxEntry } from "../../../state/registry";
import { startSandbox } from "../start";
import { stopSandbox } from "../stop";
import type {
  SandboxLifecycleRuntimeAdapter,
  SandboxLifecycleRuntimeAdapterRegistry,
} from "./lifecycle-runtime";

const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const SANDBOX_NAME = "my-sandbox";
const CONTAINER_NAME = `openshell-sandbox-${SANDBOX_NAME}`;
const CONTAINER_ID = "a".repeat(64);
const IMAGE_ID = "b".repeat(64);
const SOCKET_PATH = "/run/user/1000/podman/podman.sock";

function podmanSandbox(agent: (typeof AGENTS)[number]): SandboxEntry {
  return {
    agent,
    gatewayName: "nemoclaw",
    name: SANDBOX_NAME,
    openshellDriver: "podman",
  };
}

function podmanInspect(running: boolean, status?: string): string {
  return JSON.stringify([
    {
      Config: {
        Labels: {
          [PODMAN_MANAGED_LABEL]: "true",
          [PODMAN_SANDBOX_ID_LABEL]: "sandbox-id",
          [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
          [PODMAN_SANDBOX_NAMESPACE_LABEL]: "default",
        },
      },
      Id: CONTAINER_ID,
      Image: `sha256:${IMAGE_ID}`,
      Name: CONTAINER_NAME,
      State: {
        Paused: false,
        Running: running,
        Status: status ?? (running ? "running" : "exited"),
      },
    },
  ]);
}

function podmanLifecycleHarness(
  agent: (typeof AGENTS)[number],
  options: {
    initialRunning?: boolean;
    initialStatus?: string;
    lookupRows?: string;
  } = {},
) {
  let running = options.initialRunning ?? true;
  const captureHostCommand = vi.fn((_command: string, args: string[]) => {
    const operationIndex = args.indexOf("--url") + 2;
    const operation = args[operationIndex];
    if (operation === "ps") {
      return {
        status: 0,
        stderr: "",
        stdout: options.lookupRows ?? `${CONTAINER_ID}\t${CONTAINER_NAME}\n`,
      };
    }
    if (operation === "container" && args[operationIndex + 1] === "inspect") {
      return {
        status: 0,
        stderr: "",
        stdout: podmanInspect(running, options.initialStatus),
      };
    }
    if (operation === "stop") {
      running = false;
      return { status: 0, stderr: "", stdout: CONTAINER_ID };
    }
    if (operation === "start") {
      running = true;
      return { status: 0, stderr: "", stdout: CONTAINER_ID };
    }
    return { status: 125, stderr: `unexpected Podman operation: ${String(operation)}`, stdout: "" };
  });
  const getSandbox = vi.fn(() => podmanSandbox(agent));
  const resolvePodmanRuntimeSocket = vi.fn(() => SOCKET_PATH);
  const resolveSandboxManagedGatewayStateDirectory = vi.fn(() => "/state/podman");
  const stopSandboxChannels = vi.fn();
  const teardownSandboxDashboardForward = vi.fn();
  const probeSandbox = vi.fn(async () => {});
  const log = vi.fn();
  return {
    captureHostCommand,
    getSandbox,
    log,
    probeSandbox,
    resolvePodmanRuntimeSocket,
    resolveSandboxManagedGatewayStateDirectory,
    stopSandboxChannels,
    teardownSandboxDashboardForward,
  };
}

describe("sandbox lifecycle runtime actions", () => {
  it.each(AGENTS)("stops and restarts the exact native Podman container for %s", async (agent) => {
    const h = podmanLifecycleHarness(agent);
    const sharedDeps = {
      captureHostCommand: h.captureHostCommand,
      environment: { NEMOCLAW_PODMAN_BIN: "podman" },
      getSandbox: h.getSandbox,
      log: h.log,
      resolvePodmanRuntimeSocket: h.resolvePodmanRuntimeSocket,
      resolveSandboxManagedGatewayStateDirectory: h.resolveSandboxManagedGatewayStateDirectory,
    };

    expect(
      stopSandbox(SANDBOX_NAME, {
        ...sharedDeps,
        stopSandboxChannels: h.stopSandboxChannels,
        teardownSandboxDashboardForward: h.teardownSandboxDashboardForward,
      }),
    ).toEqual({ exitCode: 0 });
    expect(h.stopSandboxChannels).toHaveBeenCalledWith(
      SANDBOX_NAME,
      expect.objectContaining({
        allowDockerGatewayExec: false,
        info: expect.any(Function),
        warn: expect.any(Function),
      }),
    );
    expect(h.teardownSandboxDashboardForward).toHaveBeenCalledWith(SANDBOX_NAME);

    await expect(
      startSandbox(SANDBOX_NAME, {
        ...sharedDeps,
        probeSandbox: h.probeSandbox,
      }),
    ).resolves.toEqual({ exitCode: 0 });
    expect(h.probeSandbox).toHaveBeenCalledWith(SANDBOX_NAME);

    const calls = h.captureHostCommand.mock.calls;
    expect(calls.every(([command]) => command === "podman")).toBe(true);
    expect(calls.map(([, args]) => args)).toContainEqual([
      "--url",
      `unix://${SOCKET_PATH}`,
      "stop",
      "--time",
      "30",
      CONTAINER_ID,
    ]);
    expect(calls.map(([, args]) => args)).toContainEqual([
      "--url",
      `unix://${SOCKET_PATH}`,
      "start",
      CONTAINER_ID,
    ]);
    expect(JSON.stringify(calls)).not.toContain("docker");
    expect(h.resolvePodmanRuntimeSocket).toHaveBeenCalledTimes(2);
  });

  it("routes a future MXC driver only through its injected lifecycle adapter", async () => {
    const events: string[] = [];
    const adapter: SandboxLifecycleRuntimeAdapter = {
      channelStopTransport: "openshell",
      displayName: "MXC",
      driverName: "mxc",
      preflight: vi.fn(() => null),
      start: vi.fn(() => {
        events.push("start");
        return { exitCode: 0 };
      }),
      stop: vi.fn((_input, _deps, hooks) => {
        hooks.beforeStop();
        events.push("stop");
        return { exitCode: 0, state: "stopped" as const };
      }),
    };
    const runtimeAdapters: SandboxLifecycleRuntimeAdapterRegistry = { mxc: adapter };
    const entry: SandboxEntry = {
      agent: "hermes",
      name: SANDBOX_NAME,
      openshellDriver: "mxc",
    };
    const stopSandboxChannels = vi.fn();
    const probeSandbox = vi.fn(async () => {});

    expect(
      stopSandbox(SANDBOX_NAME, {
        getSandbox: () => entry,
        runtimeAdapters,
        stopSandboxChannels,
        teardownSandboxDashboardForward: vi.fn(),
      }),
    ).toEqual({ exitCode: 0 });
    await expect(
      startSandbox(SANDBOX_NAME, {
        getSandbox: () => entry,
        probeSandbox,
        runtimeAdapters,
      }),
    ).resolves.toEqual({ exitCode: 0 });

    expect(events).toEqual(["stop", "start"]);
    expect(stopSandboxChannels).toHaveBeenCalledOnce();
    expect(probeSandbox).toHaveBeenCalledWith(SANDBOX_NAME);
  });

  it("refuses ambiguous or unknown Podman container identity without side effects", () => {
    const ambiguous = podmanLifecycleHarness("openclaw", {
      lookupRows: `${CONTAINER_ID}\t${CONTAINER_NAME}\n` + `${"c".repeat(64)}\t${CONTAINER_NAME}\n`,
    });
    expect(
      stopSandbox(SANDBOX_NAME, {
        captureHostCommand: ambiguous.captureHostCommand,
        getSandbox: ambiguous.getSandbox,
        resolvePodmanRuntimeSocket: ambiguous.resolvePodmanRuntimeSocket,
        resolveSandboxManagedGatewayStateDirectory:
          ambiguous.resolveSandboxManagedGatewayStateDirectory,
        stopSandboxChannels: ambiguous.stopSandboxChannels,
        teardownSandboxDashboardForward: ambiguous.teardownSandboxDashboardForward,
      }),
    ).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("2 managed containers"),
    });
    expect(ambiguous.stopSandboxChannels).not.toHaveBeenCalled();
    expect(ambiguous.teardownSandboxDashboardForward).not.toHaveBeenCalled();

    const unknownState = podmanLifecycleHarness("openclaw", {
      initialRunning: false,
      initialStatus: "unknown",
    });
    expect(
      stopSandbox(SANDBOX_NAME, {
        captureHostCommand: unknownState.captureHostCommand,
        getSandbox: unknownState.getSandbox,
        resolvePodmanRuntimeSocket: unknownState.resolvePodmanRuntimeSocket,
        resolveSandboxManagedGatewayStateDirectory:
          unknownState.resolveSandboxManagedGatewayStateDirectory,
        stopSandboxChannels: unknownState.stopSandboxChannels,
        teardownSandboxDashboardForward: unknownState.teardownSandboxDashboardForward,
      }),
    ).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("not safely stoppable"),
    });
    expect(unknownState.stopSandboxChannels).not.toHaveBeenCalled();
    expect(unknownState.teardownSandboxDashboardForward).not.toHaveBeenCalled();
  });

  it("fails closed for an unregistered named runtime", async () => {
    const entry: SandboxEntry = {
      name: SANDBOX_NAME,
      openshellDriver: "unregistered",
    };
    expect(stopSandbox(SANDBOX_NAME, { getSandbox: () => entry })).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("unregistered"),
    });
    await expect(startSandbox(SANDBOX_NAME, { getSandbox: () => entry })).resolves.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("unregistered"),
    });
  });
});
