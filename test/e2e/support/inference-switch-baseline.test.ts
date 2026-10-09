// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";
import { prepareInferenceSetRoute } from "../../../src/lib/actions/inference-set-route-containment.ts";

vi.mock("../fixtures/e2e-test.ts", async () => ({
  expect: (await import("vitest")).expect,
  test: vi.fn(),
}));

afterEach(() => vi.unstubAllEnvs());

it("matches retained native Hermes metadata from the real same-provider route preparation", async () => {
  vi.resetModules();
  vi.stubEnv("NEMOCLAW_SWITCH_PROVIDER", "nvidia-prod");
  vi.stubEnv("NEMOCLAW_SWITCH_INFERENCE_API", "openai-completions");
  const { expectedHermesRegistryMetadata } =
    await import("../live/hermes-inference-switch.test.ts");
  const baseline = {
    name: "hermes-switch",
    agent: "hermes",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    provider: "nvidia-prod",
    model: "nvidia/baseline",
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    preferredInferenceApi: "openai-completions",
  };
  const prepared = prepareInferenceSetRoute({
    entry: baseline,
    sandboxName: baseline.name,
    provider: "nvidia-prod",
    model: "nvidia/nemotron-3-super-120b-a12b",
    customRoute: {},
    session: null,
    sandboxes: [baseline],
  });
  const expected = expectedHermesRegistryMetadata(null);
  expect(expected).toEqual({
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    preferredInferenceApi: "openai-completions",
  });
  expect(prepared.preliminaryRegistryMetadata).toMatchObject(expected);
});

it("keeps explicit Hermes Anthropic metadata independent of the native baseline", async () => {
  vi.resetModules();
  vi.stubEnv("NEMOCLAW_SWITCH_PROVIDER", "compatible-anthropic-endpoint");
  vi.stubEnv("NEMOCLAW_SWITCH_INFERENCE_API", "anthropic-messages");
  const { expectedHermesRegistryMetadata } =
    await import("../live/hermes-inference-switch.test.ts");
  const endpoint = "http://host.openshell.internal:19120/v1";
  expect(expectedHermesRegistryMetadata(endpoint)).toEqual({
    endpointUrl: endpoint,
    credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
    preferredInferenceApi: "openai-completions",
  });
});
