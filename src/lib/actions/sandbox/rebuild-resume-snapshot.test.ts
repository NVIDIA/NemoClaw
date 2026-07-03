// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { Session } from "../../state/onboard-session";

type RebuildSandbox = typeof import("./rebuild")["rebuildSandbox"];

const requireDist = createRequire(import.meta.url);
const rebuildModulePath = "./rebuild.js";

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
    preRepairPreflightStatus: null as string | null,
    preRepairGatewayStatus: null as string | null,
    preRepairStatus: null as string | null,
    preRepairResumable: null as boolean | null,
    repairedMachineState: null as string | null,
    sandboxEnvInsideOnboard: null as string | null,
  };

  beforeEach(() => {
    spies = [];
    observed.handoffOptions = null;
    observed.preRepairMachineState = null;
    observed.preRepairPreflightStatus = null;
    observed.preRepairGatewayStatus = null;
    observed.preRepairStatus = null;
    observed.preRepairResumable = null;
    observed.repairedMachineState = null;
    observed.sandboxEnvInsideOnboard = null;
    delete require.cache[requireDist.resolve(rebuildModulePath)];

    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const gatewayDrift = requireDist("../../adapters/openshell/gateway-drift.js");
    const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
    const openshellRuntime = requireDist("../../adapters/openshell/runtime.js");
    const sandboxList = requireDist("../../openshell-sandbox-list.js");
    const resolve = requireDist("../../adapters/openshell/resolve.js");
    const agentDefs = requireDist("../../agent/defs.js");
    const agentRuntime = requireDist("../../agent/runtime.js");
    const onboardMod = requireDist("../../onboard.js");
    const resumeRepair = requireDist("../../onboard/resume-machine-repair.js");
    const onboardSession = requireDist("../../state/onboard-session.js");
    const registry = requireDist("../../state/registry.js");
    const sandboxSession = requireDist("../../state/sandbox-session.js");
    const sandboxState = requireDist("../../state/sandbox.js");
    const sandboxVersion = requireDist("../../sandbox/version.js");
    const destroy = requireDist("./destroy.js");
    const rebuildShields = requireDist("./rebuild-shields.js");
    const rebuildImagePreflight = requireDist("./rebuild-custom-image-preflight.js");
    const rebuildUsageNotice = requireDist("./rebuild-usage-notice.js");
    const nim = requireDist("../../inference/nim.js");

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
      vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
        recovered: true,
        before: { state: "healthy_named" },
        after: { state: "healthy_named" },
      }),
      vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery").mockResolvedValue({
        result: { status: 0, output: "alpha Ready" },
      }),
      vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null),
      vi.spyOn(agentDefs, "loadAgent").mockReturnValue({
        name: "langchain-deepagents-code",
      } as never),
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null),
      vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw"),
      vi.spyOn(onboardSession, "loadSession").mockImplementation(loadSession),
      vi.spyOn(onboardSession, "updateSession").mockImplementation(updateSession),
      vi.spyOn(onboardSession, "acquireOnboardLock").mockReturnValue({ acquired: true }),
      vi.spyOn(onboardSession, "releaseOnboardLock").mockImplementation(() => undefined),
      vi.spyOn(onboardSession, "markStepFailed").mockImplementation(() => loadSession()),
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "alpha",
        provider: "ollama-local",
        model: "nvidia/nemotron",
        policies: [],
        agent: null,
        nimContainer: null,
        nemoclawVersion: "0.1.0",
        dashboardPort: 18789,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      } as never),
      vi.spyOn(registry, "updateSandbox").mockReturnValue(true),
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
      vi.spyOn(nim, "detectGpu").mockReturnValue(null),
      vi.spyOn(onboardMod, "preflightAuthoritativeRebuildTarget").mockResolvedValue(undefined),
      vi.spyOn(rebuildImagePreflight, "preflightRebuildImage").mockResolvedValue({
        ok: true,
        imageTag: null,
      }),
      vi.spyOn(rebuildUsageNotice, "ensureRebuildUsageNoticeAccepted").mockResolvedValue(true),
      vi.spyOn(onboardMod, "onboard").mockImplementation(async (options: unknown) => {
        observed.handoffOptions = options as Record<string, unknown>;
        const reopened = onboardSession.loadSession();
        observed.preRepairMachineState = reopened.machine.state;
        observed.preRepairPreflightStatus = reopened.steps.preflight.status;
        observed.preRepairGatewayStatus = reopened.steps.gateway.status;
        observed.preRepairStatus = reopened.status;
        observed.preRepairResumable = reopened.resumable;
        resumeRepair.repairResumeMachineSnapshot(reopened, "2026-06-01T00:01:00.000Z");
        observed.repairedMachineState = reopened.machine.state;
        observed.sandboxEnvInsideOnboard = process.env.NEMOCLAW_SANDBOX_NAME ?? null;
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

  it("replaces complete history with a target-scoped resume snapshot", async () => {
    await expect(rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).rejects.toThrow(
      "Recreate failed",
    );

    expect(observed.handoffOptions).toMatchObject({
      resume: true,
      nonInteractive: true,
      recreateSandbox: true,
      authoritativeResumeConfig: true,
      acceptThirdPartySoftware: true,
      controlUiPort: 18789,
      targetGatewayName: "nemoclaw",
      targetGatewayPort: 8080,
      onboardLockAlreadyHeld: true,
      autoYes: true,
    });
    expect(observed.preRepairMachineState).toBe("init");
    expect(observed.preRepairPreflightStatus).toBe("complete");
    expect(observed.preRepairGatewayStatus).toBe("complete");
    expect(observed.preRepairStatus).toBe("in_progress");
    expect(observed.preRepairResumable).toBe(true);
    expect(observed.repairedMachineState).toBe("init");
    expect(observed.sandboxEnvInsideOnboard).toBe("alpha");
    expect(process.env.NEMOCLAW_SANDBOX_NAME).toBe(originalSandboxName);
  }, 15_000);
});
