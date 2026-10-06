// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  captureModelSelectionSnapshot,
  matchingModelSelectionSnapshot,
  parseModelSelectionSnapshot,
} from "./model-selection";

const route = {
  provider: "nvidia-endpoints",
  model: "nvidia/nemotron-3-ultra-550b-a55b",
  endpointUrl: "https://example.invalid/v1",
  credentialEnv: "TEST_PROVIDER_KEY",
  preferredInferenceApi: "openai-completions",
  nimContainer: null,
  modelSelectionProvenance: {
    schemaVersion: 1,
    modelSource: "provider_catalog",
    apiFamily: "openai-completions",
  },
} as const;

describe("private model selection snapshot binding", () => {
  it("preserves a bounded receipt only for the same complete route", () => {
    const snapshot = captureModelSelectionSnapshot(route);
    expect(matchingModelSelectionSnapshot(snapshot, { ...route })).toEqual(
      route.modelSelectionProvenance,
    );
    expect(snapshot).toEqual({
      schemaVersion: 1,
      routeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      selection: route.modelSelectionProvenance,
    });
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain(route.model);
    expect(encoded).not.toContain(route.endpointUrl);
    expect(encoded).not.toContain(route.credentialEnv);
  });
  it.each([
    "provider",
    "model",
    "endpointUrl",
    "credentialEnv",
    "preferredInferenceApi",
    "nimContainer",
  ] as const)("invalidates a changed %s", (field) => {
    const snapshot = captureModelSelectionSnapshot(route);
    expect(
      matchingModelSelectionSnapshot(snapshot, { ...route, [field]: "changed" }),
    ).toBeUndefined();
  });
  it("does not invent legacy source metadata or accept malformed receipts", () => {
    expect(
      captureModelSelectionSnapshot({ provider: route.provider, model: route.model }),
    ).toBeUndefined();
    const snapshot = captureModelSelectionSnapshot(route);
    expect(parseModelSelectionSnapshot({ ...snapshot, extra: true })).toBeNull();
    expect(parseModelSelectionSnapshot({ ...snapshot, routeFingerprint: "invalid" })).toBeNull();
    expect(matchingModelSelectionSnapshot(undefined, route)).toBeUndefined();
  });
});
