// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  getDcodeSelectionDrift,
  getExpectedDcodeInferenceIdentity,
  normalizeDcodeModelName,
  parseDcodeInferenceIdentity,
  requiresSelectionRecreate,
  usesManagedDcodeIdentity,
} from "./dcode-selection-drift";

function identity(
  overrides: Partial<Record<"Route" | "Provider" | "Model" | "Endpoint", string>> = {},
) {
  return [
    "Sandbox:  alpha",
    `Route:    ${overrides.Route ?? "inference"}`,
    `Provider: ${overrides.Provider ?? "nvidia-prod"}`,
    `Model:    ${overrides.Model ?? "openai:nvidia/nemotron-3-super-120b-a12b"}`,
    `Endpoint: ${overrides.Endpoint ?? "https://inference.local/v1"}`,
    "Runtime:  Deep Agents Code (terminal)",
  ].join("\n");
}

describe("live DCode selection drift", () => {
  it("limits the managed identity contract to stock DCode images (#6311)", () => {
    expect(usesManagedDcodeIdentity("langchain-deepagents-code", null)).toBe(true);
    expect(usesManagedDcodeIdentity("langchain-deepagents-code", "/tmp/Dockerfile")).toBe(false);
    expect(usesManagedDcodeIdentity("openclaw", null)).toBe(false);
  });

  it("fails closed only for unreadable managed DCode selection (#6311)", () => {
    expect(requiresSelectionRecreate({ changed: true, unknown: true }, true)).toBe(true);
    expect(requiresSelectionRecreate({ changed: true, unknown: true }, false)).toBe(false);
    expect(requiresSelectionRecreate({ changed: true, unknown: false }, false)).toBe(true);
  });

  it("strictly parses one value for every managed identity field (#6311)", () => {
    expect(parseDcodeInferenceIdentity(identity())).toEqual({
      route: "inference",
      provider: "nvidia-prod",
      model: "openai:nvidia/nemotron-3-super-120b-a12b",
      endpoint: "https://inference.local/v1",
    });

    expect(parseDcodeInferenceIdentity(identity().replace(/^Endpoint:.*$/m, ""))).toBeNull();
    expect(parseDcodeInferenceIdentity(`${identity()}\nProvider: nvidia-prod`)).toBeNull();
    expect(parseDcodeInferenceIdentity(identity().replace(/^Model:.*$/m, "Model:"))).toBeNull();
  });

  it("mirrors generated DCode model and route identity (#6311)", () => {
    expect(normalizeDcodeModelName("  openai:model:tag  ")).toBe("model:tag");
    expect(
      getExpectedDcodeInferenceIdentity(
        "compatible-anthropic-endpoint",
        "openai:model:tag",
        "anthropic-messages",
      ),
    ).toEqual({
      route: "anthropic",
      provider: "compatible-anthropic-endpoint",
      model: "openai:model:tag",
      endpoint: "https://inference.local",
    });
  });

  it("preserves colon-bearing model IDs in expected DCode identity (#6311)", () => {
    expect(normalizeDcodeModelName("minimax/minimax-m2.5:free")).toBe("minimax/minimax-m2.5:free");
    expect(
      getExpectedDcodeInferenceIdentity("compatible-endpoint", "minimax/minimax-m2.5:free", null),
    ).toMatchObject({ model: "openai:minimax/minimax-m2.5:free" });
  });

  it("accepts only a live identity matching the requested selection (#6311)", () => {
    const runCaptureOpenshell = vi.fn(() => identity());

    expect(
      getDcodeSelectionDrift("alpha", "nvidia-prod", "nvidia/nemotron-3-super-120b-a12b", null, {
        runCaptureOpenshell,
      }),
    ).toEqual({
      changed: false,
      providerChanged: false,
      modelChanged: false,
      existingProvider: "nvidia-prod",
      existingModel: "openai:nvidia/nemotron-3-super-120b-a12b",
      unknown: false,
    });
    expect(runCaptureOpenshell).toHaveBeenCalledWith(
      ["sandbox", "exec", "-n", "alpha", "--", "dcode", "identity"],
      { ignoreError: true },
    );
  });

  it("reports provider drift for upstream, route, or endpoint changes (#6311)", () => {
    for (const output of [
      identity({ Provider: "openai-api" }),
      identity({ Route: "openai" }),
      identity({ Endpoint: "https://old.example/v1" }),
    ]) {
      expect(
        getDcodeSelectionDrift("alpha", "nvidia-prod", "nvidia/nemotron-3-super-120b-a12b", null, {
          runCaptureOpenshell: () => output,
        }),
      ).toMatchObject({
        changed: true,
        providerChanged: true,
        modelChanged: false,
        unknown: false,
      });
    }
  });

  it("reports model drift from the live DCode config (#6311)", () => {
    expect(
      getDcodeSelectionDrift("alpha", "nvidia-prod", "new-model", null, {
        runCaptureOpenshell: () => identity({ Model: "openai:old-model" }),
      }),
    ).toMatchObject({
      changed: true,
      providerChanged: false,
      modelChanged: true,
      existingModel: "openai:old-model",
      unknown: false,
    });
  });

  it.each([
    ["missing output", () => null],
    ["malformed output", () => identity().replace(/^Route:.*$/m, "Route:")],
    [
      "failed command",
      () => {
        throw new Error("sandbox unavailable");
      },
    ],
  ])("fails closed for %s (#6311)", (_name, runCaptureOpenshell) => {
    expect(
      getDcodeSelectionDrift("alpha", "nvidia-prod", "model-a", null, {
        runCaptureOpenshell,
      }),
    ).toEqual({
      changed: true,
      providerChanged: false,
      modelChanged: false,
      existingProvider: null,
      existingModel: null,
      unknown: true,
    });
  });
});
