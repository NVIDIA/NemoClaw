// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import type { OpenShellSandboxObserver } from "../../adapters/openshell/sandbox-observer";
import {
  createDockerRuntimeProviderBundle,
  createKubernetesRuntimeProviderBundle,
  type DockerRuntimeProviderDependencies,
} from "../../onboard/runtime-provider/docker";
import { createRuntimeProviderBundleRegistry } from "../../onboard/runtime-provider/registry";
import type { SandboxEntry } from "../../state/registry";
import type { SandboxStartupRecoveryResult } from "./connect";
import { restoreStoppedSandboxStartupState, type SandboxStartDeps, startSandbox } from "./start";

function sandbox(values: Partial<SandboxEntry> = {}): SandboxEntry {
  return { name: "my-sandbox", ...values };
}

const SUCCESSFUL_RECOVERY = {
  checked: true,
  wasRunning: true,
  recovered: false,
  forwardRecovered: false,
} as const satisfies SandboxStartupRecoveryResult;
const FAILED_RECOVERY = { ...SUCCESSFUL_RECOVERY, wasRunning: false } as const;
const REDACTED_TOKEN = "opaque-token-8662";

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
      name: "openshell-my-sandbox",
      status: "Exited (0) 2 hours ago",
      running: false,
    },
  ]);
  const hasPortableLifecycleReceipt = vi.fn<
    DockerRuntimeProviderDependencies["hasPortableLifecycleReceipt"]
  >(() => false);
  const recoverPortableSandbox = vi.fn<DockerRuntimeProviderDependencies["recoverPortableSandbox"]>(
    () => ({ kind: "not-installed" }),
  );
  const recoverDockerDriverSandbox = vi.fn<DockerRuntimeProviderDependencies["recoverSandbox"]>(
    () => ({
      recovered: true,
      via: "started-stopped-original",
      containerName: "openshell-my-sandbox",
    }),
  );
  const dockerUnpause = vi.fn<DockerRuntimeProviderDependencies["unpauseContainer"]>(() => ({
    status: 0,
  }));
  const verifyGateway = vi.fn<NonNullable<SandboxStartDeps["verifyGateway"]>>(() =>
    Promise.resolve(),
  );
  const restoreStartupState = vi.fn<NonNullable<SandboxStartDeps["restoreStartupState"]>>(
    () => SUCCESSFUL_RECOVERY,
  );
  const waitForManagedGatewaySupervisor = vi.fn<
    NonNullable<SandboxStartDeps["waitForManagedGatewaySupervisor"]>
  >(() => false);
  const log = vi.fn<(message: string) => void>();
  const runtimeProviders = createRuntimeProviderBundleRegistry([
    [
      "docker",
      createDockerRuntimeProviderBundle({
        findLabeledSandboxContainers,
        hasPortableLifecycleReceipt,
        isRuntimeDown: isDockerRuntimeDown,
        printRuntimeDownGuidance: printDockerRuntimeDownGuidance,
        recoverSandbox: recoverDockerDriverSandbox,
        recoverPortableSandbox,
        unpauseContainer: dockerUnpause,
      }),
    ],
    ["kubernetes", createKubernetesRuntimeProviderBundle()],
  ]);
  const deps: SandboxStartDeps = {
    getSandbox,
    runtimeProviders,
    restoreStartupState,
    waitForManagedGatewaySupervisor,
    verifyGateway,
    log,
    withLifecycleLock: async (_sandboxName, operation) => operation(),
    ...overrides,
  };
  return {
    deps,
    dockerUnpause,
    findLabeledSandboxContainers,
    getSandbox,
    hasPortableLifecycleReceipt,
    isDockerRuntimeDown,
    log,
    printDockerRuntimeDownGuidance,
    recoverDockerDriverSandbox,
    recoverPortableSandbox,
    restoreStartupState,
    waitForManagedGatewaySupervisor,
    verifyGateway,
  };
}

