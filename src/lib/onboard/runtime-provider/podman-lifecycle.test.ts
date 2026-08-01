// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { ContainerEngine } from "../../adapters/container-engine";
import type { RuntimeProviderLifecycleInput } from "./contract";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  startPodmanSandbox,
  stopPodmanSandbox,
} from "./podman-lifecycle";

const SANDBOX_NAME = "alpha";
const CONTAINER_ID = "a".repeat(64);
const CONTAINER_NAME = `${PODMAN_SANDBOX_CONTAINER_PREFIX}${SANDBOX_NAME}`;

function inspect(running: boolean, status: string, paused = false): string {
  return JSON.stringify([
    {
      Id: CONTAINER_ID,
      Name: CONTAINER_NAME,
      Config: {
        Labels: {
          [PODMAN_MANAGED_LABEL]: "true",
          [PODMAN_SANDBOX_ID_LABEL]: "sandbox-id",
          [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
          [PODMAN_SANDBOX_NAMESPACE_LABEL]: "default",
        },
      },
      State: { Running: running, Paused: paused, Status: status },
    },
  ]);
}

function harness(initial: { running: boolean; status: string; paused?: boolean }) {
  let running = initial.running;
  let paused = initial.paused ?? false;
  let status = initial.status;
  const capture = vi.fn((args: readonly string[]) => {
    const operation = args[0];
    if (operation === "ps") {
      return { status: 0, stdout: `${CONTAINER_ID}\t${CONTAINER_NAME}\n`, stderr: "" };
    }
    if (operation === "container" && args[1] === "inspect") {
      return { status: 0, stdout: inspect(running, status, paused), stderr: "" };
    }
    if (operation === "start") {
      running = true;
      paused = false;
      status = "running";
      return { status: 0, stdout: CONTAINER_ID, stderr: "" };
    }
    if (operation === "unpause") {
      running = true;
      paused = false;
      status = "running";
      return { status: 0, stdout: CONTAINER_ID, stderr: "" };
    }
    if (operation === "stop") {
      running = false;
      paused = false;
      status = "exited";
      return { status: 0, stdout: CONTAINER_ID, stderr: "" };
    }
    return { status: 125, stdout: "", stderr: `unexpected operation ${String(operation)}` };
  });
  const engine: ContainerEngine = {
    operation: "sandbox-lifecycle",
    engineId: "podman",
    displayName: "Podman",
    capture,
    captureHost: vi.fn(),
  };
  const log = vi.fn();
  const input: RuntimeProviderLifecycleInput = {
    environment: {},
    log,
    sandbox: { name: SANDBOX_NAME, openshellDriver: "podman" },
    sandboxName: SANDBOX_NAME,
  };
  return { capture, engine, input, log };
}

describe("Podman basic CPU lifecycle", () => {
  it("stops and restarts the exact managed container", () => {
    const stopped = harness({ running: true, status: "running" });
    const beforeStop = vi.fn();

    expect(stopPodmanSandbox(stopped.input, { beforeStop }, stopped.engine)).toEqual({
      exitCode: 0,
      state: "stopped",
    });
    expect(beforeStop).toHaveBeenCalledOnce();
    expect(stopped.capture.mock.calls.map(([args]) => args)).toContainEqual([
      "stop",
      "--time",
      "30",
      CONTAINER_ID,
    ]);

    const started = harness({ running: false, status: "exited" });
    expect(startPodmanSandbox(started.input, started.engine)).toEqual({ exitCode: 0 });
    expect(started.capture.mock.calls.map(([args]) => args)).toContainEqual([
      "start",
      CONTAINER_ID,
    ]);
  });

  it("unpauses a paused container and treats at-rest stop as idempotent", () => {
    const paused = harness({ running: true, status: "paused", paused: true });
    expect(startPodmanSandbox(paused.input, paused.engine)).toEqual({ exitCode: 0 });
    expect(paused.capture.mock.calls.map(([args]) => args)).toContainEqual([
      "unpause",
      CONTAINER_ID,
    ]);

    const atRest = harness({ running: false, status: "exited" });
    const beforeStop = vi.fn();
    expect(stopPodmanSandbox(atRest.input, { beforeStop }, atRest.engine)).toEqual({
      exitCode: 0,
      state: "already-stopped",
    });
    expect(beforeStop).not.toHaveBeenCalled();
  });

  it("refuses ambiguous identity and unknown state before mutation hooks", () => {
    const ambiguous = harness({ running: true, status: "running" });
    ambiguous.capture.mockImplementationOnce(() => ({
      status: 0,
      stdout: `${CONTAINER_ID}\t${CONTAINER_NAME}\n` + `${"b".repeat(64)}\t${CONTAINER_NAME}\n`,
      stderr: "",
    }));
    const ambiguousHook = vi.fn();
    expect(
      stopPodmanSandbox(ambiguous.input, { beforeStop: ambiguousHook }, ambiguous.engine),
    ).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("2 managed containers"),
    });
    expect(ambiguousHook).not.toHaveBeenCalled();

    const unknown = harness({ running: false, status: "unknown" });
    const unknownHook = vi.fn();
    expect(
      stopPodmanSandbox(unknown.input, { beforeStop: unknownHook }, unknown.engine),
    ).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("not safely stoppable"),
    });
    expect(unknownHook).not.toHaveBeenCalled();
  });

  it("rejects another operation-scoped engine without running commands", () => {
    const runtime = harness({ running: true, status: "running" });
    const wrongEngine = { ...runtime.engine, operation: "host-doctor" as const };

    expect(startPodmanSandbox(runtime.input, wrongEngine)).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("operation-scoped Podman engine"),
    });
    expect(runtime.capture).not.toHaveBeenCalled();
  });
});
