// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as dockerContainer from "../../adapters/docker/container";
import * as openshellRuntime from "../../adapters/openshell/runtime";
import * as dockerHealth from "./docker-health";
import * as gatewayTarget from "./gateway-target";
import { startStoppedSandboxContainerForProbeRecovery } from "./gateway-state";

function stubRuntime(overrides: Partial<dockerHealth.SandboxDockerRuntime> = {}) {
  return vi.spyOn(dockerHealth, "getSandboxDockerRuntime").mockReturnValue({
    health: "healthy",
    paused: false,
    running: false,
    containerName: "openshell-default--alpha-1234",
    ...overrides,
  } as dockerHealth.SandboxDockerRuntime);
}

describe("startStoppedSandboxContainerForProbeRecovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a stopped sandbox through OpenShell so its phase advances (#11790)", () => {
    stubRuntime();
    vi.spyOn(gatewayTarget, "getSandboxTargetGatewayName").mockReturnValue("nemoclaw-8091");
    const captureOpenshell = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValue({ status: 0, output: "" } as never);
    const dockerStart = vi.spyOn(dockerContainer, "dockerStart");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(startStoppedSandboxContainerForProbeRecovery("alpha")).toBe(true);
    expect(captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "start", "-g", "nemoclaw-8091", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    // A bare `docker start` leaves the sandbox phase at Stopped, which is the
    // state that wedges every later `start`. It must not be the first choice.
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("falls back to docker start when the OpenShell start fails (#8967)", () => {
    stubRuntime();
    vi.spyOn(gatewayTarget, "getSandboxTargetGatewayName").mockReturnValue("nemoclaw");
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({
      status: 1,
      output: "gateway unreachable",
    } as never);
    const dockerStart = vi
      .spyOn(dockerContainer, "dockerStart")
      .mockReturnValue({ status: 0 } as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(startStoppedSandboxContainerForProbeRecovery("alpha")).toBe(true);
    expect(dockerStart).toHaveBeenCalledWith(
      "openshell-default--alpha-1234",
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("reports no start when both the OpenShell start and docker start fail", () => {
    stubRuntime();
    vi.spyOn(gatewayTarget, "getSandboxTargetGatewayName").mockReturnValue("nemoclaw");
    vi.spyOn(openshellRuntime, "captureOpenshell").mockReturnValue({ status: 1 } as never);
    vi.spyOn(dockerContainer, "dockerStart").mockReturnValue({ status: 1 } as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(startStoppedSandboxContainerForProbeRecovery("alpha")).toBe(false);
  });

  it("leaves a running container whose sandbox is not Stopped untouched", () => {
    stubRuntime({ running: true });
    vi.spyOn(gatewayTarget, "getSandboxTargetGatewayName").mockReturnValue("nemoclaw");
    const captureOpenshell = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValue({ status: 0, output: "Phase: Ready\n" } as never);
    const dockerStart = vi.spyOn(dockerContainer, "dockerStart");

    expect(startStoppedSandboxContainerForProbeRecovery("alpha")).toBe(false);
    expect(captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(captureOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "start", "-g", "nemoclaw", "alpha"],
      expect.anything(),
    );
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("starts a running container whose sandbox is still Stopped (#11790)", () => {
    stubRuntime({ running: true });
    vi.spyOn(gatewayTarget, "getSandboxTargetGatewayName").mockReturnValue("nemoclaw");
    const captureOpenshell = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockImplementation(((args: string[]) =>
        args[1] === "get"
          ? { status: 0, output: "Phase: Stopped\n" }
          : { status: 0, output: "" }) as never);
    const dockerStart = vi.spyOn(dockerContainer, "dockerStart");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(startStoppedSandboxContainerForProbeRecovery("alpha")).toBe(true);
    expect(captureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "start", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    // The container already runs, so there is nothing for Docker to start.
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("reports no start when a Stopped sandbox with a running container fails to start", () => {
    stubRuntime({ running: true });
    vi.spyOn(gatewayTarget, "getSandboxTargetGatewayName").mockReturnValue("nemoclaw");
    vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(((args: string[]) =>
      args[1] === "get" ? { status: 0, output: "Phase: Stopped\n" } : { status: 1 }) as never);
    const dockerStart = vi.spyOn(dockerContainer, "dockerStart");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(startStoppedSandboxContainerForProbeRecovery("alpha")).toBe(false);
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("does not start a running container when the phase cannot be read", () => {
    stubRuntime({ running: true });
    vi.spyOn(gatewayTarget, "getSandboxTargetGatewayName").mockReturnValue("nemoclaw");
    const captureOpenshell = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValue({ status: 1, output: "gateway unreachable" } as never);

    expect(startStoppedSandboxContainerForProbeRecovery("alpha")).toBe(false);
    expect(captureOpenshell).not.toHaveBeenCalledWith(
      ["sandbox", "start", "-g", "nemoclaw", "alpha"],
      expect.anything(),
    );
  });

  it("leaves a paused container to its docker unpause guidance", () => {
    stubRuntime({ paused: true });
    const captureOpenshell = vi.spyOn(openshellRuntime, "captureOpenshell");
    const dockerStart = vi.spyOn(dockerContainer, "dockerStart");

    expect(startStoppedSandboxContainerForProbeRecovery("alpha")).toBe(false);
    expect(captureOpenshell).not.toHaveBeenCalled();
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("makes no change when the sandbox has no resolved container", () => {
    stubRuntime({ containerName: null });
    const captureOpenshell = vi.spyOn(openshellRuntime, "captureOpenshell");

    expect(startStoppedSandboxContainerForProbeRecovery("alpha")).toBe(false);
    expect(captureOpenshell).not.toHaveBeenCalled();
  });
});
