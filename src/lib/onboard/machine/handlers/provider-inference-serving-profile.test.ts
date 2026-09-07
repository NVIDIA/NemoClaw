// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

it("persists an automatically selected managed-serving profile with the provider step", async () => {
  const provenance = {
    schemaVersion: 1,
    catalogDigest: `sha256:${"a".repeat(64)}`,
    preset: {
      id: "llama-cpp.n1x-wsl-arm64.single.qwen3-6-35b-a3b",
      digest: `sha256:${"b".repeat(64)}`,
      displayName: "Qwen on N1x WSL",
      supportState: "experimental",
    },
    recipe: {
      id: "llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1",
      digest: `sha256:${"c".repeat(64)}`,
      backend: "install-llama-cpp",
    },
    model: { id: "Qwen/Qwen3.6-35B-A3B-GGUF", revision: "test-revision" },
    runtimeImage: "registry.test/llama-cpp@sha256:test",
    estimatedImageDownloadBytes: 1,
    estimatedModelDownloadBytes: 2,
  } as const;
  const setupNim = vi.fn(async () => ({
    ...baseSelection,
    provider: "llama-cpp-local",
    model: "qwen3.6-35b-a3b",
    endpointUrl: "http://127.0.0.1:8081/v1",
    credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
    preferredInferenceApi: "openai-completions",
    servingProfileProvenance: provenance,
  }));
  const { deps, calls } = createDeps({ setupNim });
  const session = createSession();
  calls.complete.mockResolvedValue(session);

  await handleProviderInferenceState(baseOptions(deps, session));

  expect(calls.complete).toHaveBeenCalledWith(
    "provider_selection",
    expect.objectContaining({ servingProfileProvenance: provenance }),
  );
});
