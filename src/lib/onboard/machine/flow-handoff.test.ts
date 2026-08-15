// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, MACHINE_SNAPSHOT_VERSION, type Session } from "../../state/onboard-session";
import type { OnboardFlowContext } from "./flow-context";
import { prepareCoreOnboardFlowContext, prepareFinalOnboardFlowContext } from "./flow-handoff";
import type { OnboardMachineState } from "./types";

const TRACE_TIME = "2026-08-03T00:00:00.000Z";

interface HandoffResultCase {
  trace: string;
  resume: boolean;
  fresh: boolean;
  initialState: OnboardMachineState;
  coreState: OnboardMachineState;
  status: "in_progress" | "failed";
}

const handoffResultCases: readonly HandoffResultCase[] = [
  {
    trace: "resumed",
    resume: true,
    fresh: false,
    initialState: "provider_selection",
    coreState: "openclaw",
    status: "in_progress",
  },
  {
    trace: "failed",
    resume: false,
    fresh: true,
    initialState: "failed",
    coreState: "failed",
    status: "failed",
  },
  {
    trace: "paused",
    resume: false,
    fresh: true,
    initialState: "gateway",
    coreState: "sandbox",
    status: "in_progress",
  },
];

function runnerSession(
  state: OnboardMachineState,
  status: HandoffResultCase["status"],
  failure: Session["failure"],
): Session {
  const session = createSession({
    failure,
    machine: {
      version: MACHINE_SNAPSHOT_VERSION,
      state,
      stateEnteredAt: TRACE_TIME,
      revision: 7,
    },
  });
  session.status = status;
  return session;
}

function context(): OnboardFlowContext & {
  gpu: string | null;
  sandboxGpuConfig: { mode: string } | null;
  gpuPassthrough: boolean;
} {
  return {
    resume: false,
    fresh: true,
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
    compatibleEndpointReasoning: null,

    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: false,
    selectedMessagingChannels: [],
    gpu: "nvidia",
    sandboxGpuConfig: { mode: "cdi" },
    gpuPassthrough: true,
  };
}

