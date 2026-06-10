// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { advanceTo } from "../result";
import type { OnboardFlowContext } from "../flow-context";
import { createGatewayPhase, createPreflightPhase } from "./preflight-gateway";

function context(): OnboardFlowContext<null, { type: string }, { mode: string }> {
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
    sandboxGpuConfig: null,
    gpuPassthrough: false,
  };
}

describe("preflight/gateway flow phases", () => {
  it("maps preflight handler outputs into flow context and FSM result", async () => {
    const session = createSession({ gpuPassthrough: true });
    const runPreflight = vi.fn(async () => ({
      session,
      gpu: { type: "nvidia" },
      sandboxGpuConfig: { mode: "1" },
      gpuPassthrough: true,
      result: advanceTo("gateway"),
    }));
    const phase = createPreflightPhase(runPreflight);

    const result = await phase.run(context());

    expect(phase.state).toBe("preflight");
    expect(runPreflight).toHaveBeenCalledOnce();
    expect(result.context).toMatchObject({
      session,
      gpu: { type: "nvidia" },
      sandboxGpuConfig: { mode: "1" },
      gpuPassthrough: true,
    });
    expect(result.result).toMatchObject({ next: "gateway" });
  });

  it("maps gateway handler outputs into flow context and FSM result", async () => {
    const session = createSession({ sandboxName: "my-assistant" });
    const phase = createGatewayPhase(async () => ({
      session,
      result: advanceTo("provider_selection"),
    }));

    const result = await phase.run(context());

    expect(phase.state).toBe("gateway");
    expect(result.context.session).toBe(session);
    expect(result.result).toMatchObject({ next: "provider_selection" });
  });
});
