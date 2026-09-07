// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dockerRemoveVolumesByPrefix: vi.fn(),
  resolveGatewayTeardownAuthority: vi.fn(),
  stopHostGatewayProcesses: vi.fn(),
  GatewayAuthorityError: class GatewayAuthorityError extends Error {},
}));

vi.mock("../../adapters/docker/volume", () => ({
  dockerRemoveVolumesByPrefix: mocks.dockerRemoveVolumesByPrefix,
}));
vi.mock("../../onboard/host-gateway-process", () => ({
  stopHostGatewayProcesses: mocks.stopHostGatewayProcesses,
}));
vi.mock("../../onboard/gateway-teardown-authority", () => ({
  resolveGatewayTeardownAuthority: mocks.resolveGatewayTeardownAuthority,
  GatewayAuthorityError: mocks.GatewayAuthorityError,
  gatewayAuthorityFailureLines: (error: unknown, operation: string) => [
    `  Refusing ${operation}: ${String((error as Error).message)}`,
  ],
}));
import { cleanupGatewayAfterLastSandbox } from "./destroy-gateway";

function packagedServiceOwner({
  gatewayName,
  gatewayPort,
}: {
  gatewayName: string;
  gatewayPort: number;
}) {
  return {
    gatewayName,
    gatewayPort,
    mode: "nemoclaw-managed" as const,
    source: "packaged-service" as const,
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  };
}

function serviceStopResult(stopped: boolean, reason?: string, standaloneFallbackAllowed = false) {
  return {
    attempted: true,
    standaloneFallbackAllowed,
    manager: "systemd" as const,
    serviceName: "nemoclaw-openshell-gateway",
    statusCommand: "systemctl --user status nemoclaw-openshell-gateway",
    stopped,
    ...(reason === undefined ? {} : { reason }),
  };
}

function idleHostReaperResult() {
  return {
    failed: [],
    skippedDeadPids: [],
    skippedNonMatchingPids: [],
    stopped: [],
    sudoRemediationPids: [],
  };
}

