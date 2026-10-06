// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { runRefresh } from "./provider-placeholder-refresh-fixture";

vi.setConfig({ maxConcurrency: 4 });

describe.concurrent("native inference credential placeholder refresh", () => {
  it.each([
    "NVIDIA_INFERENCE_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
  ])("keeps issued native %s handles in the environment", async (key) => {
    const config = { models: { providers: { inference: { apiKey: `\${${key}}` } } } };
    const run = await runRefresh(config, { [key]: `openshell:resolve:env:v7_${key}` }, true);
    expect(run.result.status).toBe(0);
    expect(run.config).toEqual(config);
  });

  it.each(["", "raw-native-credential-canary", "openshell:resolve:env:NVIDIA_INFERENCE_API_KEY"])(
    "refuses a native runtime credential without issued identity %s",
    async (value) => {
      const config = {
        models: { providers: { inference: { apiKey: "${NVIDIA_INFERENCE_API_KEY}" } } },
      };
      const run = await runRefresh(config, { NVIDIA_INFERENCE_API_KEY: value }, true);
      expect(run.result.status).not.toBe(0);
      expect(run.config).toEqual(config);
      expect(run.result.stderr).toContain(
        "Native inference requires an issued OpenShell credential handle",
      );
      expect(run.result.stderr).not.toContain("raw-native-credential-canary");
    },
  );
});
