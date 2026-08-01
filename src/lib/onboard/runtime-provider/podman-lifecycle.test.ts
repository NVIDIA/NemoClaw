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

interface HarnessState {
  readonly running: boolean;
  readonly status: string;
  readonly paused?: boolean;
}

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

function harness(initial: HarnessState) {
  let running = initial.running;
  let paused = initial.paused ?? false;
  let status = initial.status;
  const setState = (next: HarnessState) => {
    running = next.running;
    paused = next.paused ?? false;
    status = next.status;
  };
  const capture = vi.fn((args: readonly string[]) => {
    const operation = String(args[0]);
    switch (operation) {
      case "ps":
        return { status: 0, stdout: `${CONTAINER_ID}\t${CONTAINER_NAME}\n`, stderr: "" };
      case "container":
        return { status: 0, stdout: inspect(running, status, paused), stderr: "" };
      case "start":
      case "unpause":
        setState({ running: true, status: "running" });
        return { status: 0, stdout: CONTAINER_ID, stderr: "" };
      case "stop":
        setState({ running: false, status: "exited" });
        return { status: 0, stdout: CONTAINER_ID, stderr: "" };
      default:
        return { status: 125, stdout: "", stderr: `unexpected operation ${operation}` };
    }
  });
  const engine: ContainerEngine = {
    operation: "sandbox-lifecycle",
    engineId: "podman",
    displayName: "Podman",
    authorityId: "test:podman-socket",
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
  return { capture, engine, input, log, setState };
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

  it("converges on retry after start succeeds but final inspection fails", () => {
    const runtime = harness({ running: false, status: "exited" });
    runtime.capture
      .mockImplementationOnce(() => ({
        status: 0,
        stdout: `${CONTAINER_ID}\t${CONTAINER_NAME}\n`,
        stderr: "",
      }))
      .mockImplementationOnce(() => ({
        status: 0,
        stdout: inspect(false, "exited"),
        stderr: "",
      }))
      .mockImplementationOnce(() => {
        runtime.setState({ running: true, status: "running" });
        return { status: 0, stdout: CONTAINER_ID, stderr: "" };
      })
      .mockImplementationOnce(() => ({
        status: 125,
        stdout: "",
        stderr: "inspection unavailable",
      }));

    expect(startPodmanSandbox(runtime.input, runtime.engine)).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("inspection unavailable"),
    });
    expect(startPodmanSandbox(runtime.input, runtime.engine)).toEqual({ exitCode: 0 });
    expect(
      runtime.capture.mock.calls.map(([args]) => args).filter(([op]) => op === "start"),
    ).toEqual([["start", CONTAINER_ID]]);
  });

  it("retries the exact container after a stop mutation fails", () => {
    const runtime = harness({ running: true, status: "running" });
    const beforeStop = vi.fn();
    runtime.capture
      .mockImplementationOnce(() => ({
        status: 0,
        stdout: `${CONTAINER_ID}\t${CONTAINER_NAME}\n`,
        stderr: "",
      }))
      .mockImplementationOnce(() => ({
        status: 0,
        stdout: inspect(true, "running"),
        stderr: "",
      }))
      .mockImplementationOnce(() => ({ status: 125, stdout: "", stderr: "stop failed" }));

    expect(stopPodmanSandbox(runtime.input, { beforeStop }, runtime.engine)).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("stop failed"),
    });
    expect(stopPodmanSandbox(runtime.input, { beforeStop }, runtime.engine)).toEqual({
      exitCode: 0,
      state: "stopped",
    });
    expect(beforeStop).toHaveBeenCalledTimes(2);
    expect(
      runtime.capture.mock.calls.map(([args]) => args).filter(([op]) => op === "stop"),
    ).toEqual([
      ["stop", "--time", "30", CONTAINER_ID],
      ["stop", "--time", "30", CONTAINER_ID],
    ]);
  });
});
