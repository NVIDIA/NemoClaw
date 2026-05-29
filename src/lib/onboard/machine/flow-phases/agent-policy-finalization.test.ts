// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { advanceTo, completeOnboardMachine } from "../result";
import type { OnboardFlowContext } from "../flow-context";
import {
  createAgentSetupPhase,
  createFinalizationPhase,
  createOpenclawSetupPhase,
  createPoliciesPhase,
  createPostVerifyPhase,
} from "./agent-policy-finalization";

function context(): OnboardFlowContext<null, null, null> {
  return {
    resume: false,
    fresh: false,
    session: createSession(),
    agent: null,
    recordedSandboxName: null,
    requestedSandboxName: null,
    sandboxName: "my-assistant",
    fromDockerfile: null,
    model: "model",
    provider: "provider",
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: true,
    selectedMessagingChannels: [],
    gpu: null,
    sandboxGpuConfig: null,
    gpuPassthrough: false,
  };
}

describe("agent/policy/finalization phases", () => {
  it("creates branch-specific setup phases", async () => {
    const agentPhase = createAgentSetupPhase(async () => ({ result: advanceTo("policies") }));
    const openclawPhase = createOpenclawSetupPhase(async () => ({ result: advanceTo("policies") }));

    expect(agentPhase.state).toBe("agent_setup");
    expect(openclawPhase.state).toBe("openclaw");
    await expect(agentPhase.run(context())).resolves.toMatchObject({ result: { next: "policies" } });
    await expect(openclawPhase.run(context())).resolves.toMatchObject({ result: { next: "policies" } });
  });

  it("maps policies context updates", async () => {
    const phase = createPoliciesPhase(async () => ({
      context: { selectedMessagingChannels: ["slack"] },
      result: advanceTo("finalizing"),
    }));

    const result = await phase.run(context());

    expect(phase.state).toBe("policies");
    expect(result.context.selectedMessagingChannels).toEqual(["slack"]);
    expect(result.result).toMatchObject({ next: "finalizing" });
  });

  it("creates finalization and post-verify phases", async () => {
    const finalizing = createFinalizationPhase(async () => ({ result: advanceTo("post_verify") }));
    const postVerify = createPostVerifyPhase(async () => ({
      result: completeOnboardMachine({ sandboxName: "my-assistant" }),
    }));

    expect(finalizing.state).toBe("finalizing");
    expect(postVerify.state).toBe("post_verify");
    await expect(finalizing.run(context())).resolves.toMatchObject({ result: { next: "post_verify" } });
    await expect(postVerify.run(context())).resolves.toMatchObject({
      result: { type: "complete" },
    });
  });
});
