// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("./local", () => ({
  DEFAULT_OLLAMA_MODEL: "llama3.1",
}));

import { getLiveGatewayInference } from "./live";

describe("getLiveGatewayInference", () => {
  it("prefers the managed nemoclaw gateway route", () => {
    const capture = vi.fn((args: string[]) => {
      expect(args).toEqual(["inference", "get", "-g", "nemoclaw"]);
      return {
        status: 0,
        output: "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/model\n",
      };
    });

    expect(getLiveGatewayInference(capture)).toEqual({
      args: ["inference", "get", "-g", "nemoclaw"],
      inference: { provider: "nvidia-prod", model: "nvidia/model" },
      output: "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/model",
      status: 0,
    });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("falls back to legacy inference get when grouped lookup is unavailable", () => {
    const capture = vi
      .fn()
      .mockReturnValueOnce({ status: 1, output: "" })
      .mockReturnValueOnce({
        status: 0,
        output: "Gateway inference:\n  Provider: openai-api\n  Model: gpt-5.4\n",
      });

    expect(getLiveGatewayInference(capture).inference).toEqual({
      provider: "openai-api",
      model: "gpt-5.4",
    });
    expect(capture.mock.calls.map(([args]) => args)).toEqual([
      ["inference", "get", "-g", "nemoclaw"],
      ["inference", "get"],
    ]);
  });
});
