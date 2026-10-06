// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { sendConfigurationTelemetry } from "../../actions/telemetry/send";
import type { TelemetryConfiguration } from "../../domain/telemetry/dimensions";
import type { SandboxEntry } from "../../state/registry/types";
import { createRegisteredSandboxIdentityRevalidation } from "../sandbox-recreate-transaction";
import {
  type CompletedOnboardTelemetry,
  sendCompletedOnboardConfigurationTelemetry,
} from "./telemetry-completion";

function makeCompletion(
  overrides: Partial<CompletedOnboardTelemetry> = {},
): CompletedOnboardTelemetry {
  return {
    completed: true,
    sandboxName: "target",
    finalizedAgent: "openclaw",
    expectedSelection: { model: null, provider: null, preferredInferenceApi: null },
    assertRegistration: vi.fn(),
    getSandbox: vi.fn(() => ({ name: "target", agent: null })),
    withTargetLock: vi.fn((_name: string, collect: () => TelemetryConfiguration | null) =>
      collect(),
    ),
    ...overrides,
  };
}

function registeredTarget(): SandboxEntry {
  return {
    name: "target",
    agent: null,
    gatewayName: "private-gateway",
    lifecycleGeneration: "private-generation",
    lifecycleLiveIdentityFingerprint: "a".repeat(64),
    model: "Qwen/Qwen3.6-27B-FP8",
    provider: "nvidia-prod",
    preferredInferenceApi: "openai-completions",
  };
}

const expectedSelection = {
  model: "Qwen/Qwen3.6-27B-FP8",
  provider: "nvidia-prod",
  preferredInferenceApi: "openai-completions",
};

