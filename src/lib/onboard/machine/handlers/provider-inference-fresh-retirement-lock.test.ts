// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

it("serializes fresh retirement with same-name lifecycle registration (#12291)", async () => {
  const events: string[] = [];
  let releaseRetirement!: () => void;
  let reportRetirementStarted!: () => void;
  const retirementGate = new Promise<void>((resolve) => {
    releaseRetirement = resolve;
  });
  const retirementStarted = new Promise<void>((resolve) => {
    reportRetirementStarted = resolve;
  });
  let lockTail = Promise.resolve();
  const withSandboxMutationLock = async <T>(
    _sandboxName: string,
    operation: () => Promise<T> | T,
  ): Promise<T> => {
    const previous = lockTail;
    let releaseLock!: () => void;
    lockTail = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      releaseLock();
    }
  };
  const { deps } = createDeps({
    setupNim: vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model: "qwen3-vl:4b",
    })),
    withSandboxMutationLock,
    hasSandboxLifecycleAuthority: vi.fn(() => {
      events.push("authority");
      return false;
    }),
    retireHostLocalInferenceFreshState: vi.fn(async () => {
      events.push("retire:start");
      reportRetirementStarted();
      await retirementGate;
      events.push("retire:end");
      return true;
    }),
  });

  const onboard = handleProviderInferenceState({
    ...baseOptions(deps),
    fresh: true,
    sandboxName: "portable-hermes",
    agent: { name: "hermes" },
  });
  await retirementStarted;
  const registration = withSandboxMutationLock("portable-hermes", async () => {
    events.push("register");
  });
  await Promise.resolve();

  expect(events).toEqual(["authority", "retire:start"]);

  releaseRetirement();
  await Promise.all([onboard, registration]);

  expect(events).toEqual(["authority", "retire:start", "retire:end", "register"]);
});

it("retires fresh state for the sandbox name confirmed by configuration review (#12291)", async () => {
  const retiredSandboxNames: string[] = [];
  const events: string[] = [];
  const { deps } = createDeps({
    setupNim: vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model: "qwen3-vl:4b",
    })),
    isNonInteractive: () => false,
    prompt: vi.fn().mockResolvedValueOnce("3").mockResolvedValueOnce("1"),
    promptValidatedSandboxName: vi.fn(async () => "confirmed-hermes"),
    resolveHostLocalInferenceStartupSelection: vi.fn(() => {
      events.push("resolve");
      return null;
    }),
    retireHostLocalInferenceFreshState: vi.fn(async (selection) => {
      events.push("retire");
      retiredSandboxNames.push(selection.sandboxName);
      return true;
    }),
  });

  const result = await handleProviderInferenceState({
    ...baseOptions(deps),
    fresh: true,
    sandboxName: "draft-hermes",
    agent: { name: "hermes" },
  });

  expect(result.sandboxName).toBe("confirmed-hermes");
  expect(retiredSandboxNames).toEqual(["confirmed-hermes"]);
  expect(events).toEqual(["retire", "resolve"]);
});