describe("cleanupGatewayAfterLastSandbox", () => {
  beforeEach(() => {
    mocks.resolveGatewayTeardownAuthority.mockImplementation(
      ({ gatewayName, gatewayPort }: { gatewayName: string; gatewayPort: number }) => ({
        gatewayName,
        gatewayPort,
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
    );
    mocks.stopHostGatewayProcesses.mockReturnValue({
      failed: [],
      skippedDeadPids: [],
      skippedNonMatchingPids: [],
      stopped: [],
      sudoRemediationPids: [],
    });
  });

  it.each([
    "systemd-system",
    "systemd-user",
  ] as const)("does not stop or destroy a %s-supervised gateway during final-sandbox cleanup (#6576)", (kind) => {
    mocks.resolveGatewayTeardownAuthority.mockImplementationOnce(
      ({ gatewayName, gatewayPort }: { gatewayName: string; gatewayPort: number }) => ({
        gatewayName,
        gatewayPort,
        mode: "externally-supervised",
        source: "declared",
        endpoint: `http://127.0.0.1:${String(gatewayPort)}`,
        stateDir: "/var/lib/openshell/gateway",
        supervisor: {
          kind,
          serviceName: "openshell-gateway.service",
          execPath: "/usr/local/bin/openshell-gateway",
        },
        requiredCapabilities: [],
      }),
    );
    const runOpenshell = vi.fn((args: string[]) =>
      args[1] === "remove"
        ? { status: 2, stdout: "", stderr: "unrecognized subcommand 'remove'" }
        : { status: 0, stdout: "", stderr: "" },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    cleanupGatewayAfterLastSandbox("nemoclaw", runOpenshell);

    expect(mocks.resolveGatewayTeardownAuthority).toHaveBeenCalledWith(
      { gatewayName: "nemoclaw", gatewayPort: 8080 },
      { env: process.env },
    );
    expect(mocks.stopHostGatewayProcesses).not.toHaveBeenCalled();
    expect(runOpenshell).toHaveBeenCalledWith(["gateway", "remove", "nemoclaw"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(runOpenshell).not.toHaveBeenCalledWith(
      ["gateway", "destroy", "-g", "nemoclaw"],
      expect.anything(),
    );
    expect(mocks.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("will not use the legacy gateway destroy command"),
    );
  });

  it("fails before local cleanup when the gateway authority cannot be revalidated (#6576)", () => {
    // A failure that is not an authority refusal still aborts outright: #6576's
    // contract is that nothing may touch the gateway before authority is proven.
    mocks.resolveGatewayTeardownAuthority.mockImplementationOnce(() => {
      throw new Error("authority drift");
    });
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    expect(() => cleanupGatewayAfterLastSandbox("nemoclaw", runOpenshell)).toThrow(
      "authority drift",
    );
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(mocks.stopHostGatewayProcesses).not.toHaveBeenCalled();
    expect(mocks.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();
  });

  it("reports an authority migration and skips cleanup without aborting destroy (#8103)", () => {
    // Same #6576 guarantee — no gateway effect runs — but the typed refusal is
    // reported instead of thrown, so `destroy` can still finish removing the
    // sandbox it has already deleted.
    mocks.resolveGatewayTeardownAuthority.mockImplementationOnce(() => {
      throw new mocks.GatewayAuthorityError("authority changed since onboarding");
    });
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(() => cleanupGatewayAfterLastSandbox("nemoclaw", runOpenshell)).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("authority changed since onboarding"),
    );
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(mocks.stopHostGatewayProcesses).not.toHaveBeenCalled();
    expect(mocks.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();
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

  it("stops the packaged gateway service before the host reaper on final destroy (#7904)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    mocks.resolveGatewayTeardownAuthority.mockImplementationOnce(packagedServiceOwner);
    const events: string[] = [];
    mocks.stopHostGatewayProcesses.mockImplementationOnce(() => {
      events.push("host-reaper");
      return idleHostReaperResult();
    });
    const stopService = vi.fn(() => {
      events.push("service-stop");
      return serviceStopResult(true);
    });
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    cleanupGatewayAfterLastSandbox("nemoclaw", runOpenshell, {
      stopOpenShellGatewayUserService: stopService,
    });

    expect(events).toEqual(["service-stop", "host-reaper"]);
    expect(runOpenshell).toHaveBeenCalledWith(["gateway", "remove", "nemoclaw"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(mocks.dockerRemoveVolumesByPrefix).toHaveBeenCalledWith("openshell-cluster-nemoclaw", {
      ignoreError: true,
    });
  });

  it("fails destroy when the packaged gateway service survives the stop (#7904)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    mocks.resolveGatewayTeardownAuthority.mockImplementationOnce(packagedServiceOwner);
    const stopService = vi.fn(() =>
      serviceStopResult(false, "systemctl --user stop nemoclaw-openshell-gateway failed: timeout"),
    );
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    expect(() =>
      cleanupGatewayAfterLastSandbox("nemoclaw", runOpenshell, {
        stopOpenShellGatewayUserService: stopService,
      }),
    ).toThrow("systemctl --user status nemoclaw-openshell-gateway");
    expect(mocks.stopHostGatewayProcesses).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalledWith(
      ["gateway", "remove", "nemoclaw"],
      expect.anything(),
    );
    expect(mocks.dockerRemoveVolumesByPrefix).not.toHaveBeenCalled();
  });

  it("stops the recorded standalone gateway when the systemd user manager is unavailable", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    mocks.resolveGatewayTeardownAuthority.mockImplementationOnce(packagedServiceOwner);
    mocks.stopHostGatewayProcesses.mockReturnValueOnce({
      ...idleHostReaperResult(),
      stopped: [4242],
    });
    const clearGatewayRuntimeFiles = vi.fn();
    const isGatewayPortFree = vi.fn(() => true);
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    cleanupGatewayAfterLastSandbox("nemoclaw", runOpenshell, {
      clearGatewayRuntimeFiles,
      isGatewayPortFree,
      stopOpenShellGatewayUserService: () =>
        serviceStopResult(
          false,
          "systemctl --user stop failed: Failed to connect to bus: No medium found",
          true,
        ),
    });

    expect(mocks.stopHostGatewayProcesses).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        clearRuntimeFiles: false,
        openShellGatewayName: "nemoclaw",
        openShellGatewayPort: 8080,
        usePgrepFallback: false,
      }),
    );
    expect(isGatewayPortFree).toHaveBeenCalledWith(8080);
    expect(clearGatewayRuntimeFiles).toHaveBeenCalledWith(
      "/home/tester/.local/state/nemoclaw/openshell-docker-gateway",
      "/home/tester/.local/state/nemoclaw/openshell-docker-gateway/openshell-gateway.pid",
    );
    expect(runOpenshell).toHaveBeenCalledWith(["gateway", "remove", "nemoclaw"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("fails closed when a headless service stop has no recorded standalone owner", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    mocks.resolveGatewayTeardownAuthority.mockImplementationOnce(packagedServiceOwner);
    const isGatewayPortFree = vi.fn(() => true);
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    expect(() =>
      cleanupGatewayAfterLastSandbox("nemoclaw", runOpenshell, {
        isGatewayPortFree,
        stopOpenShellGatewayUserService: () =>
          serviceStopResult(false, "Failed to connect to bus: No medium found", true),
      }),
    ).toThrow(/no recorded standalone gateway process proved ownership/);
    expect(isGatewayPortFree).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalledWith(
      ["gateway", "remove", "nemoclaw"],
      expect.anything(),
    );
  });

  it("fails closed when the gateway port stays occupied after headless fallback cleanup", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    mocks.resolveGatewayTeardownAuthority.mockImplementationOnce(packagedServiceOwner);
    mocks.stopHostGatewayProcesses.mockReturnValueOnce({
      ...idleHostReaperResult(),
      stopped: [4242],
    });
    const clearGatewayRuntimeFiles = vi.fn();
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    expect(() =>
      cleanupGatewayAfterLastSandbox("nemoclaw", runOpenshell, {
        clearGatewayRuntimeFiles,
        isGatewayPortFree: () => false,
        stopOpenShellGatewayUserService: () =>
          serviceStopResult(false, "Failed to connect to bus: No medium found", true),
      }),
    ).toThrow(/gateway port 8080 remains occupied/);
    expect(clearGatewayRuntimeFiles).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalledWith(
      ["gateway", "remove", "nemoclaw"],
      expect.anything(),
    );
  });

  it("retries headless fallback cleanup after volume removal fails", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    mocks.resolveGatewayTeardownAuthority.mockImplementation(packagedServiceOwner);
    mocks.stopHostGatewayProcesses
      .mockReturnValueOnce({
        ...idleHostReaperResult(),
        stopped: [4242],
      })
      .mockReturnValueOnce({
        ...idleHostReaperResult(),
        skippedDeadPids: [4242],
      });
    mocks.dockerRemoveVolumesByPrefix.mockImplementationOnce(() => {
      throw new Error("injected volume cleanup failure");
    });
    const clearGatewayRuntimeFiles = vi.fn();
    const isGatewayPortFree = vi.fn(() => true);
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const deps = {
      clearGatewayRuntimeFiles,
      isGatewayPortFree,
      stopOpenShellGatewayUserService: () =>
        serviceStopResult(false, "Failed to connect to bus: No medium found", true),
    };

    expect(() => cleanupGatewayAfterLastSandbox("nemoclaw", runOpenshell, deps)).toThrow(
      "injected volume cleanup failure",
    );
    expect(clearGatewayRuntimeFiles).not.toHaveBeenCalled();

    expect(() => cleanupGatewayAfterLastSandbox("nemoclaw", runOpenshell, deps)).not.toThrow();
    expect(mocks.stopHostGatewayProcesses).toHaveBeenCalledTimes(2);
    expect(isGatewayPortFree).toHaveBeenCalledTimes(2);
    expect(clearGatewayRuntimeFiles).toHaveBeenCalledOnce();
    expect(mocks.dockerRemoveVolumesByPrefix).toHaveBeenCalledTimes(2);
  });

  it("leaves the service manager alone for a standalone NemoClaw gateway (#7904)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(os, "homedir").mockReturnValue("/home/tester");
    const stopService = vi.fn(() => serviceStopResult(true));
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

    cleanupGatewayAfterLastSandbox("nemoclaw", runOpenshell, {
      stopOpenShellGatewayUserService: stopService,
    });

    expect(stopService).not.toHaveBeenCalled();
    expect(mocks.stopHostGatewayProcesses).toHaveBeenCalledOnce();
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
        runOpenshell.mockImplementationOnce(() => {
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
