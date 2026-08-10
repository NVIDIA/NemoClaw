// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as openshellRuntime from "../../adapters/openshell/runtime";
import * as agentRuntime from "../../agent/runtime";
import {
  createDockerRuntimeProviderBundle,
  createKubernetesRuntimeProviderBundle,
  type DockerRuntimeProviderDependencies,
} from "../../onboard/runtime-provider/docker";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import * as shields from "../../shields";
import type { SandboxEntry } from "../../state/registry";
import * as persistedRegistry from "../../state/registry";
import * as connect from "./connect";
import * as forwardHealth from "./forward-health";
import {
  restoreStoppedSandboxStartupState,
  type SandboxStartDeps,
  sandboxStartDependencies,
  startSandbox,
} from "./start";

const ORIGINAL_CONTAINER_ID = "a".repeat(64);

function sandbox(values: Partial<SandboxEntry> = {}): SandboxEntry {
  return { name: "my-sandbox", ...values };
}

function runningStartupState(): ReturnType<typeof restoreStoppedSandboxStartupState> {
  return {
    processCheck: {
      checked: true,
      wasRunning: true,
      recovered: false,
      forwardRecovered: false,
    },
    startupFailure: null,
  };
}

function harness(overrides: Partial<SandboxStartDeps> = {}) {
  const getSandbox = vi.fn<NonNullable<SandboxStartDeps["getSandbox"]>>(() => sandbox());
  const isDockerRuntimeDown = vi.fn<DockerRuntimeProviderDependencies["isRuntimeDown"]>(
    () => false,
  );
  const printDockerRuntimeDownGuidance =
    vi.fn<DockerRuntimeProviderDependencies["printRuntimeDownGuidance"]>();
  const findLabeledSandboxContainers = vi.fn<
    DockerRuntimeProviderDependencies["findLabeledSandboxContainers"]
  >(() => [
    {
      containerId: ORIGINAL_CONTAINER_ID,
      name: "openshell-my-sandbox",
      status: "Exited (0) 2 hours ago",
      running: false,
    },
  ]);
  const recoverDockerDriverSandbox = vi.fn<DockerRuntimeProviderDependencies["recoverSandbox"]>(
    () => ({
      recovered: true,
      via: "started-stopped-original",
      containerId: ORIGINAL_CONTAINER_ID,
      containerName: "openshell-my-sandbox",
    }),
  );
  const dockerUnpause = vi.fn<DockerRuntimeProviderDependencies["unpauseContainer"]>(() => ({
    status: 0,
  }));
  const verifyGateway = vi.fn<NonNullable<SandboxStartDeps["verifyGateway"]>>(() =>
    Promise.resolve(),
  );
  const restoreStartupState = vi.fn<NonNullable<SandboxStartDeps["restoreStartupState"]>>(() =>
    runningStartupState(),
  );
  const log = vi.fn<(message: string) => void>();
  const runtimeProviders = createRuntimeProviderBundleRegistry([
    [
      "docker",
      createDockerRuntimeProviderBundle({
        findLabeledSandboxContainers,
        isRuntimeDown: isDockerRuntimeDown,
        printRuntimeDownGuidance: printDockerRuntimeDownGuidance,
        recoverSandbox: recoverDockerDriverSandbox,
        unpauseContainer: dockerUnpause,
      }),
    ],
    ["kubernetes", createKubernetesRuntimeProviderBundle()],
  ]);
  const deps: SandboxStartDeps = {
    getSandbox,
    runtimeProviders,
    restoreStartupState,
    verifyGateway,
    log,
    ...overrides,
  };
  return {
    deps,
    dockerUnpause,
    findLabeledSandboxContainers,
    getSandbox,
    isDockerRuntimeDown,
    log,
    printDockerRuntimeDownGuidance,
    recoverDockerDriverSandbox,
    restoreStartupState,
    verifyGateway,
  };
}

const MANAGED_AGENT_CASES = [
  {
    agent: "openclaw",
    displayName: "OpenClaw",
    port: 18789,
    stateAccessCalls: [["my-sandbox", ORIGINAL_CONTAINER_ID]],
  },
  {
    agent: "hermes",
    displayName: "Hermes Agent",
    port: 8642,
    stateAccessCalls: [],
  },
] as const;

