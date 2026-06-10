// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { Session } from "../../state/onboard-session";

type RebuildSandbox =
  typeof import("../../../../dist/lib/actions/sandbox/rebuild")["rebuildSandbox"];

const requireDist = createRequire(import.meta.url);
const rebuildModulePath = "../../../../dist/lib/actions/sandbox/rebuild.js";

function cloneSession(session: Session): Session {
  return JSON.parse(JSON.stringify(session));
}

describe("rebuild resume snapshot repair", () => {
  let rebuildSandbox: RebuildSandbox;
  let spies: MockInstance[];
  let errorSpy: MockInstance;
  let logSpy: MockInstance;
  let session: Session;
  const originalSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;
  const observed = {
    handoffOptions: null as Record<string, unknown> | null,
    preRepairMachineState: null as string | null,
    preRepairStatus: null as string | null,
    preRepairResumable: null as boolean | null,
    repairedMachineState: null as string | null,
  };

  beforeEach(() => {
    spies = [];
    observed.handoffOptions = null;
    observed.preRepairMachineState = null;
    observed.preRepairStatus = null;
    observed.preRepairResumable = null;
    observed.repairedMachineState = null;
    delete require.cache[requireDist.resolve(rebuildModulePath)];

    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const gatewayDrift = requireDist("../../../../dist/lib/adapters/openshell/gateway-drift.js");
    const openshellRuntime = requireDist("../../../../dist/lib/adapters/openshell/runtime.js");
    const sandboxList = requireDist("../../../../dist/lib/openshell-sandbox-list.js");
    const resolve = requireDist("../../../../dist/lib/adapters/openshell/resolve.js");
    const agentDefs = requireDist("../../../../dist/lib/agent/defs.js");
    const agentRuntime = requireDist("../../../../dist/lib/agent/runtime.js");
    const onboardMod = requireDist("../../../../dist/lib/onboard.js");
    const resumeRepair = requireDist("../../../../dist/lib/onboard/resume-machine-repair.js");
    const onboardSession = requireDist("../../../../dist/lib/state/onboard-session.js");
    const registry = requireDist("../../../../dist/lib/state/registry.js");
    const sandboxSession = requireDist("../../../../dist/lib/state/sandbox-session.js");
    const sandboxState = requireDist("../../../../dist/lib/state/sandbox.js");
    const sandboxVersion = requireDist("../../../../dist/lib/sandbox/version.js");
    const destroy = requireDist("../../../../dist/lib/actions/sandbox/destroy.js");
    const rebuildShields = requireDist("../../../../dist/lib/actions/sandbox/rebuild-shields.js");
    const nim = requireDist("../../../../dist/lib/inference/nim.js");

    session = onboardSession.createSession({
      sandboxName: "alpha",
      provider: "ollama-local",
      model: "nvidia/nemotron",
      lastCompletedStep: "gateway",
      status: "complete",
      resumable: false,
      machine: {
        version: onboardSession.MACHINE_SNAPSHOT_VERSION,
        state: "complete",
        stateEnteredAt: "2026-06-01T00:00:00.000Z",
        revision: 12,
      },
    });
    session.steps.preflight.status = "complete";
    session.steps.gateway.status = "complete";

    const loadSession = () => cloneSession(session);
    const updateSession = (mutator: unknown): Session => {
      if (typeof mutator !== "function") {
        throw new TypeError("updateSession expected a mutator function");
      }
      const current = cloneSession(session);
      session = cloneSession((mutator as (value: Session) => Session | void)(current) ?? current);
      return loadSession();
    };

    spies.push(
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null),
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null),
      vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery").mockResolvedValue({
        result: { status: 0, output: "alpha Ready" },
      }),
      vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null),
      vi.spyOn(agentDefs, "loadAgent").mockReturnValue({ messagingPlatforms: [] } as never),
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null),
      vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw"),
      vi.spyOn(onboardSession, "loadSession").mockImplementation(loadSession),
      vi.spyOn(onboardSession, "updateSession").mockImplementation(updateSession),
      vi.spyOn(onboardSession, "releaseOnboardLock").mockImplementation(() => undefined),
      vi.spyOn(onboardSession, "markStepFailed").mockImplementation(() => loadSession()),
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "alpha",
        provider: "ollama-local",
        model: "nvidia/nemotron",
        policies: [],
        agent: null,
        nimContainer: null,
      } as never),
      vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [] } as never),
      vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
        detected: false,
        sessions: [],
      }),
      vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({
        expectedVersion: "0.1.0",
        sandboxVersion: "0.0.1",
      } as never),
      vi.spyOn(rebuildShields, "openRebuildShieldsWindow").mockReturnValue({
        relocked: false,
        wasLocked: false,
      }),
      vi.spyOn(rebuildShields, "relockRebuildShieldsWindow").mockReturnValue(true),
      vi.spyOn(sandboxState, "backupSandboxState").mockReturnValue({
        success: true,
        backedUpDirs: [],
        backedUpFiles: [],
        failedDirs: [],
        failedFiles: [],
        manifest: {
          backupPath: "/tmp/nemoclaw-rebuild-backup",
          timestamp: "2026-06-01T00:00:00.000Z",
          policyPresets: [],
        },
      } as never),
      vi.spyOn(openshellRuntime, "runOpenshell").mockReturnValue({ status: 0, output: "" }),
      vi.spyOn(destroy, "removeSandboxRegistryEntry").mockImplementation(() => undefined),
      vi.spyOn(nim, "stopNimContainer").mockImplementation(() => undefined),
      vi.spyOn(nim, "stopNimContainerByName").mockImplementation(() => undefined),
      vi.spyOn(onboardMod, "onboard").mockImplementation(async (options: unknown) => {
        observed.handoffOptions = options as Record<string, unknown>;
        const reopened = onboardSession.loadSession();
        observed.preRepairMachineState = reopened.machine.state;
        observed.preRepairStatus = reopened.status;
        observed.preRepairResumable = reopened.resumable;
        resumeRepair.repairResumeMachineSnapshot(reopened, "2026-06-01T00:01:00.000Z");
        observed.repairedMachineState = reopened.machine.state;
        throw new Error("stop-after-resume-repair-probe");
      }),
    );

    ({ rebuildSandbox } = requireDist(rebuildModulePath));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    if (originalSandboxName === undefined) {
      delete process.env.NEMOCLAW_SANDBOX_NAME;
    } else {
      process.env.NEMOCLAW_SANDBOX_NAME = originalSandboxName;
    }
    delete require.cache[requireDist.resolve(rebuildModulePath)];
  });

  it("reopens complete sessions so onboard resume repair can restore the resumable state", async () => {
    await expect(rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).rejects.toThrow(
      "Recreate failed",
    );

    expect(observed.handoffOptions).toMatchObject({
      resume: true,
      nonInteractive: true,
      recreateSandbox: true,
      autoYes: true,
    });
    expect(observed.preRepairMachineState).toBe("complete");
    expect(observed.preRepairStatus).toBe("in_progress");
    expect(observed.preRepairResumable).toBe(true);
    expect(observed.repairedMachineState).toBe("provider_selection");
    expect(process.env.NEMOCLAW_SANDBOX_NAME).toBe("alpha");
  });
});
