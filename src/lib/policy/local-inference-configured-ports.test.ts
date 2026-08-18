// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("configured local-inference policy ports", () => {
  it("materializes every host-local provider port from the environment", async () => {
    vi.stubEnv("NEMOCLAW_LLAMACPP_PORT", "19081");
    vi.stubEnv("NEMOCLAW_OLLAMA_PORT", "19434");
    vi.stubEnv("NEMOCLAW_OLLAMA_PROXY_PORT", "19435");
    vi.stubEnv("NEMOCLAW_VLLM_PORT", "19000");
    const { loadPreset } = await import("./index");
    const content = loadPreset("local-inference");
    const document = YAML.parse(content ?? "") as {
      network_policies: { local_inference: { endpoints: Array<{ port: number }> } };
    };

    expect(document.network_policies.local_inference.endpoints.map(({ port }) => port)).toEqual([
      19081, 19434, 19435, 19000,
    ]);
  }, 20_000);
});
