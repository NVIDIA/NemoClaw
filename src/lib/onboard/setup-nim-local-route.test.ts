// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";

import { makeDeps, makeHostState } from "./__test-helpers__/setup-nim-flow";
import type * as NimModule from "../inference/nim";
import { usesNativeLocalInferenceForAgent } from "../inference/native-local/contract";
import { createSetupNim } from "./setup-nim-flow";
import { clearNimContainerBeforeRetry } from "./setup-nim-selection";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("marks Local NIM before its container starts", async () => {
  const routeGuard = vi.fn(() => ({
    requiredModel: null,
    requiredEndpointUrl: null,
    requiredInferenceApi: null,
  }));
  const setupNim = createSetupNim(
    makeDeps({
      experimental: true,
      isNonInteractive: () => true,
      getNonInteractiveProvider: () => "nim-local",
      detectInferenceProviderHostState: () => makeHostState({ gpuNimCapable: true }),
      handleNimLocalSelection: async (_gpu, _args, state) => {
        state.provider = "vllm-local";
        state.model = "local/nim-model";
        state.assertRouteCompatible?.();
        state.nimContainer = "local-nim-container";
        return "selected";
      },
    }),
  );

  const result = await setupNim(
    { type: "nvidia", platform: "other", nimCapable: true } as never,
    "nim-sandbox",
    null,
    false,
    null,
    "nemoclaw",
    routeGuard,
  );

  expect(routeGuard).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "vllm-local", localNimSelected: true }),
  );
  expect(result.nimContainer).toBe("local-nim-container");
});

it("removes failed Local NIM before retrying as native standalone vLLM", async () => {
  let nimRunning = true;
  let menuSelections = 0;
  const removeNim = vi.fn((name: string) => {
    expect(name).toBe("local-nim-container");
    nimRunning = false;
  });
  const setupNim = createSetupNim(
    makeDeps({
      experimental: true,
      detectInferenceProviderHostState: () =>
        makeHostState({
          gpuNimCapable: true,
          vllmRunning: true,
          vllmEntries: [{ key: "vllm", label: "Local vLLM — running" }],
        }),
      selectFromNumberedMenu: (_choice, _defaultIndex, options) => {
        const key = ++menuSelections === 1 ? "nim-local" : "vllm";
        const selection = options.find((option) => option.key === key);
        expect(selection, `Missing ${key} provider option`).toBeDefined();
        return selection!;
      },
      handleNimLocalSelection: async (_gpu, _args, state) => {
        state.provider = "vllm-local";
        state.model = "local/nim-model";
        state.endpointUrl = "http://127.0.0.1:8000/v1";
        state.nimContainer = "local-nim-container";
        clearNimContainerBeforeRetry(state, removeNim);
        return "retry-selection";
      },
      handleVllmSelection: async (state) => {
        expect(nimRunning).toBe(false);
        expect(state.nimContainer).toBeNull();
        expect(state.localNimSelected).toBeUndefined();
        state.provider = "vllm-local";
        state.model = "local/standalone-vllm";
        state.endpointUrl = "http://127.0.0.1:8000/v1";
        expect(
          usesNativeLocalInferenceForAgent(
            "langchain-deepagents-code",
            state.provider,
            state.endpointUrl,
            state.localNimSelected,
          ),
        ).toBe(true);
        return "selected";
      },
    }),
  );

  const result = await setupNim(
    { type: "nvidia", platform: "other", nimCapable: true } as never,
    "nim-sandbox",
    { name: "langchain-deepagents-code" } as never,
    false,
    null,
    "nemoclaw",
  );

  expect(menuSelections).toBe(2);
  expect(removeNim).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ provider: "vllm-local", nimContainer: null });
});

it("stops onboarding and removes the owned container when Local NIM health fails", async () => {
  vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "1");
  const nim = require("../inference/nim") as typeof NimModule;
  vi.spyOn(nim, "getNimModelOptions").mockReturnValue({
    models: [{ name: "test-nim-model" }],
    usableMemoryMB: 16000,
  } as ReturnType<typeof nim.getNimModelOptions>);
  vi.spyOn(nim, "expectedServedModelId").mockReturnValue("local/test-nim-model");
  vi.spyOn(nim, "isNgcLoggedIn").mockReturnValue(true);
  vi.spyOn(nim, "pullNimImage").mockReturnValue("test-nim-image");
  vi.spyOn(nim, "containerName").mockReturnValue("local-nim-container");
  const startedNim = { name: "local-nim-container", id: "a".repeat(64) };
  vi.spyOn(nim, "startNimContainerByName").mockReturnValue(startedNim);
  vi.spyOn(nim, "waitForNimHealth").mockReturnValue(false);
  const removeNim = vi
    .spyOn(nim, "stopNimContainerByIdOrThrow")
    .mockImplementation(() => undefined);
  const adoptModel = vi.spyOn(nim, "adoptServedModelId");
  const state = {
    provider: "",
    model: null,
    endpointUrl: null,
    nimContainer: null,
    assertRouteCompatible: vi.fn(),
    revalidateSandboxIdentity: vi.fn(),
  };
  const { handleNimLocalSelection } = require("../onboard") as {
    handleNimLocalSelection: (
      gpu: unknown,
      args: {
        requestedModel: string | null;
        recoveredFromSandbox: boolean;
        recoveredModel: string | null;
      },
      state: unknown,
    ) => Promise<unknown>;
  };

  await expect(
    handleNimLocalSelection(
      { type: "nvidia", platform: "other", nimCapable: true },
      { requestedModel: null, recoveredFromSandbox: false, recoveredModel: null },
      state,
    ),
  ).rejects.toThrow("Local NVIDIA NIM failed to become healthy. Onboarding stopped.");
  expect(removeNim).toHaveBeenCalledExactlyOnceWith(startedNim.id);
  expect(state.nimContainer).toBeNull();
  expect(adoptModel).not.toHaveBeenCalled();
});
