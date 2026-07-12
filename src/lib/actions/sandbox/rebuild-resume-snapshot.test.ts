// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as gatewayDrift from "../../adapters/openshell/gateway-drift";
import * as resolve from "../../adapters/openshell/resolve";
import * as openshellRuntime from "../../adapters/openshell/runtime";
import * as agentDefs from "../../agent/defs";
import * as agentRuntime from "../../agent/runtime";
import * as gatewayRuntime from "../../gateway-runtime-action";
import * as nim from "../../inference/nim";
import * as sessionRecovery from "../../onboard/session-recovery";
import * as sandboxList from "../../openshell-sandbox-list";
import * as sandboxVersion from "../../sandbox/version";
import type { Session } from "../../state/onboard-session";
import * as onboardSession from "../../state/onboard-session";
import * as registry from "../../state/registry";
import * as sandboxState from "../../state/sandbox";
import * as sandboxSession from "../../state/sandbox-session";
import * as destroy from "./destroy";
import { rebuildSandbox } from "./rebuild";
import * as rebuildImagePreflight from "./rebuild-custom-image-preflight";
import { rebuildOnboardDependencies } from "./rebuild-onboard-dependencies";
import * as rebuildShields from "./rebuild-shields";
import * as rebuildUsageNotice from "./rebuild-usage-notice";

function cloneSession(session: Session): Session {
  return JSON.parse(JSON.stringify(session));
}

describe("rebuild resume snapshot repair", () => {
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

    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

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
        before: { state: "healthy_named", status: "", gatewayInfo: "", activeGateway: null },
        after: { state: "healthy_named", status: "", gatewayInfo: "", activeGateway: null },
        attempted: false,
      }),
      vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery").mockResolvedValue({
        result: { status: 0, output: "alpha Ready" },
        recoveryAttempted: false,
        recoverySucceeded: false,
      }),
      vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null),
      vi.spyOn(agentDefs, "loadAgent").mockReturnValue({
        name: "langchain-deepagents-code",
      } as never),
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null),
      vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw"),
      vi.spyOn(onboardSession, "loadSession").mockImplementation(loadSession),
      vi.spyOn(onboardSession, "updateSession").mockImplementation(updateSession),
      vi.spyOn(onboardSession, "acquireOnboardLock").mockReturnValue({
        acquired: true,
        lockFile: "/tmp/nemoclaw-onboard.lock",
        stale: false,
      }),
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
      vi
        .spyOn(openshellRuntime, "runOpenshell")
        .mockReturnValue({ status: 0, output: "" } as never),
      vi.spyOn(destroy, "removeSandboxRegistryEntry").mockReturnValue(true),
      vi.spyOn(nim, "stopNimContainer").mockImplementation(() => undefined),
      vi.spyOn(nim, "stopNimContainerByName").mockImplementation(() => undefined),
      vi.spyOn(nim, "detectGpu").mockReturnValue(null),
      vi
        .spyOn(rebuildOnboardDependencies, "preflightAuthoritativeRebuildTarget")
        .mockResolvedValue(undefined),
      vi.spyOn(rebuildImagePreflight, "preflightRebuildImage").mockResolvedValue({
        ok: true,
        imageTag: null,
      } as never),
      vi.spyOn(rebuildUsageNotice, "ensureRebuildUsageNoticeAccepted").mockResolvedValue(true),
      vi
        .spyOn(rebuildOnboardDependencies, "onboard")
        .mockImplementation(async (options: unknown) => {
          observed.handoffOptions = options as Record<string, unknown>;
          const reopened = onboardSession.loadSession() as Session;
          observed.preRepairMachineState = reopened.machine.state;
          observed.preRepairPreflightStatus = reopened.steps.preflight.status;
          observed.preRepairGatewayStatus = reopened.steps.gateway.status;
          observed.preRepairStatus = reopened.status;
          observed.preRepairResumable = reopened.resumable;
          sessionRecovery.applySessionRecovery(reopened, "2026-06-01T00:01:00.000Z");
          observed.repairedMachineState = reopened.machine.state;
          observed.sandboxEnvInsideOnboard = process.env.NEMOCLAW_SANDBOX_NAME ?? null;
          throw new Error("stop-after-resume-repair-probe");
        }),
    );
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
  });

  it("replaces complete history with a target-scoped resume snapshot (#6245)", async () => {
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
