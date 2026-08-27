// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../state/onboard-session";
import { type CoreOnboardFlowPhases, runCoreOnboardFlowSlice } from "./core-flow-phases";
import type { OnboardFlowContext } from "./flow-context";
import type { OnboardPrerequisiteRepairEventRecorder } from "./prerequisite-repair";
import { advanceTo, branchTo } from "./result";
import type { OnboardSequencePhase } from "./sequence-runner";

type Agent = { name: string };
type Gpu = { platform: string };
type SandboxGpuConfig = { mode: string };
type CoreContext = OnboardFlowContext<Agent, Gpu, SandboxGpuConfig>;

function context(patch: Partial<CoreContext> = {}): CoreContext {
  return {
    resume: false,
    fresh: false,
    session: createSession(),
    agent: { name: "openclaw" },
    recordedSandboxName: null,
    requestedSandboxName: null,
    sandboxName: "my-sandbox",
    fromDockerfile: null,
    model: null,
    provider: null,
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: false,
    selectedMessagingChannels: ["slack"],
    gpu: { platform: "linux" },
    sandboxGpuConfig: { mode: "cdi" },
    gpuPassthrough: true,
    ...patch,
  };
}

function repairRecorder(events: string[] = []): OnboardPrerequisiteRepairEventRecorder {
  return async (type, options) => {
    events.push(`${type}:${options.state ?? "unknown"}`);
  };
}

describe("core onboard prerequisite repair", () => {
  it.each(["openclaw", "agent_setup", "policies", "finalizing", "post_verify"] as const)(
    "repairs core prerequisites without changing resumed %s entry",
    async (state) => {
      const repairEvents: string[] = [];
      const branchState = state === "agent_setup" ? "agent_setup" : "openclaw";
      const session = createSession({
        machine: {
          version: 1,
          state,
          stateEnteredAt: "2026-06-09T00:02:00.000Z",
          revision: 7,
        },
      });
      const phases: CoreOnboardFlowPhases<CoreContext> = {
        providerInference: {
          state: "provider_selection",
          run: (ctx) => ({
            context: { ...ctx, endpointUrl: "https://example.test/v1" },
            result: [
              advanceTo("inference", { metadata: { state: "provider_selection" } }),
              advanceTo("sandbox", { metadata: { state: "inference" } }),
            ],
          }),
        },
        sandbox: {
          state: "sandbox",
          run: (ctx) => ({
            context: { ...ctx, sandboxName: "created-sandbox" },
            result: branchTo(branchState, { metadata: { state: "sandbox" } }),
          }),
        },
      };

      const result = await runCoreOnboardFlowSlice({
        context: context({ resume: true }),
        runtime: {
          session: async () => session,
          applyResult: async () => {
            throw new Error("prerequisite repair must not apply a machine result");
          },
        },
        phases,
        resume: true,
        recordRepairEvent: repairRecorder(repairEvents),
      });

      expect(repairEvents).toEqual([
        "state.repair.started:provider_selection",
        "state.repair.completed:provider_selection",
        "state.repair.started:sandbox",
        "state.repair.completed:sandbox",
      ]);
      expect(result.session.machine.state).toBe(state);
      expect(result.context.sandboxName).toBe("created-sandbox");
    },
  );

  it.each(["complete", "failed"] as const)(
    "rejects terminal %s sessions before core repair effects",
    async (state) => {
      const providerInference: OnboardSequencePhase<CoreContext> = {
        state: "provider_selection",
        run: vi.fn((ctx) => ({
          context: ctx,
          result: advanceTo("sandbox", { metadata: { state: "inference" } }),
        })),
      };
      const sandbox: OnboardSequencePhase<CoreContext> = {
        state: "sandbox",
        run: vi.fn((ctx) => ({
          context: ctx,
          result: branchTo("openclaw", { metadata: { state: "sandbox" } }),
        })),
      };

      await expect(
        runCoreOnboardFlowSlice({
          context: context({ resume: true }),
          runtime: {
            session: async () =>
              createSession({
                machine: {
                  version: 1,
                  state,
                  stateEnteredAt: "2026-06-09T00:00:00.000Z",
                  revision: 7,
                },
              }),
            applyResult: async () => createSession(),
          },
          phases: { providerInference, sandbox },
          resume: true,
          recordRepairEvent: repairRecorder(),
        }),
      ).rejects.toThrow("Unexpected onboarding flow state before slice entry");
      expect(providerInference.run).not.toHaveBeenCalled();
      expect(sandbox.run).not.toHaveBeenCalled();
    },
  );
});
