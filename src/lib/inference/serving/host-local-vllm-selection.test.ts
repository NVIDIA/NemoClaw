// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeCapabilityPreflight, type VllmProfile } from "../vllm.js";
import {
  HOST_LOCAL_VLLM_LIFECYCLE_REF,
  HOST_LOCAL_VLLM_MATERIALIZER_REF,
  VLLM_FIXED_AUTHENTICATED_INSTALL_POLICY_REF,
} from "./adapter-registry.js";
import {
  hostLocalVllmGpuMemoryUtilization,
  hostLocalVllmModelArguments,
} from "./host-local-vllm-materialization.js";
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
      serve: {
        ...spec.serve,
        directInstall: {
          authentication: "none",
          fixedArguments: false,
          catalogReceipt: false,
        },
      },
    },
  } satisfies HostLocalInferenceServingRecipe;
  const preset = {
    ...selection.preset,
    spec: {
      ...selection.preset.spec,
      plan: {
        ...selection.preset.spec.plan,
        installPolicyRef: VLLM_FIXED_AUTHENTICATED_INSTALL_POLICY_REF,
      },
    },
  };
  return { ...selection, selection: "explicit", preset, recipe };
}

function baseProfile(): VllmProfile {
  return {
    name: "DGX Spark",
    platform: "spark",
    architecture: "arm64",
    image: `example.invalid/vllm@sha256:${"a".repeat(64)}`,
    imageDownloadSizeBytes: 1,
    defaultModel: {} as never,
    containerName: "nemoclaw-vllm",
    dockerRunFlags: ["--gpus", "all"],
    pullTimeoutSec: 1,
    loadTimeoutSec: 1,
  };
}

function recipeWithGpuMemoryUtilization(
  ...values: Array<string | number | boolean>
): HostLocalInferenceServingRecipe {
  const recipe = hostLocalSelection().recipe;
  return {
    ...recipe,
    spec: {
      ...recipe.spec,
      serve: {
        ...recipe.spec.serve,
        arguments: [
          ...recipe.spec.serve.arguments.filter(
            ({ name }) => name !== "--gpu-memory-utilization",
          ),
          ...values.map((value) => ({ name: "--gpu-memory-utilization", value })),
        ],
      },
    },
  };
}

describe("host-local vLLM GPU memory materialization", () => {
  it.each([
    [0.75, 0.75],
    ["0.75", 0.75],
    ["1.0", 1],
  ])("accepts the decimal value %s", (value, expected) => {
    const recipe = recipeWithGpuMemoryUtilization(value);
    expect(hostLocalVllmGpuMemoryUtilization(recipe)).toBe(expected);
    expect(hostLocalVllmModelArguments(recipe)).toContain(String(expected));
  });

  it.each([
    ["boolean", true],
    ["hexadecimal string", "0x1"],
    ["non-canonical decimal string", ".75"],
    ["zero", 0],
    ["out-of-range value", 1.01],
  ])("rejects a %s", (_label, value) => {
    const recipe = recipeWithGpuMemoryUtilization(value);
    expect(() => hostLocalVllmGpuMemoryUtilization(recipe)).toThrow(
      "has no valid --gpu-memory-utilization",
    );
    expect(() => hostLocalVllmModelArguments(recipe)).toThrow(
      "has no valid --gpu-memory-utilization",
    );
  });

  it("rejects duplicate utilization arguments", () => {
    const recipe = recipeWithGpuMemoryUtilization(0.75, 0.8);

    expect(() =>
      hostLocalVllmGpuMemoryUtilization(recipe),
    ).toThrow("has duplicate --gpu-memory-utilization arguments");
    expect(() => hostLocalVllmModelArguments(recipe)).toThrow(
      "has duplicate --gpu-memory-utilization arguments",
    );
  });
});