describe("startSandbox", () => {
  it("restores sealed access before recovering sandbox processes (#8112)", async () => {
    const restoreAccess = vi.fn();
    const recovery = SUCCESSFUL_RECOVERY;
    const restoreProcesses = vi.fn(() => recovery);

    const result = await restoreStoppedSandboxStartupState("my-sandbox", {
      agent: "openclaw",
      restoreLockedStartupAccess: restoreAccess,
      waitForSandboxReady: vi.fn(),
      restoreProcessState: restoreProcesses,
    });

    expect(restoreAccess).toHaveBeenCalledWith("my-sandbox");
    expect(restoreProcesses).toHaveBeenCalledWith("my-sandbox");
    expect(restoreAccess.mock.invocationCallOrder[0]).toBeLessThan(
      restoreProcesses.mock.invocationCallOrder[0],
    );
    expect(result).toBe(recovery);
  });

  it("keeps Hermes sealed state untouched while recovering sandbox processes (#8112)", async () => {
    const restoreAccess = vi.fn();
    const restoreProcesses = vi.fn(() => SUCCESSFUL_RECOVERY);

    await restoreStoppedSandboxStartupState("my-sandbox", {
      agent: "hermes",
      restoreLockedStartupAccess: restoreAccess,
      waitForSandboxReady: vi.fn(),
      restoreProcessState: restoreProcesses,
    });

    expect(restoreAccess).not.toHaveBeenCalled();
    expect(restoreProcesses).toHaveBeenCalledWith("my-sandbox");
  });

  it("waits for OpenShell readiness after restoring sealed access and before recovering sandbox processes (#8978)", async () => {
    const restoreAccess = vi.fn();
    const waitForSandboxReady = vi.fn();
    const restoreProcesses = vi.fn(() => SUCCESSFUL_RECOVERY);

    await restoreStoppedSandboxStartupState("my-sandbox", {
      agent: "openclaw",
      restoreLockedStartupAccess: restoreAccess,
      waitForSandboxReady,
      restoreProcessState: restoreProcesses,
    });

    expect(waitForSandboxReady).toHaveBeenCalledWith("my-sandbox");
    expect(restoreAccess.mock.invocationCallOrder[0]).toBeLessThan(
      waitForSandboxReady.mock.invocationCallOrder[0],
    );
    expect(waitForSandboxReady.mock.invocationCallOrder[0]).toBeLessThan(
      restoreProcesses.mock.invocationCallOrder[0],
    );
  });

  it("waits for OpenShell readiness before recovering Hermes sandbox processes (#8978)", async () => {
    const waitForSandboxReady = vi.fn();
    const restoreProcesses = vi.fn(() => SUCCESSFUL_RECOVERY);

    await restoreStoppedSandboxStartupState("my-sandbox", {
      agent: "hermes",
      restoreLockedStartupAccess: vi.fn(),
      waitForSandboxReady,
      restoreProcessState: restoreProcesses,
    });

    expect(waitForSandboxReady.mock.invocationCallOrder[0]).toBeLessThan(
      restoreProcesses.mock.invocationCallOrder[0],
    );
  });

  it("starts the container, then waits for readiness, then recovers, then probes the gateway (#8978)", async () => {
    const restoreAccess = vi.fn();
    const waitForSandboxReady = vi.fn();
    const restoreProcesses = vi.fn(() => SUCCESSFUL_RECOVERY);
    const h = harness({
      restoreStartupState: (name: string) =>
        restoreStoppedSandboxStartupState(name, {
          agent: "openclaw",
          restoreLockedStartupAccess: restoreAccess,
          waitForSandboxReady,
          restoreProcessState: restoreProcesses,
        }),
    });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    const order = [
      h.recoverDockerDriverSandbox.mock.invocationCallOrder[0],
      restoreAccess.mock.invocationCallOrder[0],
      waitForSandboxReady.mock.invocationCallOrder[0],
      restoreProcesses.mock.invocationCallOrder[0],
      h.verifyGateway.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  it(
    "uses the default recovery path through Error, Provisioning, and Ready (#9753)",
    testTimeoutOptions(30_000),
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-start-readiness-"));
      vi.stubEnv("HOME", home);
      const listOutputs = ["my-sandbox Error", "my-sandbox Provisioning", "my-sandbox Ready"];
      const listSandboxes = vi.fn<OpenShellSandboxObserver["listSandboxes"]>(async () => {
        const output = listOutputs.shift() ?? "my-sandbox Ready";
        const phase = output.split(/\s+/u)[1] ?? null;
        return {
          ok: true,
          value: {
            sandboxes: [
              {
                name: "my-sandbox",
                phase,
                readiness:
                  phase === "Ready" ? "ready" : phase === "Error" ? "terminal" : "not_ready",
              },
            ],
          },
        };
      });
      const observer: OpenShellSandboxObserver = {
        listSandboxes,
      };
      const restoreProcesses = vi.fn(() => SUCCESSFUL_RECOVERY);
      const h = harness({
        allowDockerRuntimeInspection: false,
        observer,
        environment: { ...process.env, HOME: home },
        restoreLockedStartupAccess: vi.fn(),
        restoreProcessState: restoreProcesses,
      });
      delete h.deps.restoreStartupState;

      try {
        const result = await startSandbox("my-sandbox", h.deps);

        expect(result.exitCode).toBe(0);
        expect(listSandboxes).toHaveBeenCalledTimes(3);
        expect(restoreProcesses).toHaveBeenCalledWith("my-sandbox");
        expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox");
        expect(listSandboxes.mock.invocationCallOrder[2]).toBeLessThan(
          restoreProcesses.mock.invocationCallOrder[0],
        );
        expect(restoreProcesses.mock.invocationCallOrder[0]).toBeLessThan(
          h.verifyGateway.mock.invocationCallOrder[0],
        );
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("restores startup state before the final gateway and host-forward probe (#8112)", async () => {
    const h = harness();

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.recoverDockerDriverSandbox).toHaveBeenCalledWith("my-sandbox", {
      readiness: "runtime-running",
    });
    expect(h.restoreStartupState).toHaveBeenCalledWith("my-sandbox");
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox");
    expect(h.recoverDockerDriverSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      h.restoreStartupState.mock.invocationCallOrder[0],
    );
    expect(h.restoreStartupState.mock.invocationCallOrder[0]).toBeLessThan(
      h.verifyGateway.mock.invocationCallOrder[0],
    );
  });

  it(
    "retries startup after a structured recovery failure (#8662)",
    testTimeoutOptions(30_000),
    async () => {
      const h = harness();
      h.restoreStartupState.mockReturnValueOnce(FAILED_RECOVERY);

      await expect(startSandbox("my-sandbox", h.deps)).rejects.toThrow("gateway did not recover");
      expect(h.verifyGateway).not.toHaveBeenCalled();

      const result = await startSandbox("my-sandbox", h.deps);

      expect(result.exitCode).toBe(0);
      expect(h.restoreStartupState).toHaveBeenCalledTimes(2);
      expect(h.verifyGateway).toHaveBeenCalledOnce();
      expect(h.restoreStartupState.mock.invocationCallOrder[1]).toBeLessThan(
        h.verifyGateway.mock.invocationCallOrder[0],
      );
    },
  );

  it("waits for a transient managed supervisor before repeating full startup recovery (#8726)", async () => {
    const h = harness();
    h.restoreStartupState
      .mockReturnValueOnce({
        ...FAILED_RECOVERY,
        recoveryFailureLayer: "supervisor not running",
        recoveryFailureDetail: "SUPERVISOR_NOT_RUNNING",
      })
      .mockReturnValueOnce(SUCCESSFUL_RECOVERY);
    h.waitForManagedGatewaySupervisor.mockReturnValue(true);

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.restoreStartupState).toHaveBeenCalledTimes(2);
    expect(h.waitForManagedGatewaySupervisor).toHaveBeenCalledOnce();
    expect(h.waitForManagedGatewaySupervisor).toHaveBeenCalledWith("my-sandbox");
    expect(h.verifyGateway).toHaveBeenCalledOnce();
    expect(h.restoreStartupState.mock.invocationCallOrder[0]).toBeLessThan(
      h.waitForManagedGatewaySupervisor.mock.invocationCallOrder[0],
    );
    expect(h.waitForManagedGatewaySupervisor.mock.invocationCallOrder[0]).toBeLessThan(
      h.restoreStartupState.mock.invocationCallOrder[1],
    );
    expect(h.restoreStartupState.mock.invocationCallOrder[1]).toBeLessThan(
      h.verifyGateway.mock.invocationCallOrder[0],
    );
  });

  it("preserves the first recovery failure when the managed supervisor remains absent (#8726)", async () => {
    const h = harness();
    h.restoreStartupState.mockReturnValue({
      ...FAILED_RECOVERY,
      recoveryFailureLayer: "supervisor not running",
      recoveryFailureDetail: "SUPERVISOR_NOT_RUNNING",
    });

    await expect(startSandbox("my-sandbox", h.deps)).rejects.toThrow(
      "supervisor not running: SUPERVISOR_NOT_RUNNING",
    );
    expect(h.restoreStartupState).toHaveBeenCalledOnce();
    expect(h.waitForManagedGatewaySupervisor).toHaveBeenCalledOnce();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("preserves the first recovery failure when the managed supervisor wait throws (#8726)", async () => {
    const h = harness();
    h.restoreStartupState.mockReturnValue({
      ...FAILED_RECOVERY,
      recoveryFailureLayer: "supervisor not running",
      recoveryFailureDetail: "SUPERVISOR_NOT_RUNNING",
    });
    h.waitForManagedGatewaySupervisor.mockImplementation(() => {
      throw new Error("managed supervisor probe failed");
    });

    await expect(startSandbox("my-sandbox", h.deps)).rejects.toThrow(
      "supervisor not running: SUPERVISOR_NOT_RUNNING",
    );
    expect(h.restoreStartupState).toHaveBeenCalledOnce();
    expect(h.waitForManagedGatewaySupervisor).toHaveBeenCalledOnce();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("fails closed when recovery still fails after the managed supervisor appears (#8726)", async () => {
    const h = harness();
    const missingSupervisor = {
      ...FAILED_RECOVERY,
      recoveryFailureLayer: "supervisor not running" as const,
      recoveryFailureDetail: "SUPERVISOR_NOT_RUNNING",
    };
    h.restoreStartupState.mockReturnValue(missingSupervisor);
    h.waitForManagedGatewaySupervisor.mockReturnValue(true);

    await expect(startSandbox("my-sandbox", h.deps)).rejects.toThrow(
      "supervisor not running: SUPERVISOR_NOT_RUNNING",
    );
    expect(h.restoreStartupState).toHaveBeenCalledTimes(2);
    expect(h.waitForManagedGatewaySupervisor).toHaveBeenCalledOnce();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it.each([
    ["definitive supervisor failure", "supervisor unavailable", "SUPERVISOR_UNAVAILABLE"],
    [
      "unclassified missing-supervisor output",
      "supervisor not running",
      "prefix SUPERVISOR_NOT_RUNNING suffix",
    ],
    ["restart that exits with status 137", "launch failure", "restart exited 137"],
    [
      "restart that exits with status 137 and diagnostic output",
      "launch failure",
      "restart exited 137 with diagnostic output",
    ],
  ] as const)("does not wait after a %s (#8726)", async (_label, layer, detail) => {
    const h = harness();
    h.restoreStartupState.mockReturnValue({
      ...FAILED_RECOVERY,
      recoveryFailureLayer: layer,
      recoveryFailureDetail: detail,
    });

    await expect(startSandbox("my-sandbox", h.deps)).rejects.toThrow(detail);
    expect(h.restoreStartupState).toHaveBeenCalledOnce();
    expect(h.waitForManagedGatewaySupervisor).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("keeps successful legacy supervisor relaunch recovery free of a settling wait (#8726)", async () => {
    const h = harness();
    h.restoreStartupState.mockReturnValue({
      ...SUCCESSFUL_RECOVERY,
      wasRunning: false,
      recovered: true,
    });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.restoreStartupState).toHaveBeenCalledOnce();
    expect(h.waitForManagedGatewaySupervisor).not.toHaveBeenCalled();
    expect(h.verifyGateway).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "openclaw",
      "managed gateway recovery",
      {
        ...FAILED_RECOVERY,
        recoveryFailureLayer: "supervisor unavailable",
        recoveryFailureDetail: `SUPERVISOR_UNAVAILABLE Authorization: Bearer ${REDACTED_TOKEN}`,
      },
      /supervisor unavailable/iu,
    ],
    [
      "hermes",
      "OpenShell readiness",
      {
        ...FAILED_RECOVERY,
        forwardRecoveryFailed: true,
        forwardRecoveryFailureDetail: `the sandbox did not become ready in OpenShell: token=${REDACTED_TOKEN}`,
      },
      /did not become ready in OpenShell/iu,
    ],
  ] as const)(
    "propagates an actionable %s %s failure (#8662)",
    async (agent, _layer, recovery, expected) => {
      const h = harness();
      h.getSandbox.mockReturnValue(sandbox({ agent }));
      h.restoreStartupState.mockReturnValue(recovery);

      const failure = await startSandbox("my-sandbox", h.deps).catch((error) => String(error));
      expect(failure).toMatch(expected);
      expect(failure).toMatch(/nemoclaw my-sandbox recover/iu);
      expect(failure).not.toContain(REDACTED_TOKEN);
      expect(h.verifyGateway).not.toHaveBeenCalled();
    },
  );

  it("does not claim preservation when startup recovery reports a failed rollback (#9364)", async () => {
    const h = harness();
    h.restoreStartupState.mockReturnValue({
      ...FAILED_RECOVERY,
      recoveryFailureDetail:
        "NemoClaw could not confirm rollback to the previous sandbox container. Inspect Docker state before retrying. Recovery failure before rollback: the sandbox did not become ready in OpenShell",
    });

    const failure = await startSandbox("my-sandbox", h.deps).catch((error) => String(error));

    expect(failure).toContain("could not confirm rollback");
    expect(failure).toContain("Inspect the current sandbox state before retrying");
    expect(failure).not.toContain("The existing sandbox was preserved");
    expect(h.verifyGateway).not.toHaveBeenCalled();
  });

  it("reports the started container by name (#6026)", async () => {
    const h = harness();

    await startSandbox("my-sandbox", h.deps);

    const output = h.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("openshell-my-sandbox");
  });

  it("uses recorded Podman authority instead of ambient Docker for a portable receipt (#9070)", async () => {
    const h = harness();
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "openclaw",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-alpha",
        openshellDriver: "docker",
      }),
    );
    h.hasPortableLifecycleReceipt.mockReturnValue(true);
    h.recoverPortableSandbox.mockReturnValue({ kind: "recovered" });

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(h.isDockerRuntimeDown).not.toHaveBeenCalled();
    expect(h.recoverPortableSandbox).toHaveBeenCalledWith(
      "my-sandbox",
      expect.objectContaining({ lifecycleGeneration: "generation-alpha" }),
      expect.objectContaining({ env: process.env }),
    );
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
  });

  it("keeps active Hermes start out of every Docker path (#9203)", async () => {
    const probeInferenceInvocation = vi.fn(() => ({ ok: true }) as const);
    const h = harness({ probeInferenceInvocation });
    h.getSandbox.mockReturnValue(
      sandbox({
        agent: "hermes",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-alpha",
        lifecycleLiveIdentityFingerprint: "identity-alpha",
        openshellDriver: "docker",
      }),
    );
    h.hasPortableLifecycleReceipt.mockReturnValue(true);
    h.recoverPortableSandbox.mockReturnValue({ kind: "recovered" });

    await expect(startSandbox("my-sandbox", h.deps)).resolves.toEqual({ exitCode: 0 });

    expect(h.isDockerRuntimeDown).not.toHaveBeenCalled();
    expect(h.findLabeledSandboxContainers).not.toHaveBeenCalled();
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
    expect(h.dockerUnpause).not.toHaveBeenCalled();
    expect(h.restoreStartupState).not.toHaveBeenCalled();
    expect(h.verifyGateway).not.toHaveBeenCalled();
    expect(probeInferenceInvocation).not.toHaveBeenCalled();
  });

  it("still probes when the container was already running (#6026)", async () => {
    const h = harness();
    h.findLabeledSandboxContainers.mockReturnValue([
      { name: "openshell-my-sandbox", status: "Up 5 minutes", running: true },
    ]);
    h.recoverDockerDriverSandbox.mockReturnValue({
      recovered: true,
      via: "started-running-original",
      containerName: "openshell-my-sandbox",
    });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.restoreStartupState).toHaveBeenCalledWith("my-sandbox");
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox");
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
        name: "openshell-my-sandbox",
        status: "Up 3 minutes (Paused)",
        running: true,
      },
    ]);

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.dockerUnpause).toHaveBeenCalledWith("openshell-my-sandbox", {
      ignoreError: true,
      timeout: 30_000,
    });
    expect(h.recoverDockerDriverSandbox).not.toHaveBeenCalled();
    expect(h.restoreStartupState).toHaveBeenCalledWith("my-sandbox");
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox");
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
      containerName: "openshell-my-sandbox",
    });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(h.verifyGateway).toHaveBeenCalledWith("my-sandbox");
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

  it.each(["unknown-runtime", "mxc-not-installed"])(
    "fails closed for unregistered provider %s without lifecycle side effects",
    async (providerId) => {
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
    },
  );

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

  it("reports the recorded route as ready only after it serves an agent request", async () => {
    const probeInferenceInvocation = vi.fn(() => ({ ok: true }) as const);
    const h = harness({ probeInferenceInvocation });
    h.getSandbox.mockReturnValue(
      sandbox({
        provider: "ollama-local",
        model: "nemotron-3-nano:30b",
        preferredInferenceApi: "openai-completions",
      }),
    );

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(probeInferenceInvocation).toHaveBeenCalledWith(
      {
        sandboxName: "my-sandbox",
        provider: "ollama-local",
        model: "nemotron-3-nano:30b",
        preferredInferenceApi: "openai-completions",
      },
      {},
      30_000,
    );
    expect(probeInferenceInvocation.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.verifyGateway.mock.invocationCallOrder[0],
    );
  });

  it("exits nonzero when the started gateway will not serve an agent request", async () => {
    const probeInferenceInvocation = vi.fn(
      () =>
        ({
          ok: false,
          detail: "sandbox inference invocation probe returned HTTP 401",
          httpStatus: 401,
        }) as const,
    );
    const h = harness({ probeInferenceInvocation });
    h.getSandbox.mockReturnValue(
      sandbox({ provider: "ollama-local", model: "nemotron-3-nano:30b" }),
    );

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(1);
    const output = h.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("HTTP 401");
    expect(output).toContain("doctor");
  });

  it("stays unattested instead of failing when the sandbox records no route", async () => {
    const probeInferenceInvocation = vi.fn(() => ({ ok: true }) as const);
    const h = harness({ probeInferenceInvocation });

    const result = await startSandbox("my-sandbox", h.deps);

    expect(result.exitCode).toBe(0);
    expect(probeInferenceInvocation).not.toHaveBeenCalled();
  });
});
