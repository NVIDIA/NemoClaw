// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("llama.cpp configured host port", () => {
  it("uses NEMOCLAW_LLAMACPP_PORT in host and gateway URLs", async () => {
    vi.stubEnv("NEMOCLAW_LLAMACPP_PORT", "19081");
    const contract = await import("./contract");

    expect(contract.LLAMA_CPP_PORT).toBe(19081);
    expect(contract.LLAMA_CPP_HOST_OPENAI_BASE_URL).toBe("http://127.0.0.1:19081/v1");
    expect(contract.LLAMA_CPP_GATEWAY_BASE_URL).toBe("http://host.openshell.internal:19081/v1");
  });

  it("rejects an invalid configured port", async () => {
    vi.stubEnv("NEMOCLAW_LLAMACPP_PORT", "not-a-port");
    await expect(import("./contract")).rejects.toThrow(/NEMOCLAW_LLAMACPP_PORT/u);
  });

  it("rejects a collision with another configured local-inference port", async () => {
    vi.stubEnv("NEMOCLAW_LLAMACPP_PORT", "19081");
    vi.stubEnv("NEMOCLAW_VLLM_PORT", "19081");

    await expect(import("../../core/ports")).rejects.toThrow(
      /NEMOCLAW_LLAMACPP_PORT.*conflicts with NEMOCLAW_VLLM_PORT/u,
    );
  });
});
