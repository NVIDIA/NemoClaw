// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPortableOnboardEnvironmentScope } from "../session-bootstrap";
import {
  context as createFlowContext,
  sessionAt,
} from "../../../../test/helpers/onboard-final-flow-phases";
import { createTestRuntime } from "../../../../test/helpers/onboard-machine-runtime-fixture";
import type { SandboxEntry } from "../../state/registry/types";

const mocks = vi.hoisted(() => ({
  createFinalFlowPhases: vi.fn(),
  runFinalFlowSlice: vi.fn(),
}));

vi.mock("./final-flow-phases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./final-flow-phases")>()),
  createFinalOnboardFlowPhases: mocks.createFinalFlowPhases,
  runFinalOnboardFlowSlice: mocks.runFinalFlowSlice,
}));

import {
  completeSuccessfulOnboardFlow,
  createFinalOnboardFlowPhases,
  createSuccessfulOnboardFlowCompletion,
  finalizationHandlerDeps,
} from "./final-flow-composition";

function createCompletionFixture() {
  const getSandbox = vi.fn<(name: string) => SandboxEntry | null>(() => null);
  const withTargetLock = vi.fn<
    Parameters<typeof createSuccessfulOnboardFlowCompletion>[0]["withTargetLock"]
  >((_name, collect) => collect());
  const supersede = vi.fn(async () => undefined);
  const disarmRollback = vi.fn();
  const onCompleted = vi.fn<(completed: boolean) => void>();
  const send = vi.fn<NonNullable<Parameters<typeof completeSuccessfulOnboardFlow>[2]>>(
    async () => "disabled",
  );
  const completion = createSuccessfulOnboardFlowCompletion({
    getSandbox,
    withTargetLock,
    supersede,
    disarmRollback,
    onCompleted,
    send,
  });
  return { completion, getSandbox, withTargetLock, supersede, disarmRollback, onCompleted, send };
}

function finalFlowContext() {
  return { ...createFlowContext(), sandboxName: "my-sandbox" };
}

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
      agentSetupDeps: {
        waitForSandboxControlPlaneReady: finalizationHandlerDeps.waitForSandboxControlPlaneReady,
        waitForStartedOpenclawGatewayProcess:
          finalizationHandlerDeps.waitForStartedOpenclawGatewayProcess,
        settleStartedOpenclawGatewayForConfiguration:
          finalizationHandlerDeps.settleStartedOpenclawGatewayForConfiguration,
      },
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

