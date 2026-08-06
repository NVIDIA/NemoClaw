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

  it.each([
    ["vllm", "vllm", "vllm.host-local/v1"],
    ["llama-cpp", "install-llama-cpp", "llama-cpp.host-local/v1"],
  ] as const)("selects the disabled %s serving combination", (runtime, backend, materializer) => {
    const plan = resolveLocalModelProfilePlan(loadServingCatalog(), {
      [LOCAL_MODEL_PROFILE_ENABLED_ENV]: "1",
      [LOCAL_MODEL_PROFILE_RUNTIME_ENV]: runtime,
    });

    expect(plan).toMatchObject({
      runtime,
      preset: { spec: { selection: "disabled", plan: { backend } } },
      recipe: { spec: { backend, execution: { materializerRef: materializer } } },
    });
  });
});
