// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { loadServingCatalog } from "../inference/serving/catalog-loader";
import { servingProfileProvenance } from "../inference/serving/profile-provenance";
import { resolveOnboardOptions, runOnboardCommand } from "./command";

it("keeps a recorded managed runtime provider authoritative on profile resume", async () => {
  const env: NodeJS.ProcessEnv = {};
  const catalog = loadServingCatalog();
  const preset = catalog.presets.find(({ spec }) => spec.plan.backend === "install-llama-cpp")!;
  const recorded = servingProfileProvenance(catalog, preset.metadata.id);

  await runOnboardCommand({
    flags: { resume: true },
    env,
    loadServingCatalog: () => catalog,
    loadSession: () => ({ servingProfileProvenance: recorded }) as never,
    runOnboard: async () => {
      expect(env.NEMOCLAW_SERVING_PRESET).toBe(recorded.preset.id);
      expect(env.NEMOCLAW_PROVIDER).toBeUndefined();
    },
  });

  expect(env.NEMOCLAW_SERVING_PRESET).toBeUndefined();
  expect(env.NEMOCLAW_PROVIDER).toBeUndefined();
});

it("rejects a recipe override that differs from recorded managed resume authority", () => {
  const catalog = loadServingCatalog();
  const preset = catalog.presets.find(({ spec }) => spec.plan.backend === "install-llama-cpp")!;
  const recorded = servingProfileProvenance(catalog, preset.metadata.id);

  expect(() =>
    resolveOnboardOptions(
      { resume: true },
      {
        env: { NEMOCLAW_LLAMACPP_RECIPE: "llama-cpp.different.v1" },
        loadServingCatalog: () => catalog,
        loadSession: () => ({ servingProfileProvenance: recorded }),
        error: () => undefined,
        exit: (code) => {
          throw new Error(`exit:${String(code)}`);
        },
      },
    ),
  ).toThrow("exit:1");
});
