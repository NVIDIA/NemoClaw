// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPortableOnboardEnvironmentScope } from "../session-bootstrap";

const mocks = vi.hoisted(() => ({
  createFinalFlowPhases: vi.fn(),
}));

vi.mock("./final-flow-phases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./final-flow-phases")>()),
  createFinalOnboardFlowPhases: mocks.createFinalFlowPhases,
}));

import { createFinalOnboardFlowPhases, finalizationHandlerDeps } from "./final-flow-composition";

describe("createFinalOnboardFlowPhases", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    mocks.createFinalFlowPhases.mockReturnValue([{ state: "agent_setup" }]);
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
      agentSetupDeps: {},
      policiesDeps: {},
      finalization: {},
      finalizationDeps: {
        existingDependency,
        ...finalizationHandlerDeps,
      },
    });
    expect(phases).toEqual([{ state: "agent_setup" }]);
  });

  it("hands finalization only the selectors admitted by the active onboarding scope", async () => {
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
    const check = vi
      .spyOn(finalizationHandlerDeps, "checkAndRecoverSandboxProcesses")
      .mockResolvedValue(true);
    createFinalOnboardFlowPhases({
      branchState: "agent_setup",
      agentSetupDeps: {},
      policiesDeps: {},
      finalization: {},
      finalizationDeps: {},
      portableRuntimeContext: { authority, environmentScope },
    } as never);
    const finalization = mocks.createFinalFlowPhases.mock.calls[0]![0].finalizationDeps;
    await expect(
      finalization.checkAndRecoverSandboxProcesses("fresh-hermes", { quiet: true }),
    ).resolves.toBe(true);
    expect(check).toHaveBeenLastCalledWith(
      "fresh-hermes",
      { quiet: true },
      expect.objectContaining({ HOME: authority.homeDir }),
    );
    const clean = check.mock.calls[0]![2]!;
    expect(clean).not.toHaveProperty("DOCKER_HOST");
    expect(clean).not.toHaveProperty("CONTAINERS_CONF");
    expect(env.DOCKER_HOST).toBe(`unix://${authority.socketPath}`);

    env.DOCKER_HOST = "tcp://unexpected.invalid:2375";
    await finalization.checkAndRecoverSandboxProcesses("fresh-hermes", { quiet: true });
    expect(check.mock.calls[1]![2]).toHaveProperty("DOCKER_HOST", "tcp://unexpected.invalid:2375");
  });
});