describe("host-local vLLM selection", () => {
  beforeEach(() => mocks.resolveManagedInferenceServing.mockReset());

  it("resolves an explicit preset into the catalog-derived Spark profile", () => {
    const selection = hostLocalSelection();
    const gpuMemoryUtilization = Number(
      selection.recipe.spec.serve.arguments.find(
        ({ name }) => name === "--gpu-memory-utilization",
      )?.value,
    );
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
        minComputeCapability: selection.recipe.spec.runtime.minimumComputeCapability,
        minGpuMemoryBytes: selection.recipe.spec.runtime.minimumGpuMemoryBytes,
        gpuMemoryUtilization,
        servingCatalog: {
          presetDigest: selection.presetDigest,
          recipeDigest: selection.recipeDigest,
        },
      },
      model: {
        id: selection.recipe.spec.model.id,
        runtime: {
          minComputeCapability: selection.recipe.spec.runtime.minimumComputeCapability,
          minGpuMemoryBytes: selection.recipe.spec.runtime.minimumGpuMemoryBytes,
          gpuMemoryUtilization,
        },
      },
    });
    expect(mocks.resolveManagedInferenceServing).toHaveBeenCalledOnce();
    expect(mocks.resolveManagedInferenceServing).toHaveBeenCalledWith(
      expect.objectContaining({
        topologyQualifications: [],
        intent: { preset: selection.preset.metadata.id },
      }),
    );
    assert(
      result.kind === "selected",
      "expected a selected host-local profile",
    );
    expect(result.model.runtime?.dockerRunArgs).toContain(
      `type=bind,source=${path.join(os.homedir(), ".cache", "huggingface", "hub")},target=${selection.recipe.spec.runtime.modelCache.target}/hub,readonly`,
    );
    expect(result.model.runtime?.dockerRunArgs?.join("\n")).not.toContain(
      `source=${path.join(os.homedir(), ".cache", "huggingface")},target=`,
    );
    expect(result.model.serveEnv).toMatchObject({
      HF_HOME: selection.recipe.spec.runtime.modelCache.target,
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
    });
    expect(result.model).toMatchObject({
      fixedServeCommand: true,
      managedBearerAuth: true,
    });
    expect(
      computeCapabilityPreflight(
        result.model,
        [1],
        result.profile.minComputeCapability,
      ),
    ).toMatchObject({ ok: false });
  });

  it("routes a direct model slug through the same readiness resolver", () => {
    const selection = hostLocalSelection();
    mocks.resolveManagedInferenceServing.mockReturnValue(selection);

    const result = resolveHostLocalVllmSelection(baseProfile(), {
      NEMOCLAW_VLLM_MODEL: selection.recipe.spec.model.environmentValue,
    });

    expect(result).toMatchObject({
      kind: "selected",
      presetId: selection.preset.metadata.id,
    });
    expect(mocks.resolveManagedInferenceServing).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: {
          provider: "vllm",
          vllmModel: selection.recipe.spec.model.environmentValue,
        },
      }),
    );
  });

  it("uses provider-scoped automatic resolution for non-interactive defaults", () => {
    const selection = hostLocalSelection();
    mocks.resolveManagedInferenceServing.mockReturnValue(selection);

    expect(
      resolveHostLocalVllmSelection(baseProfile(), {}, { automatic: true }),
    ).toMatchObject({
      kind: "selected",
    });
    expect(mocks.resolveManagedInferenceServing).toHaveBeenCalledWith(
      expect.objectContaining({ intent: { provider: "vllm" } }),
    );
  });

  it.each([
    [{ NEMOCLAW_VLLM_EXTRA_ARGS_JSON: '["--max-num-seqs","2"]' }],
    [
      {
        NEMOCLAW_VLLM_MODEL: "qwen3.6-35b-a3b-nvfp4",
        NEMOCLAW_VLLM_EXTRA_ARGS_JSON: '["--max-model-len","32768"]',
      },
    ],
    [{ NEMOCLAW_VLLM_EXTRA_ARGS_JSON: "[]" }],
  ])("defers operator-owned serve arguments to the established installer", (env) => {
    expect(
      resolveHostLocalVllmSelection(baseProfile(), env, { automatic: true }),
    ).toEqual({ kind: "not-selected" });
    expect(mocks.resolveManagedInferenceServing).not.toHaveBeenCalled();
  });

  it.each([
    ["NEMOCLAW_VLLM_MODEL", "another-model"],
    ["NEMOCLAW_VLLM_EXTRA_ARGS_JSON", '["--max-model-len","4096"]'],
  ] as const)(
    "rejects a preset conflict with %s before catalog resolution",
    (name, value) => {
      const result = resolveHostLocalVllmSelection(baseProfile(), {
        NEMOCLAW_SERVING_PRESET: "spark.host-local",
        [name]: value,
      });

      expect(result).toEqual({
        kind: "rejected",
        reason: `NEMOCLAW_SERVING_PRESET conflicts with ${name}`,
      });
      expect(mocks.resolveManagedInferenceServing).not.toHaveBeenCalled();
    },
  );
});