describe("completed onboarding boundary", () => {
  it("keeps construction free of registration reads, locks, and delivery (#10448)", () => {
    const fixture = createCompletionFixture();
    expect(fixture.getSandbox).not.toHaveBeenCalled();
    expect(fixture.withTargetLock).not.toHaveBeenCalled();
    expect(fixture.supersede).not.toHaveBeenCalled();
    expect(fixture.disarmRollback).not.toHaveBeenCalled();
    expect(fixture.onCompleted).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("records providerless completion after supersession and before lazy reporting (#10448)", async () => {
    const fixture = createCompletionFixture();
    const order: string[] = [];
    fixture.disarmRollback.mockImplementation(() => {
      order.push("disarmed");
    });
    fixture.supersede.mockImplementation(async () => {
      order.push("superseded");
    });
    fixture.onCompleted.mockImplementation((completed) => {
      expect(completed).toBe(true);
      order.push("completed");
    });
    fixture.getSandbox.mockReturnValue({ name: "target", agent: null });
    fixture.send.mockImplementation(async (_operation, loadSnapshot) => {
      order.push("report");
      expect(loadSnapshot()).toMatchObject({ agentHarnessId: "unknown", modelId: "unknown" });
      return "delivered";
    });
    await expect(
      fixture.completion.tryCompleteCore({
        context: createFlowContext({
          providerlessApf: true,
          sandboxName: "target",
          model: null,
          provider: null,
          preferredInferenceApi: null,
          revalidateSandboxIdentity: Object.assign(vi.fn(), { assertRegistration: vi.fn() }),
        }),
        session: sessionAt("complete"),
      }),
    ).resolves.toBe(true);
    expect(order).toEqual(["disarmed", "superseded", "completed", "report"]);
    expect(fixture.getSandbox).toHaveBeenCalledExactlyOnceWith("target");
  });

  it("preserves providerless failure before the outer completed flag or reporting (#10448)", async () => {
    const fixture = createCompletionFixture();
    const order: string[] = [];
    fixture.disarmRollback.mockImplementation(() => {
      order.push("disarmed");
    });
    fixture.supersede.mockImplementation(async () => {
      order.push("retirement failed");
      throw new Error("retirement failed");
    });
    await expect(
      fixture.completion.tryCompleteCore({
        context: createFlowContext({ providerlessApf: true }),
        session: sessionAt("complete"),
      }),
    ).rejects.toThrow("retirement failed");
    expect(order).toEqual(["disarmed", "retirement failed"]);
    expect(fixture.onCompleted).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.getSandbox).not.toHaveBeenCalled();
  });

  it.each([
    { name: "provider-backed flow", patch: { providerlessApf: undefined }, state: "complete" },
    { name: "unfinished core", patch: { providerlessApf: true }, state: "post_verify" },
    {
      name: "missing target",
      patch: { providerlessApf: true, sandboxName: null },
      state: "complete",
    },
  ] as const)(
    "leaves $name for finalization without completion effects (#10448)",
    async ({ patch, state }) => {
      const fixture = createCompletionFixture();
      await expect(
        fixture.completion.tryCompleteCore({
          context: createFlowContext(patch),
          session: sessionAt(state),
        }),
      ).resolves.toBe(false);
      expect(fixture.disarmRollback).not.toHaveBeenCalled();
      expect(fixture.supersede).not.toHaveBeenCalled();
      expect(fixture.onCompleted).not.toHaveBeenCalled();
      expect(fixture.send).not.toHaveBeenCalled();
      expect(fixture.withTargetLock).not.toHaveBeenCalled();
      expect(fixture.getSandbox).not.toHaveBeenCalled();
    },
  );

  it("tracks runner context updates and captures the exact final target before cleanup (#10448)", async () => {
    const fixture = createCompletionFixture();
    const initial = { ...createFlowContext(), sandboxName: "old-target" };
    const assertRegistration = vi.fn();
    const updated = createFlowContext({
      sandboxName: "target",
      agent: null,
      model: "Qwen/Qwen3.6-27B-FP8",
      provider: "nvidia-prod",
      preferredInferenceApi: "openai-completions",
      revalidateSandboxIdentity: Object.assign(vi.fn(), { assertRegistration }),
    });
    const committed = {
      name: "target",
      agent: null,
      model: updated.model,
      provider: updated.provider,
      preferredInferenceApi: updated.preferredInferenceApi,
    };
    const session = sessionAt("complete");
    session.sandboxName = "target";
    session.agent = null;
    const finalFlow = fixture.completion.beginFinal<ReturnType<typeof createFlowContext>>(initial);
    expect(finalFlow.initialSandboxName).toBe("old-target");
    mocks.runFinalFlowSlice.mockImplementationOnce(
      async (options: {
        context: ReturnType<typeof createFlowContext>;
        onContextUpdated: (context: ReturnType<typeof createFlowContext>) => void;
      }) => {
        expect(options.context).toBe(initial);
        options.onContextUpdated(updated);
        return { context: updated, session };
      },
    );
    const runtime = createTestRuntime(session);
    const recordRepairEvent = vi.fn(async () => undefined);
    const afterPoliciesReady = vi.fn();
    const result = await finalFlow.run({
      runtime,
      phases: [],
      recordRepairEvent,
      afterPoliciesReady,
    });
    expect(result.session).toBe(session);
    expect(finalFlow.context).toBe(updated);
    expect(mocks.runFinalFlowSlice).toHaveBeenLastCalledWith({
      context: initial,
      runtime,
      phases: [],
      recordRepairEvent,
      afterPoliciesReady,
      onContextUpdated: expect.any(Function),
    });
    fixture.getSandbox.mockReturnValue(committed);
    const order: string[] = [];
    fixture.onCompleted.mockImplementation((completed) => {
      expect(completed).toBe(true);
      order.push("completed");
    });
    fixture.supersede.mockImplementation(async () => {
      order.push("superseded");
      updated.sandboxName = "foreign-target";
      updated.agent = { name: "hermes" };
      updated.model = "private/later-model";
      updated.provider = "private-later-provider";
      updated.preferredInferenceApi = "openai-responses";
      session.sandboxName = "foreign-session-target";
      session.agent = "hermes";
    });
    fixture.send.mockImplementation(async (_operation, loadSnapshot) => {
      order.push("report");
      const snapshot = loadSnapshot();
      expect(snapshot).toMatchObject({
        agentHarnessId: "openclaw",
        modelId: committed.model,
        providerProfile: "nvidia",
        apiFamily: "openai-completions",
      });
      expect(JSON.stringify(snapshot)).not.toContain("private");
      return "delivered";
    });
    await expect(finalFlow.complete(result.session)).resolves.toBe(true);
    expect(order).toEqual(["completed", "superseded", "report"]);
    expect(assertRegistration).toHaveBeenCalledExactlyOnceWith(
      "collect completed onboarding configuration",
      "target",
    );
    expect(fixture.getSandbox).toHaveBeenCalledExactlyOnceWith("target");
  });

  it.each(["post_verify", "failed"] as const)(
    "does not retire or report an incomplete final session at %s (#10448)",
    async (state) => {
      const fixture = createCompletionFixture();
      const finalFlow = fixture.completion.beginFinal(finalFlowContext());
      await expect(finalFlow.complete(sessionAt(state))).resolves.toBe(false);
      expect(fixture.onCompleted).toHaveBeenCalledExactlyOnceWith(false);
      expect(fixture.supersede).not.toHaveBeenCalled();
      expect(fixture.send).not.toHaveBeenCalled();
      expect(fixture.getSandbox).not.toHaveBeenCalled();
    },
  );

  it("retains the completed flag but does not retire a final session without a target (#10448)", async () => {
    const fixture = createCompletionFixture();
    const session = sessionAt("complete");
    session.sandboxName = null;
    await expect(fixture.completion.beginFinal(finalFlowContext()).complete(session)).resolves.toBe(
      true,
    );
    expect(fixture.onCompleted).toHaveBeenCalledExactlyOnceWith(true);
    expect(fixture.supersede).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("retains final completion timing when retirement fails and sends no event (#10448)", async () => {
    const fixture = createCompletionFixture();
    fixture.supersede.mockImplementation(async () => {
      expect(fixture.onCompleted).toHaveBeenCalledExactlyOnceWith(true);
      throw new Error("retirement failed");
    });
    await expect(
      fixture.completion.beginFinal(finalFlowContext()).complete(sessionAt("complete")),
    ).rejects.toThrow("retirement failed");
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.getSandbox).not.toHaveBeenCalled();
  });

  it("captures the completed selection before cleanup changes the context (#10448)", async () => {
    const context = {
      model: "Qwen/Qwen3.6-27B-FP8",
      provider: "nvidia-prod",
      preferredInferenceApi: "openai-completions",
      endpointUrl: "https://private.example.invalid/v1",
    };
    const committed = {
      name: "target",
      agent: "openclaw",
      model: context.model,
      provider: context.provider,
      preferredInferenceApi: context.preferredInferenceApi,
    };
    const getSandbox = vi.fn(() => committed);
    await completeSuccessfulOnboardFlow(
      {
        completed: true,
        sandboxName: "target",
        finalizedAgent: "openclaw",
        expectedSelection: context,
        assertRegistration: vi.fn(),
        getSandbox,
        withTargetLock: (_name, collect) => collect(),
      },
      async () => {
        context.model = "private/later-model";
        context.provider = "private-later-provider";
        context.preferredInferenceApi = "openai-responses";
      },
      async (_operation, loadSnapshot) => {
        const snapshot = loadSnapshot();
        expect(snapshot).toMatchObject({
          modelId: committed.model,
          providerProfile: "nvidia",
          apiFamily: "openai-completions",
        });
        expect(JSON.stringify(snapshot)).not.toContain("private");
        return "delivered";
      },
    );
    expect(getSandbox).toHaveBeenCalledExactlyOnceWith("target");
  });

  it("waits for supersession before lazy configuration collection (#10448)", async () => {
    const order: string[] = [];
    const getSandbox = vi.fn((name: string) => {
      order.push("collection");
      return { name, agent: "openclaw" };
    });
    await completeSuccessfulOnboardFlow(
      {
        completed: true,
        sandboxName: "target",
        finalizedAgent: "openclaw",
        expectedSelection: { model: null, provider: null, preferredInferenceApi: null },
        assertRegistration: vi.fn(),
        getSandbox,
        withTargetLock: (_name, collect) => collect(),
      },
      async () => {
        order.push("superseded");
      },
      async (_operation, loadSnapshot) => {
        order.push("report");
        expect(loadSnapshot()?.agentHarnessId).toBe("openclaw");
        return "delivered";
      },
    );
    expect(order).toEqual(["superseded", "report", "collection"]);
    expect(getSandbox).toHaveBeenCalledExactlyOnceWith("target");
  });

  it("does not report or collect when supersession fails (#10448)", async () => {
    const send = vi.fn();
    const getSandbox = vi.fn();
    await expect(
      completeSuccessfulOnboardFlow(
        {
          completed: true,
          sandboxName: "target",
          finalizedAgent: "openclaw",
          expectedSelection: { model: null, provider: null, preferredInferenceApi: null },
          assertRegistration: vi.fn(),
          getSandbox,
          withTargetLock: (_name, collect) => collect(),
        },
        async () => {
          throw new Error("supersession failure");
        },
        send,
      ),
    ).rejects.toThrow("supersession failure");
    expect(send).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
  });
});