const managedProbeSuccess = {
  status: 0,
  stdout: `v1 ${"b".repeat(64)} complete already-running 4242 4242\nGATEWAY_PID=4242`,
  stderr: "",
};
const managedRecoverySuccess = {
  status: 0,
  stdout: `v1 ${"a".repeat(64)} complete ok 0 4242\nGATEWAY_PID=4242`,
  stderr: "",
};

function managedStartHarness({ agent, displayName, port }: (typeof MANAGED_AGENT_CASES)[number]) {
  vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS", "0");
  vi.stubEnv("NEMOCLAW_FORWARD_RECOVERY_WAIT_MS", "0");

  const entry = sandbox({ agent, dashboardPort: port, openshellDriver: "docker" });
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
    name: agent,
    displayName,
    forwardPort: port,
    healthProbe: { port, timeout_seconds: 30, url: `http://127.0.0.1:${port}/health` },
    runtime: { kind: "gateway" },
  } as never);
  vi.spyOn(persistedRegistry, "getSandbox").mockReturnValue(entry);
  vi.spyOn(forwardHealth, "isLocalForwardReachable").mockReturnValue(true);

  const forwardList = `SANDBOX  BIND  PORT  PID  STATUS\nmy-sandbox  127.0.0.1  ${port}  12345  running`;
  vi.spyOn(openshellRuntime, "captureOpenshell")
    .mockReturnValueOnce({ status: 0, output: "SANDBOX BIND PORT PID STATUS" } as never)
    .mockReturnValue({ status: 0, output: forwardList } as never);
  const runOpenshell = vi
    .spyOn(openshellRuntime, "runOpenshell")
    .mockReturnValue({ status: 0 } as never);
  const restoreAccess = vi
    .spyOn(shields, "restoreLockedStateDirStartupAccess")
    .mockImplementation(() => undefined);
  const unpinnedController = vi.fn(() => {
    throw new Error("startup recovery crossed the pinned controller boundary");
  });
  const resultByAction = {
    probe: managedProbeSuccess,
    recover: managedRecoverySuccess,
    restart: { status: 1, stdout: "", stderr: "unexpected restart action" },
  } as const;
  const controller = vi.fn(
    (
      _name: string,
      action: keyof typeof resultByAction,
      _timeout: number,
      expectedContainerId?: string,
    ) => {
      return resultByAction[action];
    },
  );
  const connectSandbox = vi.spyOn(connect, "connectSandbox").mockResolvedValue(undefined);
  const waitForOpenShellReady = vi.fn(() => true);
  const h = harness({
    restoreStartupState: undefined,
    verifyGateway: undefined,
    startupRecovery: {
      isWsl: false,
      requestGatewaySupervisorAction: unpinnedController,
      requestPinnedGatewaySupervisorAction: controller,
      waitForRecreatedSandboxOpenShellReadyImpl: waitForOpenShellReady,
    },
  });
  h.getSandbox.mockReturnValue(entry);
  return {
    connectSandbox,
    controller,
    h,
    restoreAccess,
    runOpenshell,
    unpinnedController,
    waitForOpenShellReady,
  };
}

