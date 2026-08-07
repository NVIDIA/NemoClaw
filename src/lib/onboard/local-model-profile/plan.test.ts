// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadServingCatalog } from "../../inference/serving/catalog-loader";
import {
  LOCAL_MODEL_PROFILE_ENABLED_ENV,
  LOCAL_MODEL_PROFILE_RUNTIME_ENV,
  resolveLocalModelProfilePlan,
} from "./plan";

describe("local model profile selection", () => {
  it("returns no plan when the feature gate and runtime are absent", () => {
    expect(resolveLocalModelProfilePlan(loadServingCatalog(), {})).toBeNull();
  });

  it("rejects a runtime selection when the feature gate is disabled", () => {
    expect(() =>
      resolveLocalModelProfilePlan(loadServingCatalog(), {
        [LOCAL_MODEL_PROFILE_RUNTIME_ENV]: "vllm",
      }),
    ).toThrow(`${LOCAL_MODEL_PROFILE_ENABLED_ENV}=1`);
  });

  it("selects the disabled vLLM serving combination", () => {
    const plan = resolveLocalModelProfilePlan(loadServingCatalog(), {
      [LOCAL_MODEL_PROFILE_ENABLED_ENV]: "1",
      [LOCAL_MODEL_PROFILE_RUNTIME_ENV]: "vllm",
    });

    expect(plan).toMatchObject({
      runtime: "vllm",
      preset: { spec: { selection: "disabled", plan: { backend: "vllm" } } },
      recipe: { spec: { backend: "vllm", execution: { materializerRef: "vllm.host-local/v1" } } },
    });
  });

  it("rejects the retired hidden llama.cpp runtime selection", () => {
    expect(() =>
      resolveLocalModelProfilePlan(loadServingCatalog(), {
        [LOCAL_MODEL_PROFILE_ENABLED_ENV]: "1",
        [LOCAL_MODEL_PROFILE_RUNTIME_ENV]: "llama-cpp",
      }),
    ).toThrow("must be 'vllm'");
  });
});
