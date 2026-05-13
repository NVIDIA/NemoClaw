// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
}));

vi.mock("../inference/local", () => ({
  DEFAULT_OLLAMA_MODEL: "llama3.1",
}));

import { runInferenceGet, type InferenceGetDeps } from "./inference-get";

function createDeps(output: string, status = 0): InferenceGetDeps & {
  log: ReturnType<typeof vi.fn>;
  captureOpenshell: ReturnType<typeof vi.fn>;
} {
  const captureOpenshell = vi.fn(() => ({ status, output }));
  const log = vi.fn();
  return {
    captureOpenshell: captureOpenshell as unknown as InferenceGetDeps["captureOpenshell"] &
      ReturnType<typeof vi.fn>,
    log: log as unknown as InferenceGetDeps["log"] & ReturnType<typeof vi.fn>,
  };
}

describe("runInferenceGet", () => {
  it("prints the live provider and model", async () => {
    const deps = createDeps("Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/model\n");

    await expect(runInferenceGet({}, deps)).resolves.toEqual({
      provider: "nvidia-prod",
      model: "nvidia/model",
    });

    expect(deps.captureOpenshell).toHaveBeenCalledWith(
      ["inference", "get", "-g", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(deps.log.mock.calls.map(([line]) => line)).toEqual([
      "Provider: nvidia-prod",
      "Model:    nvidia/model",
    ]);
  });

  it("supports JSON output", async () => {
    const deps = createDeps("Gateway inference:\n  Provider: openai-api\n  Model: gpt-5.4\n");

    await runInferenceGet({ json: true }, deps);

    expect(JSON.parse(deps.log.mock.calls[0][0])).toEqual({
      provider: "openai-api",
      model: "gpt-5.4",
    });
  });

  it("fails when no route is configured", async () => {
    const deps = createDeps("Gateway inference:\n\n  Not configured\n");

    await expect(runInferenceGet({}, deps)).rejects.toThrow(/not configured/);
    expect(deps.log).not.toHaveBeenCalled();
  });
});
