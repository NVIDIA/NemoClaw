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
      failure: null,
      inference: { provider: "nvidia-prod", model: "nvidia/model" },
      output: "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/model",
      status: 0,
    });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("falls back to legacy inference get when grouped lookup is unavailable", () => {
    const capture = vi.fn().mockReturnValueOnce({ status: 1, output: "" }).mockReturnValueOnce({
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

  it("does not query an unscoped gateway after a named non-default lookup fails (#10671)", () => {
    const capture = vi.fn().mockReturnValue({ status: 1, output: "" });

    expect(getLiveGatewayInference(capture, { gatewayName: "nemoclaw-19090" })).toMatchObject({
      failure: "exit",
      inference: null,
      status: 1,
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      ["inference", "get", "-g", "nemoclaw-19090"],
      { ignoreError: true, timeout: undefined },
    );
  });

  it.each([
    { label: "heading-free", output: "unexpected format" },
    { label: "heading with unknown fields", output: "Gateway inference:\n  Unexpected: value" },
  ] as const)("classifies $label successful output as a lookup failure (#10671)", ({ output }) => {
    const capture = vi.fn().mockReturnValue({ status: 0, output });

    expect(getLiveGatewayInference(capture, { gatewayName: "nemoclaw-19090" })).toMatchObject({
      failure: "output",
      inference: null,
      status: 0,
    });
  });

  it.each([
    { label: "provider-only", output: "Gateway inference:\n  Provider: nvidia-prod" },
    { label: "model-only", output: "Gateway inference:\n  Model: nvidia/model" },
  ] as const)("classifies $label gateway output as a lookup failure (#10671)", ({ output }) => {
    const capture = vi.fn().mockReturnValue({ status: 0, output });

    expect(getLiveGatewayInference(capture, { gatewayName: "nemoclaw-19090" })).toMatchObject({
      failure: "output",
      inference: null,
      status: 0,
    });
  });

  it("recognizes the legacy unconfigured inference section after fallback (#10671)", () => {
    const capture = vi
      .fn()
      .mockReturnValueOnce({ status: 1, output: "" })
      .mockReturnValueOnce({ status: 0, output: "Inference:\n\n  Not configured" });

    expect(getLiveGatewayInference(capture)).toMatchObject({
      failure: null,
      inference: null,
      status: 0,
    });
    expect(capture.mock.calls.map(([args]) => args)).toEqual([
      ["inference", "get", "-g", "nemoclaw"],
      ["inference", "get"],
    ]);
  });
});
