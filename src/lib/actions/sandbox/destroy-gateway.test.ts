// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerRemoveVolumesByPrefix: vi.fn(),
  stopHostGatewayProcesses: vi.fn(),
  stopStaleDashboardListeners: vi.fn(),
}));

vi.mock("../../adapters/docker/volume", () => ({
  dockerRemoveVolumesByPrefix: mocks.dockerRemoveVolumesByPrefix,
}));
vi.mock("../../onboard/host-gateway-process", () => ({
  stopHostGatewayProcesses: mocks.stopHostGatewayProcesses,
}));
vi.mock("../../onboard/stale-gateway-cleanup", () => ({
  stopStaleDashboardListeners: mocks.stopStaleDashboardListeners,
}));

import { cleanupGatewayAfterLastSandbox } from "./destroy-gateway";

describe("cleanupGatewayAfterLastSandbox", () => {
  beforeEach(() => {
    mocks.stopHostGatewayProcesses.mockReturnValue({
      failed: [],
      skippedDeadPids: [],
      skippedNonMatchingPids: [],
      stopped: [],
      sudoRemediationPids: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
  });

  it("uses the PID-file-scoped host gateway reaper for macOS final destroy (#4662)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const stateDir = path.join(
      "/home/tester",
      ".local",
      "state",
      "nemoclaw",
      "openshell-docker-gateway-8081",
    );

    cleanupGatewayAfterLastSandbox("nemoclaw-8081", runOpenshell);

    expect(mocks.stopStaleDashboardListeners).toHaveBeenCalledOnce();
    expect(mocks.stopHostGatewayProcesses).toHaveBeenCalledWith(
      {},
      {
        usePgrepFallback: false,
        stateDir,
        pidFile: path.join(stateDir, "openshell-gateway.pid"),
        openShellGatewayName: "nemoclaw-8081",
        openShellGatewayPort: 8081,
        preserveRuntimeFilesOnNonMatching: true,
      },
    );
    expect(runOpenshell).toHaveBeenCalledWith(["gateway", "remove", "nemoclaw-8081"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(mocks.dockerRemoveVolumesByPrefix).toHaveBeenCalledWith(
      "openshell-cluster-nemoclaw-8081",
      {
        ignoreError: true,
      },
    );
  });

  it("keeps the PID-file-scoped host gateway reaper active for Linux final destroy", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const stateDir = path.join(
      "/home/tester",
      ".local",
      "state",
      "nemoclaw",
      "openshell-docker-gateway-8081",
    );

    cleanupGatewayAfterLastSandbox("nemoclaw-8081", runOpenshell);

    expect(mocks.stopHostGatewayProcesses).toHaveBeenCalledWith(
      {},
      {
        usePgrepFallback: false,
        stateDir,
        pidFile: path.join(stateDir, "openshell-gateway.pid"),
        openShellGatewayName: "nemoclaw-8081",
        openShellGatewayPort: 8081,
        preserveRuntimeFilesOnNonMatching: true,
      },
    );
    expect(runOpenshell).toHaveBeenCalledWith(["gateway", "remove", "nemoclaw-8081"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(mocks.dockerRemoveVolumesByPrefix).toHaveBeenCalledWith(
      "openshell-cluster-nemoclaw-8081",
      {
        ignoreError: true,
      },
    );
  });

  it("keeps host gateway reaping disabled for non-Docker-driver platforms", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    cleanupGatewayAfterLastSandbox("nemoclaw", runOpenshell);

    expect(mocks.stopHostGatewayProcesses).not.toHaveBeenCalled();
    expect(runOpenshell).toHaveBeenCalledWith(["gateway", "remove", "nemoclaw"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("fails before gateway and volume removal when the owned host listener survives (#4662)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    mocks.stopHostGatewayProcesses.mockReturnValue({
      failed: [123],
      skippedDeadPids: [],
      skippedNonMatchingPids: [],
      stopped: [],
      sudoRemediationPids: [123],
    });
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    expect(() => cleanupGatewayAfterLastSandbox("nemoclaw-8081", runOpenshell)).toThrow(
      /PID\(s\) 123.*rerun destroy/,
    );
    expect(runOpenshell).not.toHaveBeenCalledWith(
      ["gateway", "remove", "nemoclaw-8081"],
      expect.anything(),
    );
    expect(mocks.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();
  });

  it("fails before gateway and volume removal when PID-file ownership is unverifiable (#4662)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    mocks.stopHostGatewayProcesses.mockReturnValue({
      failed: [],
      skippedDeadPids: [],
      skippedNonMatchingPids: [456],
      stopped: [],
      sudoRemediationPids: [],
    });
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    expect(() => cleanupGatewayAfterLastSandbox("nemoclaw-8081", runOpenshell)).toThrow(
      /PID-file process\(es\) 456.*do not prove ownership.*rerun destroy/,
    );
    expect(runOpenshell).not.toHaveBeenCalledWith(
      ["gateway", "remove", "nemoclaw-8081"],
      expect.anything(),
    );
    expect(mocks.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();
  });

  it.each([
    [
      "host reaper",
      () =>
        mocks.stopHostGatewayProcesses.mockImplementationOnce(() => {
          throw new Error("injected host reaper failure");
        }),
    ],
    [
      "gateway remove",
      (runOpenshell: ReturnType<typeof vi.fn>) =>
        runOpenshell
          .mockImplementationOnce(() => ({ status: 0, stdout: "", stderr: "" }))
          .mockImplementationOnce(() => {
            throw new Error("injected gateway remove failure");
          }),
    ],
    [
      "volume cleanup",
      () =>
        mocks.dockerRemoveVolumesByPrefix.mockImplementationOnce(() => {
          throw new Error("injected volume cleanup failure");
        }),
    ],
  ] as const)("converges on retry after a partial %s failure (#4662)", (_stage, injectFailure) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    injectFailure(runOpenshell);

    expect(() => cleanupGatewayAfterLastSandbox("nemoclaw-8081", runOpenshell)).toThrow();
    expect(() => cleanupGatewayAfterLastSandbox("nemoclaw-8081", runOpenshell)).not.toThrow();
    expect(runOpenshell).toHaveBeenCalledWith(["gateway", "remove", "nemoclaw-8081"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(mocks.dockerRemoveVolumesByPrefix).toHaveBeenCalledWith(
      "openshell-cluster-nemoclaw-8081",
      { ignoreError: true },
    );
  });
});
