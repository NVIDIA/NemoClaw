// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession } from "../../state/onboard-session";
import { advanceTo, branchTo, completeOnboardMachine } from "./result";
import type { OnboardFlowContext, OnboardFlowPhaseResult } from "./flow-context";
import { onboardFlowPhaseResult } from "./flow-context";
import { buildOnboardFlowPhaseSequence } from "./flow-sequence";

type Context = OnboardFlowContext<null, { type: string }, { mode: string }>;

function context(): Context {
  return {
    resume: false,
    fresh: false,
    session: createSession(),
    agent: null,
    recordedSandboxName: null,
    requestedSandboxName: null,
    sandboxName: null,
    fromDockerfile: null,
    model: null,
    provider: null,
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: false,
    selectedMessagingChannels: [],
    gpu: null,
    sandboxGpuConfig: { mode: "0" },
    gpuPassthrough: false,
  };
}

function result(ctx: Context, next: ReturnType<typeof advanceTo>["next"]): OnboardFlowPhaseResult<Context> {
  return onboardFlowPhaseResult(ctx, advanceTo(next));
}

describe("onboard flow phase sequence", () => {
  it("assembles phases in machine order", () => {
    const phases = buildOnboardFlowPhaseSequence<Context>({
      preflight: async (ctx) => result({ ...ctx, gpu: { type: "nvidia" }, gpuPassthrough: true }, "gateway"),
      gateway: async (ctx) => result(ctx, "provider_selection"),
      providerInference: async (ctx) => result({ ...ctx, provider: "nvidia", model: "model" }, "sandbox"),
      sandbox: async (ctx) => onboardFlowPhaseResult({ ...ctx, sandboxName: "my-assistant" }, branchTo("openclaw")),
      openclaw: async (ctx) => result(ctx, "policies"),
      agentSetup: async (ctx) => result(ctx, "policies"),
      policies: async (ctx) => result(ctx, "finalizing"),
      finalization: async (ctx) => result(ctx, "post_verify"),
      postVerify: async (ctx) => onboardFlowPhaseResult(ctx, completeOnboardMachine()),
    });

    expect(phases.map((phase) => phase.state)).toEqual([
      "preflight",
      "gateway",
      "provider_selection",
      "sandbox",
      "openclaw",
      "agent_setup",
      "policies",
      "finalizing",
      "post_verify",
    ]);
  });

  it("delegates phase execution to supplied handlers", async () => {
    const phases = buildOnboardFlowPhaseSequence<Context>({
      preflight: async (ctx) => result({ ...ctx, gpu: { type: "nvidia" }, gpuPassthrough: true }, "gateway"),
      gateway: async (ctx) => result(ctx, "provider_selection"),
      providerInference: async (ctx) => result(ctx, "sandbox"),
      sandbox: async (ctx) => onboardFlowPhaseResult(ctx, branchTo("openclaw")),
      openclaw: async (ctx) => result(ctx, "policies"),
      agentSetup: async (ctx) => result(ctx, "policies"),
      policies: async (ctx) => result(ctx, "finalizing"),
      finalization: async (ctx) => result(ctx, "post_verify"),
      postVerify: async (ctx) => onboardFlowPhaseResult(ctx, completeOnboardMachine()),
    });

    const preflight = await phases[0].run(context());

    expect(preflight.context.gpu).toEqual({ type: "nvidia" });
    expect(preflight.result).toMatchObject({ next: "gateway" });
  });
});
