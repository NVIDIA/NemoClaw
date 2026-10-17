// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

vi.mock("../../sandbox-registration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sandbox-registration")>()),
  withSandboxImageRegistrationFence: async <T>(operation: () => Promise<T> | T) => operation(),
}));

vi.mock("../../../state/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/registry")>()),
  getSandbox: vi.fn(() => null),
}));

const registeredEntry = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  provider: "provider",
  model: "model",
  endpointUrl: null,
  credentialEnv: null,
  preferredInferenceApi: "openai-completions" as const,
  gatewayName: "nemoclaw",
  ...overrides,
});

describe("handleSandboxState tool disclosure", () => {
  it.each([
    [
      "accepted Qwen preview",
      "vllm-local",
      "nvidia/Qwen3.6-35B-A3B-NVFP4",
      true,
      null,
      "progressive",
    ],
    ["unaccepted Qwen route", "vllm-local", "nvidia/Qwen3.6-35B-A3B-NVFP4", false, null, "direct"],
    ["another vLLM model", "vllm-local", "another-model", true, null, "direct"],
    ["Gemma on Ollama", "ollama-local", "gemma4:26b", true, null, "direct"],
    [
      "mismatched reservation",
      "vllm-local",
      "nvidia/Qwen3.6-35B-A3B-NVFP4",
      true,
      null,
      "direct",
      "another-model",
    ],
    ["explicit direct", "vllm-local", "nvidia/Qwen3.6-35B-A3B-NVFP4", true, "direct", "direct"],
    [
      "explicit progressive",
      "vllm-local",
      "nvidia/Qwen3.6-35B-A3B-NVFP4",
      true,
      "progressive",
      "progressive",
    ],
  ] as const)(
    "selects tool disclosure for %s (#13088)",
    async (
      _case,
      provider,
      model,
      previewAccepted,
      requested,
      expected,
      recordedModel: string = model,
    ) => {
      const session = createSession();
      const { deps, calls } = createDeps(
        {
          getSandboxRegistryEntry: (name) =>
            registeredEntry(name, {
              provider,
              model: recordedModel,
              pendingRouteReservation: true,
              reservationSessionId: session.sessionId,
            }),
        },
        session,
      );

      await handleSandboxState({
        ...baseOptions(deps, session),
        provider,
        model,
        agent: { name: "openclaw" },
        deferredN1xManagedVllmPreviewIntent: previewAccepted,
        env: requested ? { NEMOCLAW_TOOL_DISCLOSURE: requested } : {},
      });

      const createSandboxCall = calls.createSandbox.mock.calls[0] as unknown[];
      expect(createSandboxCall[15]).toMatchObject({ toolDisclosure: expected });
      expect(calls.removeSandbox).not.toHaveBeenCalled();
    },
  );

  it.each(["progressive", "direct"] as const)(
    "preserves recorded %s disclosure for an N1x Qwen sandbox (#13088)",
    async (mode) => {
      const session = createSession({ toolDisclosure: mode });
      const provider = "vllm-local";
      const model = "nvidia/Qwen3.6-35B-A3B-NVFP4";
      const { deps, calls } = createDeps(
        {
          getSandboxRegistryEntry: (name) =>
            registeredEntry(name, { provider, model, toolDisclosure: mode }),
        },
        session,
      );

      await handleSandboxState({
        ...baseOptions(deps, session),
        provider,
        model,
        deferredN1xManagedVllmPreviewIntent: true,
      });

      const createSandboxCall = calls.createSandbox.mock.calls[0] as unknown[];
      expect(createSandboxCall[15]).toMatchObject({ toolDisclosure: mode });
    },
  );

  it.each([
    ["ollama-local", "openclaw", "direct"],
    ["vllm-local", "openclaw", "direct"],
    ["nvidia-prod", "openclaw", "progressive"],
    ["llama-cpp-local", "openclaw", "progressive"],
    ["ollama-local", "hermes", "progressive"],
    ["vllm-local", "langchain-deepagents-code", "progressive"],
  ] as const)(
    "uses %s/%s initial tool disclosure %s (#12106)",
    async (provider, agentName, mode) => {
      const session = createSession();
      const { deps, calls } = createDeps(
        {
          getSandboxRegistryEntry: (name) =>
            registeredEntry(name, {
              provider,
              pendingRouteReservation: true,
              reservationSessionId: session.sessionId,
            }),
        },
        session,
      );

      await handleSandboxState({
        ...baseOptions(deps, session),
        provider,
        agent: { name: agentName },
      });

      const createSandboxCall = calls.createSandbox.mock.calls[0] as unknown[];
      expect(createSandboxCall[15]).toMatchObject({ toolDisclosure: mode });
      expect(calls.removeSandbox).not.toHaveBeenCalled();
    },
  );

  it.each(["progressive", "direct"] as const)(
    "preserves an explicit %s choice for a fresh local OpenClaw sandbox (#12106)",
    async (mode) => {
      const session = createSession();
      const { deps, calls } = createDeps(
        {
          getSandboxRegistryEntry: (name) =>
            registeredEntry(name, {
              provider: "ollama-local",
              pendingRouteReservation: true,
              reservationSessionId: session.sessionId,
            }),
        },
        session,
      );

      await handleSandboxState({
        ...baseOptions(deps, session),
        provider: "ollama-local",
        agent: { name: "openclaw" },
        env: { NEMOCLAW_TOOL_DISCLOSURE: mode },
      });

      const createSandboxCall = calls.createSandbox.mock.calls[0] as unknown[];
      expect(createSandboxCall[15]).toMatchObject({ toolDisclosure: mode });
    },
  );

  it.each(["ollama-local", "vllm-local"])(
    "preserves progressive when %s creation targets registered state (#12106)",
    async (provider) => {
      const session = createSession();
      const { deps, calls } = createDeps({}, session);

      await handleSandboxState({
        ...baseOptions(deps, session),
        provider,
        agent: { name: "openclaw" },
      });

      const createSandboxCall = calls.createSandbox.mock.calls[0] as unknown[];
      expect(createSandboxCall[15]).toMatchObject({ toolDisclosure: "progressive" });
      expect(calls.removeSandbox).not.toHaveBeenCalled();
    },
  );

  it("fails closed without claiming an unregistered live sandbox as a managed migration", async () => {
    const session = createSession({ sandboxName: "saved", toolDisclosure: "progressive" });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: () => null,
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a legacy managed image",
      createSession({ toolDisclosure: "progressive" }),
      undefined,
      "  [resume] Tool disclosure metadata is missing; recreating sandbox for one-time migration.",
    ],
    [
      "a changed selection",
      createSession({ toolDisclosure: "direct" }),
      "progressive" as const,
      "  [resume] Tool disclosure configuration changed; recreating sandbox.",
    ],
  ])("recreates instead of reusing %s tool disclosure", async (_label, session, recorded, note) => {
    session.sandboxName = "saved";
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name) =>
        registeredEntry(name, {
          nemoclawVersion: "0.1.0",
          toolDisclosure: recorded,
          fromDockerfile: null,
        }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      endpointSource: "inference-set",
      sandboxName: "saved",
    });

    expect(calls.note).toHaveBeenCalledWith(note);
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it.each([
    ["progressive", "direct"],
    ["direct", "progressive"],
  ] as const)(
    "passes resumed %s-to-%s tool-disclosure drift into the downstream create intent",
    async (recordedMode, requestedMode) => {
      const session = createSession({ sandboxName: "saved", toolDisclosure: requestedMode });
      session.steps.sandbox.status = "complete";
      const { deps, calls } = createDeps({
        getSandboxReuseState: () => "ready",
        updateSession: vi.fn(
          (mutator: (value: Session) => Session | void) => mutator(session) ?? session,
        ),
        getSandboxRegistryEntry: (name) =>
          registeredEntry(name, {
            nemoclawVersion: "0.1.0",
            toolDisclosure: recordedMode,
          }),
      });

      await handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        endpointSource: "inference-set",
        sandboxName: "saved",
      });

      expect(calls.removeSandbox).not.toHaveBeenCalled();
      const createSandboxCall = calls.createSandbox.mock.calls[0] as unknown[];
      expect(createSandboxCall[14]).toEqual({
        sessionId: session.sessionId,
        selection: {
          provider: "provider",
          model: "model",
          endpointUrl: null,
          endpointSource: null,
          credentialEnv: null,
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        },
      });
      expect(createSandboxCall[15]).toMatchObject({
        resolved: expect.any(Object),
        recreate: true,
        toolDisclosure: requestedMode,
        observabilityEnabled: false,
        endpointSource: "inference-set",
        extraProviders: [],
        reuseRegisteredCredentials: true,
      });
    },
  );

  it("recreates a legacy custom image so its tool-disclosure contract is validated", async () => {
    const session = createSession({ sandboxName: "saved", toolDisclosure: "progressive" });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name) =>
        registeredEntry(name, {
          nemoclawVersion: null,
          fromDockerfile: "/tmp/Dockerfile.custom",
        }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Tool disclosure metadata is missing; recreating sandbox for one-time migration.",
    );
    expect(calls.createSandbox).toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
  });

  it("retains managed MCP registry fidelity until createSandbox can refuse generic migration", async () => {
    const session = createSession({ sandboxName: "saved", toolDisclosure: "progressive" });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name) =>
        registeredEntry(name, {
          nemoclawVersion: "0.1.0",
          mcp: {
            version: 1,
            bridges: {
              fake: {
                server: "fake",
                agent: "openclaw",
                url: "https://mcp.example.test",
                env: [],
                policyName: "mcp-bridge-fake",
                addedAt: "2026-07-03T00:00:00.000Z",
              },
            },
          },
        }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalled();
  });
});
