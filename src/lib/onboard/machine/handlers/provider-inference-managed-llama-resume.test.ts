// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

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

});
