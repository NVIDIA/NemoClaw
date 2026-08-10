// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeDeps } from "./__test-helpers__/setup-nim-flow";
import { createSetupNim, type SetupNimFlowDeps } from "./setup-nim-flow";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("managed llama.cpp profile onboarding", () => {
  it("installs an interactive profile despite a different recipe environment", async () => {
    vi.stubEnv("NEMOCLAW_LLAMACPP_RECIPE", "llama-cpp.recommended.v1");
    const selectedProfile = (recipeId: string, displayName: string, model: string) =>
      ({
        preset: { metadata: { id: `${recipeId}.preset`, displayName } },
        recipe: {
          metadata: { id: recipeId, displayName },
          spec: { model: { servedName: model } },
        },
      }) as never;
    const recommended = selectedProfile(
      "llama-cpp.recommended.v1",
      "Recommended model",
      "recommended-model",
    );
    const alternate = selectedProfile(
      "llama-cpp.alternate.v1",
      "Alternate model",
      "alternate-model",
    );
    const resolveManagedLlamaCppSelection = vi.fn((env?: NodeJS.ProcessEnv) => ({
      kind: "selected" as const,
      selection:
        env?.NEMOCLAW_LLAMACPP_RECIPE === "llama-cpp.alternate.v1" ? alternate : recommended,
    }));
    const selectFromNumberedMenu = vi.fn<SetupNimFlowDeps["selectFromNumberedMenu"]>(
      (_rawChoice, _defaultIndex, options) => {
        expect(options.filter(({ key }) => key === "install-llama-cpp")).toEqual([
          {
            key: "install-llama-cpp",
            label: "Managed llama.cpp: Recommended model (recommended)",
            managedLlamaCppRecipeId: "llama-cpp.recommended.v1",
          },
          {
            key: "install-llama-cpp",
            label: "Managed llama.cpp: Alternate model",
            managedLlamaCppRecipeId: "llama-cpp.alternate.v1",
          },
        ]);
        return options.find(
          ({ managedLlamaCppRecipeId }) => managedLlamaCppRecipeId === "llama-cpp.alternate.v1",
        )!;
      },
    );
    const installManagedLlamaCpp = vi.fn(async () => ({
      ok: true as const,
      apiKey: "a".repeat(64),
      model: "alternate-model",
      receipt: { schemaVersion: 1 } as never,
    }));
    const handleLlamaCppSelection = vi.fn<SetupNimFlowDeps["handleLlamaCppSelection"]>(
      async (state, requestedModel) => {
        state.provider = "llama-cpp-local";
        state.model = requestedModel;
        state.endpointUrl = "http://127.0.0.1:8081/v1";
        state.credentialEnv = "NEMOCLAW_LLAMACPP_LOCAL_TOKEN";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        prompt: async () => "1",
        selectFromNumberedMenu,
        resolveManagedLlamaCppSelection,
        listManagedLlamaCppSelectionChoices: () => [
          { priority: 500, selection: recommended },
          { priority: 450, selection: alternate },
        ],
        installManagedLlamaCpp,
        handleLlamaCppSelection,
      }),
    );

    await expect(setupNim({ platform: "spark" } as never, "spark-agent")).resolves.toMatchObject({
      provider: "llama-cpp-local",
      model: "alternate-model",
    });
    expect(resolveManagedLlamaCppSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ NEMOCLAW_LLAMACPP_RECIPE: "llama-cpp.alternate.v1" }),
    );
    expect(resolveManagedLlamaCppSelection).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ NEMOCLAW_LLAMACPP_RECIPE: "" }),
    );
    expect(installManagedLlamaCpp).toHaveBeenCalledWith(
      alternate,
      expect.objectContaining({ sandboxName: "spark-agent" }),
    );
  });
});
