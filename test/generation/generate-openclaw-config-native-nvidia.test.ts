// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "../helpers/openclaw-env-fixture";

it("references the sandbox NVIDIA environment without copying a build credential", () => {
  const config = buildConfig({
    ...baseOpenClawGenerationEnv(),
    NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
    NEMOCLAW_INFERENCE_BASE_URL: "https://integrate.api.nvidia.com/v1",
    NVIDIA_INFERENCE_API_KEY: "must-not-enter-image",
  });
  expect(config.models.providers.inference.apiKey).toBe("${NVIDIA_INFERENCE_API_KEY}");
  expect(JSON.stringify(config)).not.toContain("must-not-enter-image");
});
