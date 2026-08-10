// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import * as processRecovery from "./process-recovery";
import {
  restoreStoppedSandboxStartupState,
  type SandboxStartDeps,
  sandboxStartDependencies,
  startSandbox,
} from "./start";

const ORIGINAL_CONTAINER_ID = "a".repeat(64);

type StartupRecoveryResult = ReturnType<typeof restoreStoppedSandboxStartupState>;

function sandbox(values: Partial<SandboxEntry> = {}): SandboxEntry {
  return { name: "my-sandbox", ...values };
}

function runningStartupState(): ReturnType<typeof restoreStoppedSandboxStartupState> {
  return {
    checked: true,
    wasRunning: true,
    recovered: false,
    forwardRecovered: false,
  };
}

function stubProductionStartupRecovery(result: StartupRecoveryResult) {
  const check = vi
    .spyOn(processRecovery, "checkAndRecoverSandboxProcesses")
    .mockReturnValue(result);
  const restoreAccess = vi
    .spyOn(shields, "restoreLockedStateDirStartupAccess")
    .mockImplementation(() => undefined);
  return { check, restoreAccess };
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

describe("startSandbox", () => {
  beforeEach(() => {
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
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

  it("pins sealed startup access to the lifecycle container identity (#8662)", () => {
    const restoreAccess = vi.fn();
    const recovery = runningStartupState();
    const restoreProcesses = vi.fn(() => recovery);
    const processRecoveryOptions = { expectedContainerId: ORIGINAL_CONTAINER_ID };

    const result = restoreStoppedSandboxStartupState("my-sandbox", {
      agent: "openclaw",
      processRecovery: processRecoveryOptions,
      restoreLockedStartupAccess: restoreAccess,
      restoreProcessState: restoreProcesses,
    });

    expect(restoreAccess).toHaveBeenCalledExactlyOnceWith("my-sandbox", ORIGINAL_CONTAINER_ID);
    expect(restoreProcesses).toHaveBeenCalledExactlyOnceWith("my-sandbox", processRecoveryOptions);
    expect(result).toBe(recovery);
  });

  it("normalizes control characters before redacting startup diagnostics (#8662)", () => {
    const sanitized = connect.sanitizeSandboxStartupRecoveryDetail(
      "supervisor failed: Authorization:\u0000Bearer opaque-control-token",
    );

    expect(sanitized).toContain("Authorization: Bearer <REDACTED>");
    expect(sanitized).not.toContain("opaque-control-token");
    expect(sanitized).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
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
      preserveContainer: true,
      requirePinnedManagedGatewayProof: true,
    });
    expect(h.recoverDockerDriverSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      h.restoreStartupState.mock.invocationCallOrder[0],
    );
    expect(h.restoreStartupState.mock.invocationCallOrder[0]).toBeLessThan(
      h.verifyGateway.mock.invocationCallOrder[0],
    );
  });

  it("keeps the original container pinned through the production final probe (#8662)", async () => {
    const connectSandbox = vi.spyOn(connect, "connectSandbox").mockResolvedValue(undefined);
    const finalManagedProbe = vi
      .spyOn(connect, "pinnedManagedGatewayProbeFailure")
      .mockReturnValue(null);
    const h = harness({ verifyGateway: undefined });

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(connectSandbox).toHaveBeenCalledExactlyOnceWith("my-sandbox", {
      expectedContainerId: ORIGINAL_CONTAINER_ID,
      preserveContainer: true,
      probeOnly: true,
    });
    expect(finalManagedProbe).toHaveBeenCalledExactlyOnceWith("my-sandbox", ORIGINAL_CONTAINER_ID);
    expect(connectSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      finalManagedProbe.mock.invocationCallOrder[0],
    );
  }, 15_000);

  it("fails after connect-time reconciliation if the original container identity changes (#8662)", async () => {
    const connectSandbox = vi.spyOn(connect, "connectSandbox").mockResolvedValue(undefined);
    const finalManagedProbe = vi
      .spyOn(connect, "pinnedManagedGatewayProbeFailure")
      .mockReturnValue({
        layer: "privileged control unavailable",
        detail: "container identity changed; Authorization: Bearer opaque-post-connect-token",
      });
    const h = harness({ verifyGateway: undefined });

    await expect(startSandbox("my-sandbox", h.deps)).rejects.toThrow(
      /final managed gateway health.*container identity changed.*<REDACTED>/iu,
    );

    expect(connectSandbox).toHaveBeenCalledOnce();
    expect(finalManagedProbe).toHaveBeenCalledExactlyOnceWith("my-sandbox", ORIGINAL_CONTAINER_ID);
    expect(connectSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      finalManagedProbe.mock.invocationCallOrder[0],
    );
  }, 15_000);

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

  it("propagates the actual managed recovery failure before readiness verification (#8662)", async () => {
    const production = stubProductionStartupRecovery({
      checked: true,
      wasRunning: false,
      recovered: false,
      forwardRecovered: false,
    });
    const h = harness({ restoreStartupState: undefined });
    h.getSandbox.mockReturnValue(sandbox({ agent: "hermes" }));

    await expect(startSandbox("my-sandbox", h.deps)).rejects.toThrow(
      /startup recovery failed.*nemoclaw my-sandbox recover/iu,
    );

    expect(production.check).toHaveBeenCalledWith(
      "my-sandbox",
      expect.objectContaining({ preserveContainer: true, quiet: true }),
    );
    expect(production.restoreAccess).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it.each([
    "openclaw",
    "hermes",
  ] as const)("threads %s managed recovery success through production restoration before final verification (#8662)", async (agent) => {
    const managedResult = {
      checked: true,
      wasRunning: false,
      recovered: true,
      forwardRecovered: true,
      managedControlCompletion: {
        disposition: "ok",
        oldPid: 0,
        newPid: 4242,
      },
    } as StartupRecoveryResult;
    const production = stubProductionStartupRecovery(managedResult);
    const h = harness({ restoreStartupState: undefined });
    h.getSandbox.mockReturnValue(sandbox({ agent }));

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(h.restoreStartupState).not.toHaveBeenCalled();
    expect(production.check).toHaveBeenCalledWith(
      "my-sandbox",
      expect.objectContaining({ preserveContainer: true, quiet: true }),
    );
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox", {
      expectedContainerId: ORIGINAL_CONTAINER_ID,
      preserveContainer: true,
      requirePinnedManagedGatewayProof: true,
    });
    expect(h.recoverDockerDriverSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      production.check.mock.invocationCallOrder[0],
    );
    expect(production.check.mock.invocationCallOrder[0]).toBeLessThan(
      h.verifyGateway.mock.invocationCallOrder[0],
    );
    expect(production.restoreAccess.mock.calls).toEqual(
      agent === "openclaw" ? [["my-sandbox", ORIGINAL_CONTAINER_ID]] : [],
    );
    expect(
      agent === "hermes" ||
        production.restoreAccess.mock.invocationCallOrder[0] <
          production.check.mock.invocationCallOrder[0],
    ).toBe(true);
  });

  it("surfaces real preserved-controller failures for both managed agents through public start (#8662)", async () => {
    const getSessionAgent = vi.spyOn(agentRuntime, "getSessionAgent");
    const getPersistedSandbox = vi.spyOn(persistedRegistry, "getSandbox");

    for (const agent of ["openclaw", "hermes"] as const) {
      const sandboxName = agent === "openclaw" ? "oc-restart" : "hm-restart";
      const entry = sandbox({ name: sandboxName, agent, openshellDriver: "docker" });
      getSessionAgent.mockReturnValue({
        name: agent,
        displayName: agent === "hermes" ? "Hermes Agent" : "OpenClaw",
        forwardPort: agent === "hermes" ? 8642 : 18789,
        healthProbe: {
          port: agent === "hermes" ? 8642 : 18789,
          timeout_seconds: 30,
          url: `http://127.0.0.1:${agent === "hermes" ? 8642 : 18789}/health`,
        },
        runtime: { kind: "gateway" },
      } as never);
      getPersistedSandbox.mockReturnValue(entry);
      const controller = vi.fn(
        (
          _name: string,
          action: "restart" | "recover" | "probe",
          _timeout: number,
          expectedContainerId?: string,
        ) => {
          expect(expectedContainerId).toBe(ORIGINAL_CONTAINER_ID);
          return action === "recover"
            ? {
                status: 1,
                stdout: "",
                stderr:
                  "SUPERVISOR_UNAVAILABLE\nNEMOCLAW_CONTROL_STAGE=preflight\nAuthorization: Bearer opaque-token-8662",
              }
            : { status: 1, stdout: "", stderr: "GATEWAY_HEALTH_TIMEOUT" };
        },
      );
      const relaunch = vi.fn(() => {
        throw new Error("preserved start attempted to replace its container");
      });
      const restoreStartupState = vi.fn<NonNullable<SandboxStartDeps["restoreStartupState"]>>(
        (name, options = {}) =>
          connect.restoreSandboxStartupState(name, {
            ...options,
            isSandboxGatewayRunningImpl: () => null,
            requestPinnedGatewaySupervisorAction: controller,
            relaunchManagedSupervisorSessionImpl: relaunch,
            waitForManagedGatewaySupervisorImpl: () => true,
          }),
      );
      const h = harness({ restoreStartupState });
      h.getSandbox.mockReturnValue(entry);

      const failure = await startSandbox(sandboxName, h.deps).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const failureMessage = (failure as Error).message;
      expect(failureMessage).toMatch(
        /managed gateway recovery: supervisor unavailable.*NEMOCLAW_CONTROL_STAGE=preflight/iu,
      );
      expect(failureMessage).toContain("<REDACTED>");
      expect(failureMessage).not.toContain("opaque-token-8662");
      expect(restoreStartupState).toHaveBeenCalledWith(
        sandboxName,
        expect.objectContaining({ expectedContainerId: ORIGINAL_CONTAINER_ID }),
      );
      expect(controller).toHaveBeenCalledExactlyOnceWith(
        sandboxName,
        "recover",
        210000,
        ORIGINAL_CONTAINER_ID,
      );
      expect(relaunch).not.toHaveBeenCalled();
      expect(h.verifyGateway).not.toHaveBeenCalled();
    }
  });

  it("keeps a missing custom-agent manifest outside managed OpenClaw recovery (#8662)", async () => {
    const entry = sandbox({ agent: "custom-agent", openshellDriver: "docker" });
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null);
    vi.spyOn(persistedRegistry, "getSandbox").mockReturnValue(entry);
    const controller = vi.fn(() => {
      throw new Error("custom agent crossed the managed controller boundary");
    });
    const h = harness({
      startupRecovery: {
        isSandboxGatewayRunningImpl: () => null,
        requestGatewaySupervisorAction: controller,
      },
    });
    h.getSandbox.mockReturnValue(entry);

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(controller).not.toHaveBeenCalled();
    expect(h.restoreStartupState).toHaveBeenCalledWith("my-sandbox");
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox");
  });

  it("uses the session agent as the managed-recovery authority when registry state is stale (#8662)", async () => {
    const entry = sandbox({ agent: "openclaw", openshellDriver: "docker" });
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      name: "custom-gateway",
      displayName: "Custom Gateway",
      forwardPort: 19090,
      healthProbe: {
        port: 19090,
        timeout_seconds: 30,
        url: "http://127.0.0.1:19090/health",
      },
      runtime: { kind: "gateway" },
    } as never);
    vi.spyOn(persistedRegistry, "getSandbox").mockReturnValue(entry);
    const h = harness();
    h.getSandbox.mockReturnValue(entry);
    h.restoreStartupState.mockReturnValue({
      checked: false,
      wasRunning: null,
      recovered: false,
      forwardRecovered: false,
    });

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(h.restoreStartupState).toHaveBeenCalledExactlyOnceWith("my-sandbox");
    expect(h.verifyGateway).toHaveBeenCalledExactlyOnceWith("my-sandbox");
  });

  it("fails closed before verification when managed startup returns no runtime identity (#8662)", async () => {
    const h = harness();
    const docker = h.deps.runtimeProviders?.docker;
    expect(docker?.lifecycle.supported).toBe(true);
    const dockerProvider = docker as NonNullable<typeof docker>;
    const dockerLifecycle = dockerProvider.lifecycle as Extract<
      NonNullable<typeof docker>["lifecycle"],
      { readonly supported: true }
    >;
    const verifyStarted = vi.fn();
    const runtimeProviders = createRuntimeProviderBundleRegistry([
      [
        "docker",
        {
          ...dockerProvider,
          lifecycle: {
            ...dockerLifecycle,
            start: () => ({ exitCode: 0 }),
            verifyStarted,
          },
        },
      ],
    ]);
    h.getSandbox.mockReturnValue(sandbox({ agent: "openclaw", openshellDriver: "docker" }));

    const result = await startSandbox("my-sandbox", { ...h.deps, runtimeProviders });

    expect(result).toEqual({
      exitCode: 1,
      message:
        "  Sandbox 'my-sandbox' started, but runtime provider 'docker' returned no immutable " +
        "runtime identity. Refusing unpinned managed startup recovery; the existing sandbox was " +
        "preserved. Run 'nemoclaw doctor', then retry 'nemoclaw my-sandbox start'.",
    });
    expect(verifyStarted).not.toHaveBeenCalled();
    expect(h.restoreStartupState).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it.each(
    (["openclaw", "hermes"] as const).flatMap((agent) => [
      {
        agent,
        label: "inspection failure",
        result: {
          checked: false,
          wasRunning: null,
          recovered: false,
          forwardRecovered: false,
        } as StartupRecoveryResult,
        expected: /inspection.*could not be inspected/iu,
        privateDetail: undefined,
      },
      {
        agent,
        label: "secret-boundary refusal",
        result: {
          checked: true,
          wasRunning: true,
          recovered: false,
          forwardRecovered: false,
          secretBoundaryRefused: true,
          secretBoundaryReason: "raw-secret",
        } as StartupRecoveryResult,
        expected: /secret boundary.*agent secret boundary refused recovery/iu,
        privateDetail: "raw-secret",
      },
      {
        agent,
        label: "MCP reconciliation refusal",
        result: {
          checked: true,
          wasRunning: false,
          recovered: false,
          forwardRecovered: false,
          mcpReconciliationRefused: true,
          mcpReconciliationReason: "registered MCP intent no longer matches",
        } as StartupRecoveryResult,
        expected: /MCP reconciliation.*persisted managed MCP configuration does not match/iu,
        privateDetail: "registered MCP intent no longer matches",
      },
      {
        agent,
        label: "required-forward failure",
        result: {
          checked: true,
          wasRunning: false,
          recovered: true,
          forwardRecovered: false,
          forwardRecoveryFailed: true,
          forwardRecoveryFailureDetail: "the required API forward remained occupied",
        } as StartupRecoveryResult,
        expected: /host-forward recovery.*required host forward could not be restored/iu,
        privateDetail: "the required API forward remained occupied",
      },
      {
        agent,
        label: "inconclusive managed result",
        result: {
          checked: true,
          wasRunning: null,
          recovered: false,
          forwardRecovered: false,
        } as StartupRecoveryResult,
        expected: /inspection.*result was inconclusive/iu,
        privateDetail: undefined,
      },
    ]),
  )("fails closed for $agent $label before final readiness verification (#8662)", async ({
    agent,
    result,
    expected,
    privateDetail,
  }) => {
    const production = stubProductionStartupRecovery(result);
    const h = harness({ restoreStartupState: undefined });
    h.getSandbox.mockReturnValue(sandbox({ agent }));

    const failure = await startSandbox("my-sandbox", h.deps).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(expected);
    expect((failure as Error).message).not.toContain(privateDetail ?? "private-detail-not-present");
    expect(production.check).toHaveBeenCalledOnce();
    expect(h.verifyGateway).not.toHaveBeenCalled();
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
      preserveContainer: true,
      requirePinnedManagedGatewayProof: true,
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
      preserveContainer: true,
      requirePinnedManagedGatewayProof: true,
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
      preserveContainer: true,
      requirePinnedManagedGatewayProof: true,
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

  it("returns actionable guidance when Docker discovery is malformed (#8662)", async () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockImplementation(() => {
      throw new Error("opaque malformed discovery detail");
    });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result).toEqual({
      exitCode: 1,
      message:
        "  Docker could not verify the existing container for sandbox 'my-sandbox'. " +
        "Run 'nemoclaw doctor', then retry 'nemoclaw my-sandbox start'.",
    });
    expect(result.message).not.toContain("opaque malformed discovery detail");
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