describe("startSandbox", () => {
  beforeEach(() => {
    vi.spyOn(sandboxStartDependencies, "loadConnect").mockReturnValue(connect);
    vi.spyOn(sandboxStartDependencies, "loadShields").mockReturnValue(shields);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("restores sealed access before recovering sandbox processes (#8112)", () => {
    const restoreAccess = vi.fn();
    const recovery = runningStartupState();
    const restoreProcesses = vi.fn(() => recovery);

    const result = restoreStoppedSandboxStartupState("my-sandbox", {
      agent: "openclaw",
      restoreLockedStartupAccess: restoreAccess,
      restoreProcessState: restoreProcesses,
    });

    expect(restoreAccess).toHaveBeenCalledWith("my-sandbox", undefined);
    expect(restoreProcesses).toHaveBeenCalledWith("my-sandbox");
    expect(restoreAccess.mock.invocationCallOrder[0]).toBeLessThan(
      restoreProcesses.mock.invocationCallOrder[0],
    );
    expect(result).toBe(recovery);
  });

  it("keeps Hermes sealed state untouched while recovering sandbox processes (#8112)", () => {
    const restoreAccess = vi.fn();
    const recovery = runningStartupState();
    const restoreProcesses = vi.fn(() => recovery);

    const result = restoreStoppedSandboxStartupState("my-sandbox", {
      agent: "hermes",
      restoreLockedStartupAccess: restoreAccess,
      restoreProcessState: restoreProcesses,
    });

    expect(restoreAccess).not.toHaveBeenCalled();
    expect(restoreProcesses).toHaveBeenCalledWith("my-sandbox");
    expect(result).toBe(recovery);
  });

  it("restores startup state before probing readiness after a stopped container starts (#8112)", async () => {
    const h = harness();

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.recoverDockerDriverSandbox).toHaveBeenCalledWith("my-sandbox", {
      readiness: "runtime-running",
    });
    expect(h.restoreStartupState).toHaveBeenCalledWith(
      "my-sandbox",
      expect.objectContaining({ expectedContainerId: ORIGINAL_CONTAINER_ID }),
    );
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox", {
      expectedContainerId: ORIGINAL_CONTAINER_ID,
    });
    expect(h.recoverDockerDriverSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      h.restoreStartupState.mock.invocationCallOrder[0],
    );
    expect(h.restoreStartupState.mock.invocationCallOrder[0]).toBeLessThan(
      h.verifyGateway.mock.invocationCallOrder[0],
    );
  });

  it("attempts startup restoration again when start is rerun after a failure (#8112)", async () => {
    const h = harness();
    h.restoreStartupState.mockImplementationOnce(() => {
      throw new Error("restore failed");
    });

    await expect(startSandbox("my-sandbox", h.deps)).rejects.toThrow("restore failed");
    expect(h.verifyGateway).not.toHaveBeenCalled();

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.restoreStartupState).toHaveBeenCalledTimes(2);
    expect(h.verifyGateway).toHaveBeenCalledOnce();
    expect(h.restoreStartupState.mock.invocationCallOrder[1]).toBeLessThan(
      h.verifyGateway.mock.invocationCallOrder[0],
    );
  });

  it("directs expired Shields startup recovery to the command that can complete it (#8662)", async () => {
    const h = harness();
    h.restoreStartupState.mockImplementation(() => {
      throw Object.assign(new Error("expired auto-restore"), {
        code: "NEMOCLAW_SHIELDS_AUTO_RESTORE_REQUIRED",
      });
    });

    await expect(startSandbox("my-sandbox", h.deps)).rejects.toThrow(
      /nemoclaw my-sandbox shields up.*retry `nemoclaw my-sandbox start`/iu,
    );

    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it.each(
    MANAGED_AGENT_CASES,
  )("recovers $agent through public start without replacing its pinned container (#8662)", async (agentCase) => {
    const f = managedStartHarness(agentCase);

    await expect(startSandbox("my-sandbox", f.h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(f.h.recoverDockerDriverSandbox).toHaveBeenCalledExactlyOnceWith("my-sandbox", {
      readiness: "runtime-running",
    });
    expect(f.controller.mock.calls.map(([, action]) => action)).toEqual([
      "probe",
      "recover",
      "probe",
      "probe",
      "probe",
      "probe",
    ]);
    expect(f.controller.mock.calls.map(([, , , containerId]) => containerId)).toEqual(
      Array(f.controller.mock.calls.length).fill(ORIGINAL_CONTAINER_ID),
    );
    expect(f.runOpenshell.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ["forward", "stop"],
      ["forward", "start"],
    ]);
    expect(f.controller.mock.invocationCallOrder[3]).toBeLessThan(
      f.runOpenshell.mock.invocationCallOrder[1],
    );
    expect(f.waitForOpenShellReady.mock.invocationCallOrder[0]).toBeLessThan(
      f.runOpenshell.mock.invocationCallOrder[1],
    );
    expect(f.runOpenshell.mock.invocationCallOrder[1]).toBeLessThan(
      f.controller.mock.invocationCallOrder[4],
    );
    expect(f.restoreAccess.mock.calls).toEqual(agentCase.stateAccessCalls);
    expect(f.unpinnedController).not.toHaveBeenCalled();
    expect(f.connectSandbox).toHaveBeenCalledExactlyOnceWith("my-sandbox", {
      expectedContainerId: ORIGINAL_CONTAINER_ID,
      probeOnly: true,
    });
  });

  it("propagates an actionable, sanitized managed recovery failure (#8662)", async () => {
    const f = managedStartHarness(MANAGED_AGENT_CASES[0]);
    const resultByAction = {
      probe: managedProbeSuccess,
      recover: {
        status: 1,
        stdout: "",
        stderr:
          "SUPERVISOR_UNAVAILABLE\nNEMOCLAW_CONTROL_STAGE=preflight\nAuthorization: Bearer opaque-token-8662",
      },
      restart: { status: 1, stdout: "", stderr: "unexpected restart action" },
    } as const;
    f.controller.mockImplementation((_name, action) => resultByAction[action]);

    const failure = await startSandbox("my-sandbox", f.h.deps).catch((error) => String(error));
    expect(failure).toMatch(
      /managed gateway recovery.*SUPERVISOR_UNAVAILABLE.*NEMOCLAW_CONTROL_STAGE=preflight.*<REDACTED>.*nemoclaw my-sandbox recover/isu,
    );
    expect(failure).not.toContain("opaque-token-8662");

    expect(f.controller.mock.calls.map(([, action]) => action)).toEqual(["probe", "recover"]);
    expect(f.controller.mock.calls.map(([, , , containerId]) => containerId)).toEqual(
      Array(2).fill(ORIGINAL_CONTAINER_ID),
    );
    expect(f.runOpenshell).not.toHaveBeenCalled();
    expect(f.unpinnedController).not.toHaveBeenCalled();
    expect(f.connectSandbox).not.toHaveBeenCalled();
  });

  it("reports the started container by name (#6026)", async () => {
    const h = harness();

    await startSandbox("my-sandbox", h.deps);

    const output = h.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("openshell-my-sandbox");
  });

  it("still probes when the container was already running (#6026)", async () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      {
        containerId: ORIGINAL_CONTAINER_ID,
        name: "openshell-my-sandbox",
        status: "Up 5 minutes",
        running: true,
      },
    ]);
    h.recoverDockerDriverSandbox.mockReturnValue({
      recovered: true,
      via: "started-running-original",
      containerId: ORIGINAL_CONTAINER_ID,
      containerName: "openshell-my-sandbox",
    });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.restoreStartupState).toHaveBeenCalledWith(
      "my-sandbox",
      expect.objectContaining({ expectedContainerId: ORIGINAL_CONTAINER_ID }),
    );
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox", {
      expectedContainerId: ORIGINAL_CONTAINER_ID,
    });
    expect(h.restoreStartupState.mock.invocationCallOrder[0]).toBeLessThan(
      h.verifyGateway.mock.invocationCallOrder[0],
    );
    const output = h.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("already running");
  });

  it("unpauses a paused container instead of calling it already running (#6026)", async () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      {
        containerId: ORIGINAL_CONTAINER_ID,
        name: "openshell-my-sandbox",
        status: "Up 3 minutes (Paused)",
        running: true,
      },
    ]);

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.dockerUnpause).toHaveBeenCalledWith(ORIGINAL_CONTAINER_ID, {
      ignoreError: true,
      timeout: 30_000,
    });
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
    expect(h.restoreStartupState).toHaveBeenCalledWith(
      "my-sandbox",
      expect.objectContaining({ expectedContainerId: ORIGINAL_CONTAINER_ID }),
    );
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox", {
      expectedContainerId: ORIGINAL_CONTAINER_ID,
    });
    expect(h.restoreStartupState.mock.invocationCallOrder[0]).toBeLessThan(
      h.verifyGateway.mock.invocationCallOrder[0],
    );
    const output = h.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("unpaused");
  });

  it("surfaces a docker unpause failure with the container name (#6026)", async () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      {
        containerId: ORIGINAL_CONTAINER_ID,
        name: "openshell-my-sandbox",
        status: "Up 3 minutes (Paused)",
        running: true,
      },
    ]);
    h.dockerUnpause.mockReturnValue({ status: 125 });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("openshell-my-sandbox");
    expect(result.message).toContain("125");
    expect(h.restoreStartupState).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("restores a gpu-backup sibling through the recovery rename path (#6026)", async () => {
    const h = harness();
    h.recoverDockerDriverSandbox.mockReturnValue({
      recovered: true,
      via: "renamed-and-started-backup",
      containerId: ORIGINAL_CONTAINER_ID,
      containerName: "openshell-my-sandbox",
    });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox", {
      expectedContainerId: ORIGINAL_CONTAINER_ID,
    });
  });

  it("refuses startup recovery when Docker omits the immutable container identity (#8662)", async () => {
    const h = harness();
    h.recoverDockerDriverSandbox.mockReturnValue({
      recovered: true,
      via: "started-stopped-original",
      containerName: "openshell-my-sandbox",
    });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/without its immutable container identity.*unpinned/iu);
    expect(h.restoreStartupState).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("names the Docker daemon outage instead of claiming the container was removed (#6026)", async () => {
    const h = harness();
    h.isDockerRuntimeDown.mockReturnValue(true);

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toBeUndefined();
    expect(h.printDockerRuntimeDownGuidance).toHaveBeenCalledWith("my-sandbox", {
      retryCommand: "start",
    });
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
    expect(h.restoreStartupState).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("fails with the recovery detail and a rebuild hint when no container exists (#6026)", async () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([]);
    h.recoverDockerDriverSandbox.mockReturnValue({
      recovered: false,
      via: null,
      detail: "no Docker container labeled 'openshell.ai/sandbox-name=my-sandbox'",
    });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("no Docker container labeled");
    expect(result.message).toContain("rebuild");
    expect(h.restoreStartupState).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("fails closed on malformed Docker metadata without mutating the container", async () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockImplementation(() => {
      throw new Error("Docker returned malformed OpenShell sandbox container metadata.");
    });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result).toMatchObject({ exitCode: 1, message: expect.stringContaining("preserved") });
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
    expect(h.restoreStartupState).not.toHaveBeenCalled();
  });

  it("refuses an unregistered sandbox (#6026)", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(null);

    const result = await startSandbox("ghost", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("not registered");
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
    expect(h.restoreStartupState).not.toHaveBeenCalled();
  });

  it("refuses non-direct drivers instead of guessing at container control (#6026)", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ openshellDriver: "kubernetes" }));

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("kubernetes");
    expect(result.message).toContain("does not authorize 'start' mutation");
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
    expect(h.restoreStartupState).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it.each([
    "unknown-runtime",
    "mxc-not-installed",
  ])("fails closed for unregistered provider %s without lifecycle side effects", async (providerId) => {
    const h = harness();
    h.getSandbox.mockReturnValue(sandbox({ openshellDriver: providerId }));

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain(providerId);
    expect(result.message).toContain("has no registered lifecycle provider");
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
    expect(h.dockerUnpause).not.toHaveBeenCalled();
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
    expect(h.restoreStartupState).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it.each([
    ["null driver", sandbox({ openshellDriver: null })],
    ["docker driver", sandbox({ openshellDriver: "docker" })],
    ["vm driver", sandbox({ openshellDriver: "vm" })],
  ])("allows the %s like privileged exec does (#6026)", async (_label, entry) => {
    const h = harness();
    h.getSandbox.mockReturnValue(entry);

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
  });

  it("propagates a probe rejection instead of reporting success (#6026)", async () => {
    const h = harness();
    h.verifyGateway.mockRejectedValue(new Error("probe exploded"));

    await expect(startSandbox("my-sandbox", h.deps)).rejects.toThrow("probe exploded");
  });
});
