// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { context } from "../../../../test/helpers/onboard-final-flow-phases";
import { createPortableOnboardEnvironmentScope } from "../session-bootstrap";

const mocks = vi.hoisted(() => ({
  createFinalFlowPhases: vi.fn(),
  actualCreateFinalFlowPhases: null as
    | null
    | typeof import("./final-flow-phases").createFinalOnboardFlowPhases,
}));

vi.mock("./final-flow-phases", async (importOriginal) => {
  const original = await importOriginal<typeof import("./final-flow-phases")>();
  mocks.actualCreateFinalFlowPhases = original.createFinalOnboardFlowPhases;
  return {
    ...original,
    createFinalOnboardFlowPhases: mocks.createFinalFlowPhases,
  };
});

import { createFinalOnboardFlowPhases, finalizationHandlerDeps } from "./final-flow-composition";

describe("createFinalOnboardFlowPhases", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    mocks.createFinalFlowPhases.mockReset().mockReturnValue([{ state: "agent_setup" }]);
  });

  it("adds recovery and readiness dependencies when it creates the final phases (#7695)", () => {
    const existingDependency = vi.fn();
    const options = {
      branchState: "agent_setup",
      agentSetupDeps: {},
      policiesDeps: {},
      finalization: {},
      finalizationDeps: { existingDependency },
    } as never;

    const phases = createFinalOnboardFlowPhases(options);

    expect(mocks.createFinalFlowPhases).toHaveBeenCalledWith({
      branchState: "agent_setup",
      agentSetupDeps: {
        waitForSandboxControlPlaneReady: finalizationHandlerDeps.waitForSandboxControlPlaneReady,
      },
      policiesDeps: {},
      finalization: {},
      finalizationDeps: {
        existingDependency,
        ...finalizationHandlerDeps,
      },
    });
    expect(phases).toEqual([{ state: "agent_setup" }]);
  });

  it("runs receipt-qualified Hermes readiness through the real portable finalization phase (#11892)", async () => {
    const authority = {
      schemaVersion: 1 as const,
      kind: "podman" as const,
      ownership: "current-user" as const,
      uid: 1001,
      homeDir: "/home/kiosk",
      configHome: "/home/kiosk/.config",
      runtimeDir: "/run/user/1001",
      socketPath: "/run/user/1001/podman/podman.sock",
    };
    const env: NodeJS.ProcessEnv = { HOME: authority.homeDir, PATH: "/usr/bin" };
    const environmentScope = createPortableOnboardEnvironmentScope(env, null);
    environmentScope.installRuntime({
      containersConf: "/home/kiosk/.config/nemoclaw/portable/containers.conf",
      socketPath: authority.socketPath,
    });
    const genericRecovery = vi.spyOn(finalizationHandlerDeps, "checkAndRecoverSandboxProcesses");
    const check = vi
      .spyOn(finalizationHandlerDeps, "checkHermesPortableSandboxReadiness")
      .mockResolvedValue(true);
    vi.spyOn(finalizationHandlerDeps, "reportDeploymentReadiness").mockImplementation(() => {});
    const error = vi.fn();
    createFinalOnboardFlowPhases({
      branchState: "agent_setup",
      agentSetupDeps: {},
      policiesDeps: {},
      finalization: {
        stagedLegacyKeys: [],
        migratedLegacyKeys: new Set(),
        webSearchEnabled: () => false,
        webSearchProvider: () => "brave",
      },
      finalizationDeps: {
        setDefaultSandbox: vi.fn(),
        removeLegacyCredentialsFile: vi.fn(),
        cleanupStaleHostFiles: vi.fn(),
        error,
      },
      portableRuntimeContext: { authority, environmentScope },
    } as never);
    const composedOptions = mocks.createFinalFlowPhases.mock.calls[0]![0];
    const phases = mocks.actualCreateFinalFlowPhases!(composedOptions as never);
    const finalization = phases[2];
    const flowContext = context({
      agent: { name: "hermes" },
      sandboxName: "fresh-hermes",
    });

    await expect(finalization.run(flowContext)).resolves.toMatchObject({
      result: {
        type: "transition",
        next: "post_verify",
        metadata: { state: "finalizing" },
      },
    });
    expect(check).toHaveBeenLastCalledWith(
      "fresh-hermes",
      expect.objectContaining({ HOME: authority.homeDir }),
    );
    expect(genericRecovery).not.toHaveBeenCalled();
    const clean = check.mock.calls[0]![1]!;
    expect(clean).not.toHaveProperty("DOCKER_HOST");
    expect(clean).not.toHaveProperty("CONTAINERS_CONF");
    expect(env.DOCKER_HOST).toBe(`unix://${authority.socketPath}`);

    env.DOCKER_HOST = "tcp://unexpected.invalid:2375";
    check.mockResolvedValueOnce({
      ready: false,
      reason: "portable-hermes-native-gateway-unavailable",
    });
    await expect(finalization.run(flowContext)).resolves.toMatchObject({
      result: {
        type: "pause",
        metadata: { state: "finalizing", reason: "recovery_check_incomplete" },
      },
    });
    expect(check.mock.calls[1]![1]).toHaveProperty("DOCKER_HOST", "tcp://unexpected.invalid:2375");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("receipt-owned native gateway is not qualified and healthy"),
    );
  });

  it("keeps generic recovery for Portable OpenClaw finalization (#11892)", async () => {
    const authority = {
      schemaVersion: 1 as const,
      kind: "podman" as const,
      ownership: "current-user" as const,
      uid: 1001,
      homeDir: "/home/kiosk",
      configHome: "/home/kiosk/.config",
      runtimeDir: "/run/user/1001",
      socketPath: "/run/user/1001/podman/podman.sock",
    };
    const environmentScope = createPortableOnboardEnvironmentScope(
      { HOME: authority.homeDir },
      null,
    );
    const genericRecovery = vi
      .spyOn(finalizationHandlerDeps, "checkAndRecoverSandboxProcesses")
      .mockResolvedValue(true);
    const hermesReadiness = vi.spyOn(
      finalizationHandlerDeps,
      "checkHermesPortableSandboxReadiness",
    );
    vi.spyOn(finalizationHandlerDeps, "reportDeploymentReadiness").mockImplementation(() => {});
    createFinalOnboardFlowPhases({
      branchState: "openclaw",
      agentSetupDeps: {},
      policiesDeps: {},
      finalization: {
        stagedLegacyKeys: [],
        migratedLegacyKeys: new Set(),
        webSearchEnabled: () => false,
        webSearchProvider: () => "brave",
      },
      finalizationDeps: {
        setDefaultSandbox: vi.fn(),
        removeLegacyCredentialsFile: vi.fn(),
        cleanupStaleHostFiles: vi.fn(),
        error: vi.fn(),
      },
      portableRuntimeContext: { authority, environmentScope },
    } as never);
    const composedOptions = mocks.createFinalFlowPhases.mock.calls[0]![0];
    const phases = mocks.actualCreateFinalFlowPhases!(composedOptions as never);

    await expect(
      phases[2].run(context({ agent: null, sandboxName: "portable-openclaw" })),
    ).resolves.toMatchObject({
      result: { type: "transition", next: "post_verify" },
    });
    expect(genericRecovery).toHaveBeenCalledWith("portable-openclaw", { quiet: true });
    expect(hermesReadiness).not.toHaveBeenCalled();
  });
});