describe("completed onboarding telemetry", () => {
  it.each([
    { completed: false, sandboxName: "target" },
    { completed: true, sandboxName: null },
  ])("does not collect before exact completion (#10448)", async (completion) => {
    const getSandbox = vi.fn();
    const send = vi.fn<typeof sendConfigurationTelemetry>();
    await sendCompletedOnboardConfigurationTelemetry(
      makeCompletion({ ...completion, getSandbox }),
      send,
    );
    expect(send).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("leaves the exact target read behind sender gating (#10448)", async () => {
    const getSandbox = vi.fn(() => ({ name: "target", agent: null }));
    const send = vi.fn<typeof sendConfigurationTelemetry>(async () => "disabled");
    const completion = makeCompletion({ getSandbox });
    await sendCompletedOnboardConfigurationTelemetry(completion, send);
    expect(send).toHaveBeenCalledWith("onboard", expect.any(Function));
    expect(getSandbox).not.toHaveBeenCalled();
    expect(completion.assertRegistration).not.toHaveBeenCalled();
    expect(completion.withTargetLock).not.toHaveBeenCalled();
  });

  it("projects only the finalized nondefault target and proves its omitted agent (#10448)", async () => {
    const rows: Record<string, SandboxEntry> = {
      target: { name: "target", agent: null, model: "Qwen/Qwen3.6-27B-FP8" },
      default: { name: "default", agent: "hermes", model: "private/model" },
    };
    const getSandbox = vi.fn((name: string) => rows[name] ?? null);
    const send = vi.fn<typeof sendConfigurationTelemetry>(async (_operation, loadSnapshot) => {
      expect(loadSnapshot()).toMatchObject({
        agentHarnessId: "openclaw",
        modelId: "Qwen/Qwen3.6-27B-FP8",
      });
      return "delivered";
    });
    await sendCompletedOnboardConfigurationTelemetry(
      makeCompletion({
        getSandbox,
        expectedSelection: {
          model: "Qwen/Qwen3.6-27B-FP8",
          provider: null,
          preferredInferenceApi: null,
        },
      }),
      send,
    );
    expect(getSandbox).toHaveBeenCalledExactlyOnceWith("target");
  });

  it("does not substitute another row for a missing committed target (#10448)", async () => {
    const send = vi.fn<typeof sendConfigurationTelemetry>(async (_operation, loadSnapshot) => {
      expect(loadSnapshot()).toBeNull();
      return "failed";
    });
    await sendCompletedOnboardConfigurationTelemetry(
      makeCompletion({
        completed: true,
        sandboxName: "missing",
        finalizedAgent: "openclaw",
        getSandbox: () => null,
      }),
      send,
    );
  });

  it.each([
    { sessionAgent: "hermes", contextSandboxName: "target" },
    { sessionAgent: "openclaw", contextSandboxName: "different-target" },
  ])("denies conflicting finalized context before collection (#10448)", async (context) => {
    const getSandbox = vi.fn();
    const send = vi.fn<typeof sendConfigurationTelemetry>();
    await sendCompletedOnboardConfigurationTelemetry(
      makeCompletion({
        completed: true,
        sandboxName: "target",
        finalizedAgent: "openclaw",
        getSandbox,
        ...context,
      }),
      send,
    );
    expect(send).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("does not invent an agent for completed providerless creation that skipped agent setup (#10448)", async () => {
    const send = vi.fn<typeof sendConfigurationTelemetry>(async (_operation, loadSnapshot) => {
      expect(loadSnapshot()).toMatchObject({ agentHarnessId: "unknown", modelId: "unknown" });
      return "delivered";
    });
    await sendCompletedOnboardConfigurationTelemetry(
      makeCompletion({
        completed: true,
        sandboxName: "target",
        finalizedAgent: undefined,
        getSandbox: () => ({ name: "target", agent: null }),
      }),
      send,
    );
  });

  it("keeps onboarding successful when collection or delivery fails (#10448)", async () => {
    const send = vi.fn<typeof sendConfigurationTelemetry>(async (_operation, loadSnapshot) => {
      loadSnapshot();
      return "delivered";
    });
    await expect(
      sendCompletedOnboardConfigurationTelemetry(
        makeCompletion({
          completed: true,
          sandboxName: "target",
          finalizedAgent: "openclaw",
          getSandbox: () => {
            throw new Error("private registry error");
          },
        }),
        send,
      ),
    ).resolves.toBeUndefined();
    send.mockRejectedValueOnce(new Error("private network error"));
    await expect(
      sendCompletedOnboardConfigurationTelemetry(
        makeCompletion({
          completed: true,
          sandboxName: "target",
          finalizedAgent: "openclaw",
          getSandbox: () => null,
        }),
        send,
      ),
    ).resolves.toBeUndefined();
  });

  it("uses the captured registry identity inside the bounded lock without a live probe (#10448)", async () => {
    const expected = registeredTarget();
    const current = { ...expected };
    let held = false;
    const observe = vi.fn();
    const readRegistration = vi.fn(() => {
      expect(held).toBe(true);
      return current;
    });
    const guard = createRegisteredSandboxIdentityRevalidation(expected, {
      readRegistration,
      observe,
    })!;
    // Later mutation of the input row cannot change the captured authority.
    expected.gatewayName = "later-private-gateway";
    expected.lifecycleGeneration = "later-private-generation";
    expected.lifecycleLiveIdentityFingerprint = "b".repeat(64);
    const getSandbox = vi.fn(() => {
      expect(held).toBe(true);
      return current;
    });
    const withTargetLock = vi.fn((_name: string, collect: () => TelemetryConfiguration | null) => {
      held = true;
      try {
        return collect();
      } finally {
        held = false;
      }
    });
    await sendCompletedOnboardConfigurationTelemetry(
      makeCompletion({
        expectedSelection,
        assertRegistration: guard.assertRegistration,
        getSandbox,
        withTargetLock,
      }),
      async (_operation, loadSnapshot) => {
        const snapshot = loadSnapshot();
        expect(held).toBe(false);
        expect(snapshot).toMatchObject({
          agentHarnessId: "openclaw",
          modelId: expectedSelection.model,
        });
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot?.configuredMessagingChannels)).toBe(true);
        expect(JSON.stringify(snapshot)).not.toContain("private-");
        return "delivered";
      },
    );
    expect(withTargetLock).toHaveBeenCalledExactlyOnceWith("target", expect.any(Function), {
      timeoutMs: 100,
      pollIntervalMs: 20,
    });
    expect(readRegistration).toHaveBeenCalledExactlyOnceWith("target");
    expect(getSandbox).toHaveBeenCalledExactlyOnceWith("target");
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([
    { field: "gateway", changes: { gatewayName: "replacement-gateway" } },
    { field: "generation", changes: { lifecycleGeneration: "replacement-generation" } },
    { field: "live identity", changes: { lifecycleLiveIdentityFingerprint: "b".repeat(64) } },
  ])(
    "rejects replaced $field authority before projecting configuration (#10448)",
    async ({ changes }) => {
      const expected = registeredTarget();
      const observe = vi.fn();
      const guard = createRegisteredSandboxIdentityRevalidation(expected, {
        readRegistration: () => ({ ...expected, ...changes }),
        observe,
      })!;
      const getSandbox = vi.fn();
      await sendCompletedOnboardConfigurationTelemetry(
        makeCompletion({
          assertRegistration: guard.assertRegistration,
          getSandbox,
          expectedSelection,
        }),
        async (_operation, loadSnapshot) => {
          expect(loadSnapshot).toThrow("registered identity");
          return "failed";
        },
      );
      expect(getSandbox).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
    },
  );

  it.each([
    { field: "model", changes: { model: "deepseek-ai/DeepSeek-V4-Flash" } },
    { field: "provider", changes: { provider: "openai-api" } },
    { field: "API", changes: { preferredInferenceApi: "openai-responses" } },
  ])(
    "rejects a later $field selection on the same sandbox identity (#10448)",
    async ({ changes }) => {
      const expected = registeredTarget();
      const current = { ...expected, ...changes };
      const observe = vi.fn();
      const guard = createRegisteredSandboxIdentityRevalidation(expected, {
        readRegistration: () => current,
        observe,
      })!;
      await sendCompletedOnboardConfigurationTelemetry(
        makeCompletion({
          assertRegistration: guard.assertRegistration,
          getSandbox: () => current,
          expectedSelection,
        }),
        async (_operation, loadSnapshot) => {
          expect(loadSnapshot()).toBeNull();
          return "failed";
        },
      );
      expect(observe).not.toHaveBeenCalled();
    },
  );

  it.each([
    { state: "null", operationApi: null },
    { state: "missing", operationApi: undefined },
  ])(
    "rejects a known API after the completed operation had $state API (#10448)",
    async ({ operationApi }) => {
      const current = registeredTarget();
      const observe = vi.fn();
      const guard = createRegisteredSandboxIdentityRevalidation(current, {
        readRegistration: () => current,
        observe,
      })!;
      await sendCompletedOnboardConfigurationTelemetry(
        makeCompletion({
          assertRegistration: guard.assertRegistration,
          getSandbox: () => current,
          expectedSelection: { ...expectedSelection, preferredInferenceApi: operationApi },
        }),
        async (_operation, loadSnapshot) => {
          expect(loadSnapshot()).toBeNull();
          return "failed";
        },
      );
      expect(observe).not.toHaveBeenCalled();
    },
  );

  it.each([
    { operationState: "null", registryState: "null", operationApi: null, registryApi: null },
    {
      operationState: "null",
      registryState: "missing",
      operationApi: null,
      registryApi: undefined,
    },
    {
      operationState: "missing",
      registryState: "null",
      operationApi: undefined,
      registryApi: null,
    },
    {
      operationState: "missing",
      registryState: "missing",
      operationApi: undefined,
      registryApi: undefined,
    },
  ])(
    "accepts equivalent absent API values: operation $operationState, registry $registryState (#10448)",
    async ({ operationApi, registryApi }) => {
      const current = { ...registeredTarget(), preferredInferenceApi: registryApi };
      const observe = vi.fn();
      const guard = createRegisteredSandboxIdentityRevalidation(current, {
        readRegistration: () => current,
        observe,
      })!;
      await sendCompletedOnboardConfigurationTelemetry(
        makeCompletion({
          assertRegistration: guard.assertRegistration,
          getSandbox: () => current,
          expectedSelection: { ...expectedSelection, preferredInferenceApi: operationApi },
        }),
        async (_operation, loadSnapshot) => {
          expect(loadSnapshot()).toMatchObject({
            apiFamily: "unknown",
            modelId: expectedSelection.model,
          });
          return "delivered";
        },
      );
      expect(observe).not.toHaveBeenCalled();
    },
  );

  it("does not acquire a lock or read state when operation identity proof is missing (#10448)", async () => {
    const completion = makeCompletion({ assertRegistration: undefined });
    await sendCompletedOnboardConfigurationTelemetry(
      completion,
      async (_operation, loadSnapshot) => {
        expect(loadSnapshot()).toBeNull();
        return "failed";
      },
    );
    expect(completion.withTargetLock).not.toHaveBeenCalled();
    expect(completion.getSandbox).not.toHaveBeenCalled();
  });

  it("does not let a foreign identity guard authorize a matching route on another target (#10448)", async () => {
    const readRegistration = vi.fn();
    const observe = vi.fn();
    const getSandbox = vi.fn(() => ({ ...registeredTarget(), name: "another-target" }));
    const guard = createRegisteredSandboxIdentityRevalidation(registeredTarget(), {
      readRegistration,
      observe,
    })!;
    await sendCompletedOnboardConfigurationTelemetry(
      makeCompletion({
        sandboxName: "another-target",
        assertRegistration: guard.assertRegistration,
        getSandbox,
        expectedSelection,
      }),
      async (_operation, loadSnapshot) => {
        expect(loadSnapshot).toThrow("identity proof targets a different sandbox");
        return "failed";
      },
    );
    expect(readRegistration).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it("abandons contention without changing the completed onboarding result (#10448)", async () => {
    const completion = makeCompletion({
      withTargetLock: vi.fn(() => {
        throw new Error("private contender");
      }),
    });
    await expect(
      sendCompletedOnboardConfigurationTelemetry(completion, async (_operation, loadSnapshot) => {
        loadSnapshot();
        return "delivered";
      }),
    ).resolves.toBeUndefined();
    expect(completion.withTargetLock).toHaveBeenCalledExactlyOnceWith(
      "target",
      expect.any(Function),
      {
        timeoutMs: 100,
        pollIntervalMs: 20,
      },
    );
    expect(completion.assertRegistration).not.toHaveBeenCalled();
    expect(completion.getSandbox).not.toHaveBeenCalled();
  });

  it("does not acquire a lock or read registration when telemetry is opted out (#10448)", async () => {
    const completion = makeCompletion();
    const loadConfig = vi.fn();
    const deliverEvent = vi.fn();
    vi.stubEnv("NEMOCLAW_DISABLE_TELEMETRY", "1");
    try {
      await sendCompletedOnboardConfigurationTelemetry(completion, (operation, loadSnapshot) =>
        sendConfigurationTelemetry(operation, loadSnapshot, { loadConfig, deliverEvent }),
      );
      expect(loadConfig).not.toHaveBeenCalled();
      expect(deliverEvent).not.toHaveBeenCalled();
      expect(completion.withTargetLock).not.toHaveBeenCalled();
      expect(completion.assertRegistration).not.toHaveBeenCalled();
      expect(completion.getSandbox).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
