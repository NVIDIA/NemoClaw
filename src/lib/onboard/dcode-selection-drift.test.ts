// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { normalizeManagedDcodeModelName } from "../inference/managed-dcode/identity";
import {
  createDcodeSelectionDriftReader,
  type DcodeSelectionDriftDeps,
  getDcodeSelectionDrift,
  getExpectedDcodeInferenceIdentity,
  parseDcodeInferenceIdentity,
  requiresSelectionRecreate,
  usesManagedDcodeIdentity,
} from "./dcode-selection-drift";

function driftDeps(
  runCaptureOpenshell: DcodeSelectionDriftDeps["runCaptureOpenshell"],
  requestedEndpointUrl?: string | null,
): DcodeSelectionDriftDeps {
  return {
    getGatewayName: () => "nemoclaw-18081",
    requestedEndpointUrl,
    runCaptureOpenshell,
  };
}

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
    expect(normalizeManagedDcodeModelName("  openai:model:tag  ")).toBe("model:tag");
    expect(normalizeManagedDcodeModelName("  openrouter:model:tag  ")).toBe("model:tag");
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

  it("accepts the generated OpenRouter identity (#9555)", () => {
    const output = identity({
      Provider: "openrouter",
      Model: "openrouter:nvidia/nemotron-3-ultra-550b-a55b",
    });

    expect(
      getDcodeSelectionDrift(
        "alpha",
        "openrouter-api",
        "nvidia/nemotron-3-ultra-550b-a55b",
        null,
        driftDeps(() => output),
      ),
    ).toEqual({
      changed: false,
      providerChanged: false,
      modelChanged: false,
      existingProvider: "openrouter",
      existingModel: "openrouter:nvidia/nemotron-3-ultra-550b-a55b",
      unknown: false,
    });
  });

  it("accepts the generated OpenRouter identity for its compatible endpoint (#9555)", () => {
    const output = identity({
      Provider: "openrouter",
      Model: "openrouter:nvidia/nemotron-3-ultra-550b-a55b",
    });
    const readDcodeSelectionDrift = createDcodeSelectionDriftReader(
      () => output,
      () => "nemoclaw-18081",
    );

    expect(
      readDcodeSelectionDrift(
        "alpha",
        "compatible-endpoint",
        "nvidia/nemotron-3-ultra-550b-a55b",
        null,
        "https://openrouter.ai/api/v1/",
      ),
    ).toMatchObject({
      changed: false,
      providerChanged: false,
      modelChanged: false,
      unknown: false,
    });
  });

  it.each([
    "https://openrouter.ai:8443/api/v1",
    "https://user:password@openrouter.ai/api/v1",
    "https://openrouter.ai/api/v1?route=other",
    "https://openrouter.ai/api/v1#route",
  ])("rejects a noncanonical OpenRouter-compatible endpoint: %s (#9555)", (endpointUrl) => {
    const output = identity({
      Provider: "openrouter",
      Model: "openrouter:nvidia/nemotron-3-ultra-550b-a55b",
    });
    const readDcodeSelectionDrift = createDcodeSelectionDriftReader(
      () => output,
      () => "nemoclaw-18081",
    );

    expect(
      readDcodeSelectionDrift(
        "alpha",
        "compatible-endpoint",
        "nvidia/nemotron-3-ultra-550b-a55b",
        null,
        endpointUrl,
      ),
    ).toMatchObject({
      changed: true,
      providerChanged: true,
      modelChanged: true,
      unknown: false,
    });
  });

  it("keeps ordinary compatible endpoints on the OpenAI identity (#9555)", () => {
    const output = identity({
      Provider: "compatible-endpoint",
      Model: "openai:model-a",
    });
    const readDcodeSelectionDrift = createDcodeSelectionDriftReader(
      () => output,
      () => "nemoclaw-18081",
    );

    expect(
      readDcodeSelectionDrift(
        "alpha",
        "compatible-endpoint",
        "model-a",
        null,
        "https://example.test/v1",
      ),
    ).toMatchObject({
      changed: false,
      providerChanged: false,
      modelChanged: false,
      unknown: false,
    });
  });

  it("rejects an OpenAI identity for an OpenRouter selection (#9555)", () => {
    expect(
      getDcodeSelectionDrift(
        "alpha",
        "openrouter-api",
        "nvidia/nemotron-3-ultra-550b-a55b",
        null,
        driftDeps(() => identity()),
      ),
    ).toMatchObject({
      changed: true,
      providerChanged: true,
      modelChanged: true,
      unknown: false,
    });
  });

  it("preserves colon-bearing model IDs in expected DCode identity (#6311)", () => {
    expect(normalizeManagedDcodeModelName("minimax/minimax-m2.5:free")).toBe(
      "minimax/minimax-m2.5:free",
    );
    expect(
      getExpectedDcodeInferenceIdentity("compatible-endpoint", "minimax/minimax-m2.5:free", null),
    ).toMatchObject({ model: "openai:minimax/minimax-m2.5:free" });
  });

  it("accepts only a live identity matching the requested selection (#6311)", () => {
    const runCaptureOpenshell = vi.fn(() => identity());

    expect(
      getDcodeSelectionDrift(
        "alpha",
        "nvidia-prod",
        "nvidia/nemotron-3-super-120b-a12b",
        null,
        driftDeps(runCaptureOpenshell),
      ),
    ).toEqual({
      changed: false,
      providerChanged: false,
      modelChanged: false,
      existingProvider: "nvidia-prod",
      existingModel: "openai:nvidia/nemotron-3-super-120b-a12b",
      unknown: false,
    });
    expect(runCaptureOpenshell).toHaveBeenCalledWith(
      [
        "sandbox",
        "exec",
        "--name",
        "alpha",
        "--gateway",
        "nemoclaw-18081",
        "--",
        "/usr/local/bin/dcode",
        "identity",
      ],
      { ignoreError: true },
    );
  });

  it.each([
    identity({ Provider: "openai-api" }),
    identity({ Route: "openai" }),
    identity({ Endpoint: "https://old.example/v1" }),
  ])(
    "reports provider drift for upstream, route, or endpoint changes [case %#] (#6311)",
    (output) => {
      expect(
        getDcodeSelectionDrift(
          "alpha",
          "nvidia-prod",
          "nvidia/nemotron-3-super-120b-a12b",
          null,
          driftDeps(() => output),
        ),
      ).toMatchObject({
        changed: true,
        providerChanged: true,
        modelChanged: false,
        unknown: false,
      });
    },
  );

  it("reports model drift from the live DCode config (#6311)", () => {
    expect(
      getDcodeSelectionDrift(
        "alpha",
        "nvidia-prod",
        "new-model",
        null,
        driftDeps(() => identity({ Model: "openai:old-model" })),
      ),
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
      getDcodeSelectionDrift(
        "alpha",
        "nvidia-prod",
        "model-a",
        null,
        driftDeps(runCaptureOpenshell),
      ),
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
