// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type SessionUpdates } from "../../../state/onboard-session";
import type { ServingProfileProvenance } from "../../../inference/serving/types";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

const llamaCppProfile: ServingProfileProvenance = {
  schemaVersion: 1,
  catalogDigest: `sha256:${"a".repeat(64)}`,
  preset: {
    id: "llama-cpp.n1x.qwen",
    digest: `sha256:${"b".repeat(64)}`,
    displayName: "N1x Qwen",
    supportState: "experimental",
  },
  recipe: {
    id: "llama-cpp.qwen.n1x.v1",
    digest: `sha256:${"c".repeat(64)}`,
    backend: "install-llama-cpp",
  },
  model: { id: "nvidia/Qwen", revision: "revision-1" },
  runtimeImage: "example.invalid/llama.cpp@sha256:fixture",
  estimatedImageDownloadBytes: 2048,
  estimatedModelDownloadBytes: 1024,
};

describe("handleProviderInferenceState managed llama.cpp resume", () => {
  it.each([
    { label: "normal resume", authoritativeResumeConfig: false },
    { label: "authoritative rebuild", authoritativeResumeConfig: true },
  ])(
    "recovers the exact runtime before $label skips provider selection (#8144)",
    async ({ authoritativeResumeConfig }) => {
      const session = createSession({
        sandboxName: "spark-agent",
        provider: "llama-cpp-local",
        model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF",
        endpointUrl: "http://host.openshell.internal:8081/v1",
        credentialEnv: "LLAMA_CPP_API_KEY",
        preferredInferenceApi: "openai-completions",
        sandboxPromptProgress: {
          sandboxName: true,
          webSearch: false,
          messaging: false,
          resourceProfile: false,
        },
      });
      session.steps.provider_selection.status = authoritativeResumeConfig ? "pending" : "complete";
      const recoverManagedLlamaCpp = vi.fn(async () => true);
      const { deps, calls } = createDeps({
        ensureManagedLlamaCppResumeReady: recoverManagedLlamaCpp,
        isInferenceRouteReady: vi.fn(() => true),
      });

      const result = await handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        authoritativeResumeConfig,
        sandboxName: "spark-agent",
      });

      expect(recoverManagedLlamaCpp).toHaveBeenCalledOnce();
      expect(recoverManagedLlamaCpp).toHaveBeenCalledWith(
        "llama-cpp-local",
        "spark-agent",
      );
      expect(recoverManagedLlamaCpp.mock.invocationCallOrder[0]).toBeLessThan(
        calls.recoverProvider.mock.invocationCallOrder[0]!,
      );
      expect(recoverManagedLlamaCpp.mock.invocationCallOrder[0]).toBeLessThan(
        calls.skipped.mock.invocationCallOrder[0]!,
      );
      expect(calls.setupNim).not.toHaveBeenCalled();
      expect(calls.setupInference).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        sandboxName: "spark-agent",
        provider: "llama-cpp-local",
        model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-GGUF",
      });
    },
  );

  it("persists a fresh managed llama.cpp recipe through provider and inference completion", async () => {
    const { deps, calls } = createDeps({
      setupNim: vi.fn(async () => ({
        ...baseSelection,
        provider: "llama-cpp-local",
        model: "qwen3.6-35b-a3b",
        endpointUrl: "http://host.openshell.internal:8081/v1",
        credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
        preferredInferenceApi: "openai-completions",
        servingProfileProvenance: llamaCppProfile,
      })),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, createSession()),
      sandboxName: "n1x-agent",
    });

    const persistedUpdates = calls.complete.mock.calls.map(
      ([, updates]) => updates as SessionUpdates,
    );
    expect(persistedUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "llama-cpp-local",
          model: "qwen3.6-35b-a3b",
          servingProfileProvenance: llamaCppProfile,
        }),
      ]),
    );
    expect(persistedUpdates.at(-1)).toMatchObject({
      servingProfileProvenance: llamaCppProfile,
    });
  });
});
