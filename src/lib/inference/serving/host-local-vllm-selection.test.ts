// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VllmProfile } from "../vllm.js";
import {
  HOST_LOCAL_VLLM_LIFECYCLE_REF,
  HOST_LOCAL_VLLM_MATERIALIZER_REF,
} from "./adapter-registry.js";
import { resolveHostLocalVllmSelection } from "./host-local-vllm-selection.js";
import { fixtureManagedClusterSelection } from "./managed-cluster-fixture.test-support.js";
import type {
  HostLocalInferenceServingRecipe,
  ManagedInferenceResolution,
  ResolvedHostLocalInferenceSelection,
} from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveManagedInferenceServing: vi.fn<() => ManagedInferenceResolution>(),
}));

vi.mock("./resolver.js", () => ({
  resolveManagedInferenceServing: mocks.resolveManagedInferenceServing,
}));

function hostLocalSelection(): ResolvedHostLocalInferenceSelection {
  const managed = fixtureManagedClusterSelection();
  const { topologyQualification: _topology, ...selection } = managed;
  const { bindings: _bindings, ...spec } = managed.recipe.spec;
  const recipe = {
    ...managed.recipe,
    spec: {
      ...spec,
      backend: "vllm",
      execution: {
        materializerRef: HOST_LOCAL_VLLM_MATERIALIZER_REF,
        lifecycleRef: HOST_LOCAL_VLLM_LIFECYCLE_REF,
      },
    },
  } satisfies HostLocalInferenceServingRecipe;
  return { ...selection, selection: "explicit", recipe };
}

function baseProfile(): VllmProfile {
  return {
    name: "DGX Spark",
    platform: "spark",
    image: `example.invalid/vllm@sha256:${"a".repeat(64)}`,
    imageDownloadSizeBytes: 1,
    defaultModel: {} as never,
    containerName: "nemoclaw-vllm",
    dockerRunFlags: ["--gpus", "all"],
    pullTimeoutSec: 1,
    loadTimeoutSec: 1,
  };
}

describe("host-local vLLM selection", () => {
  beforeEach(() => mocks.resolveManagedInferenceServing.mockReset());

  it("resolves an explicit preset into the catalog-derived Spark profile", () => {
    const selection = hostLocalSelection();
    mocks.resolveManagedInferenceServing.mockReturnValue(selection);

    const result = resolveHostLocalVllmSelection(baseProfile(), {
      NEMOCLAW_SERVING_PRESET: selection.preset.metadata.id,
    });

    expect(result).toMatchObject({
      kind: "selected",
      presetId: selection.preset.metadata.id,
      recipeId: selection.recipe.metadata.id,
      profile: {
        image: selection.recipe.spec.runtime.image,
        servingCatalog: {
          presetDigest: selection.presetDigest,
          recipeDigest: selection.recipeDigest,
        },
      },
      model: { id: selection.recipe.spec.model.id },
    });
    expect(mocks.resolveManagedInferenceServing).toHaveBeenCalledOnce();
    expect(mocks.resolveManagedInferenceServing).toHaveBeenCalledWith(
      expect.objectContaining({
        topologyQualifications: [],
        intent: { preset: selection.preset.metadata.id },
      }),
    );
  });

  it.each([
    ["NEMOCLAW_VLLM_MODEL", "another-model"],
    ["NEMOCLAW_VLLM_EXTRA_ARGS_JSON", '["--max-model-len","4096"]'],
  ] as const)("rejects a preset conflict with %s before catalog resolution", (name, value) => {
    const result = resolveHostLocalVllmSelection(baseProfile(), {
      NEMOCLAW_SERVING_PRESET: "spark.host-local",
      [name]: value,
    });

    expect(result).toEqual({
      kind: "rejected",
      reason: `NEMOCLAW_SERVING_PRESET conflicts with ${name}`,
    });
    expect(mocks.resolveManagedInferenceServing).not.toHaveBeenCalled();
  });
});
