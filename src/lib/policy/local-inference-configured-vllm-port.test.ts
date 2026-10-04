// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

vi.mock("../core/ports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/ports")>()),
  VLLM_PORT: 19_000,
}));

import { loadPreset } from "./index";

describe("configured local-inference vLLM policy port", () => {
  it("materializes NEMOCLAW_VLLM_PORT without changing other provider ports", () => {
    const content = loadPreset("local-inference");
    const document = YAML.parse(content ?? "") as {
      network_policies: { local_inference: { endpoints: Array<{ port: number }> } };
    };

    expect(document.network_policies.local_inference.endpoints.map(({ port }) => port)).toEqual([
      8081, 11434, 11435, 19000,
    ]);
  });
});