describe("onboard flow handoffs", () => {
  it("constructs core context from the initial result and requested name", () => {
    const initialContext = context();
    const persisted = createSession();
    const assertSandboxNameAllowed = vi.fn();

    const result = prepareCoreOnboardFlowContext({
      initial: { context: initialContext, session: persisted },
      recordedSandboxName: null,
      requestedSandboxName: "requested",
      checkpointedSandboxName: "checkpointed",
      selectedMessagingChannels: ["slack"],
      assertSandboxNameAllowed,
    });

    expect(result).toMatchObject({
      session: persisted,
      sandboxName: "requested",
      selectedMessagingChannels: ["slack"],
      gpu: "nvidia",
      sandboxGpuConfig: { mode: "cdi" },
      gpuPassthrough: true,
    });
    expect(assertSandboxNameAllowed).toHaveBeenCalledWith("requested");
  });

  it.each([
    {
      source: "recorded",
      recordedSandboxName: "recorded",
      requestedSandboxName: "requested",
      checkpointedSandboxName: "checkpointed",
    },
    {
      source: "requested",
      recordedSandboxName: null,
      requestedSandboxName: "requested",
      checkpointedSandboxName: "checkpointed",
    },
    {
      source: "checkpointed",
      recordedSandboxName: null,
      requestedSandboxName: null,
      checkpointedSandboxName: "checkpointed",
    },
  ])("selects the $source sandbox name by precedence", ({
    source,
    recordedSandboxName,
    requestedSandboxName,
    checkpointedSandboxName,
  }) => {
    const assertSandboxNameAllowed = vi.fn();

    const result = prepareCoreOnboardFlowContext({
      initial: { context: context(), session: createSession() },
      recordedSandboxName,
      requestedSandboxName,
      checkpointedSandboxName,
      selectedMessagingChannels: [],
      assertSandboxNameAllowed,
    });

    expect(result.sandboxName).toBe(source);
    expect(assertSandboxNameAllowed).toHaveBeenCalledWith(source);
  });

  it("rejects a missing preflight GPU configuration", () => {
    const initialContext = { ...context(), sandboxGpuConfig: null };
    const persisted = createSession();

    expect(() =>
      prepareCoreOnboardFlowContext({
        initial: { context: initialContext, session: persisted },
        recordedSandboxName: null,
        requestedSandboxName: null,
        checkpointedSandboxName: null,
        selectedMessagingChannels: [],
        assertSandboxNameAllowed: vi.fn(),
      }),
    ).toThrow("Preflight did not produce a sandbox GPU configuration.");
  });

  it.each(
    handoffResultCases,
  )("preserves a $trace runner result at the initial-to-core handoff (#7706)", ({
    trace,
    resume,
    fresh,
    initialState,
    status,
  }) => {
    const failure =
      status === "failed"
        ? {
            step: "gateway",
            message: "gateway failed",
            recordedAt: TRACE_TIME,
          }
        : null;
    const persisted = runnerSession(initialState, status, failure);
    const endpointUrl = `https://${trace}.example.test`;

    const result = prepareCoreOnboardFlowContext({
      initial: {
        context: {
          ...context(),
          resume,
          fresh,
          endpointUrl,
        },
        session: persisted,
      },
      recordedSandboxName: null,
      requestedSandboxName: null,
      checkpointedSandboxName: null,
      selectedMessagingChannels: ["slack"],
      assertSandboxNameAllowed: vi.fn(),
    });

    expect(result.session).toBe(persisted);
    expect(result).toMatchObject({
      resume,
      fresh,
      endpointUrl,
      selectedMessagingChannels: ["slack"],
    });
    expect(result.session).toMatchObject({
      status,
      resumable: true,
      failure,
      machine: {
        state: initialState,
        revision: 7,
      },
    });
  });

  it("constructs final context after sandbox identity and inference are complete", () => {
    const persisted = createSession();
    const coreContext = {
      ...context(),
      sandboxName: "ready",
      model: "model",
      provider: "provider",
      endpointUrl: "https://inference.example.test",
      selectedMessagingChannels: ["slack"],
    };

    const result = prepareFinalOnboardFlowContext({
      context: coreContext,
      session: persisted,
    });

    expect(result.session).toBe(persisted);
    expect(result).toMatchObject({
      sandboxName: "ready",
      model: "model",
      provider: "provider",
      endpointUrl: "https://inference.example.test",
      selectedMessagingChannels: ["slack"],
    });
  });

  it.each(
    handoffResultCases,
  )("preserves a $trace runner result at the core-to-final handoff (#7706)", ({
    trace,
    resume,
    fresh,
    coreState,
    status,
  }) => {
    const failure =
      status === "failed"
        ? {
            step: "sandbox",
            message: "sandbox failed",
            recordedAt: TRACE_TIME,
          }
        : null;
    const persisted = runnerSession(coreState, status, failure);
    const endpointUrl = `https://${trace}.example.test`;

    const result = prepareFinalOnboardFlowContext({
      context: {
        ...context(),
        resume,
        fresh,
        sandboxName: "ready",
        model: "model",
        provider: "provider",
        endpointUrl,
        selectedMessagingChannels: ["slack"],
      },
      session: persisted,
    });

    expect(result.session).toBe(persisted);
    expect(result).toMatchObject({
      resume,
      fresh,
      sandboxName: "ready",
      model: "model",
      provider: "provider",
      endpointUrl,
      selectedMessagingChannels: ["slack"],
    });
    expect(result.session).toMatchObject({
      status,
      resumable: true,
      failure,
      machine: {
        state: coreState,
        revision: 7,
      },
    });
  });

  it.each([
    "sandboxName",
    "model",
    "provider",
  ] as const)("rejects final context when $field is missing", (field) => {
    const coreContext = {
      ...context(),
      sandboxName: "ready",
      model: "model",
      provider: "provider",
      [field]: null,
    };

    expect(() =>
      prepareFinalOnboardFlowContext({
        context: coreContext,
        session: createSession(),
      }),
    ).toThrow("Onboarding state is incomplete after sandbox setup.");
  });
});
