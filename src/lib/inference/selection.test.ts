// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  serializedHostLocalInferenceReceipt,
  serializedOllamaHostLocalInferenceReceipt,
} from "../../../test/helpers/host-local-inference-receipt";
import {
  isPersistedHermesPortableSharedLocalInferenceRoute,
  isPersistedPiSharedLocalInferenceRoute,
} from "./native-local/contract";
import {
  getEffectiveReasoningEffort,
  hasLegacySharedLocalInferenceRoute,
  normalizeInferenceSelection,
} from "./selection";

describe("published Pi shared local route", () => {
  const recorded = {
    agent: "pi",
    provider: "ollama-local",
    model: "qwen3:8b",
    endpointUrl: "http://host.openshell.internal:11435/v1",
    createdAt: "2026-09-01T00:00:00Z",
  };

  it("recognizes only the exact persisted selection", () => {
    expect(isPersistedPiSharedLocalInferenceRoute(recorded, recorded)).toBe(true);
    expect(isPersistedPiSharedLocalInferenceRoute(recorded, { ...recorded, model: "other" })).toBe(
      false,
    );
    expect(
      isPersistedPiSharedLocalInferenceRoute(recorded, {
        ...recorded,
        endpointUrl: "http://other-host:11435/v1",
      }),
    ).toBe(false);
  });

  it("rejects pending, unpublished, or attached selections", () => {
    expect(
      isPersistedPiSharedLocalInferenceRoute(
        { ...recorded, pendingRouteReservation: true },
        recorded,
      ),
    ).toBe(false);
    expect(
      isPersistedPiSharedLocalInferenceRoute({
        ...recorded,
        nativeLocalProviderAttachment: {},
      }),
    ).toBe(false);
    expect(isPersistedPiSharedLocalInferenceRoute({ ...recorded, createdAt: null })).toBe(false);
  });
});

describe("published Portable Hermes shared local route", () => {
  const recorded = {
    agent: "hermes",
    portableLifecycleProfile: "hermes" as const,
    provider: "ollama-local",
    model: "qwen3-vl:4b",
    endpointUrl: "https://inference.local/v1",
    hostLocalInferenceReceipt: serializedOllamaHostLocalInferenceReceipt("qwen3-vl:4b"),
  };

  it("recognizes a published Portable Hermes shared Ollama route and excludes it from legacy shared local routes", () => {
    expect(isPersistedHermesPortableSharedLocalInferenceRoute(recorded, recorded)).toBe(true);
    expect(hasLegacySharedLocalInferenceRoute(recorded)).toBe(false);
    expect(
      isPersistedHermesPortableSharedLocalInferenceRoute(recorded, { ...recorded, model: "other" }),
    ).toBe(false);
    expect(
      isPersistedHermesPortableSharedLocalInferenceRoute(recorded, {
        ...recorded,
        endpointUrl: "http://host.openshell.internal:11434/v1",
      }),
    ).toBe(false);
  });

  it("rejects Hermes selections that are non-Portable, pending, attached, or lack a matching Ollama receipt", () => {
    const nonPortable = { ...recorded, portableLifecycleProfile: undefined };
    expect(isPersistedHermesPortableSharedLocalInferenceRoute(nonPortable, recorded)).toBe(false);
    expect(hasLegacySharedLocalInferenceRoute(nonPortable)).toBe(true);
    expect(
      isPersistedHermesPortableSharedLocalInferenceRoute(
        { ...recorded, pendingRouteReservation: true },
        recorded,
      ),
    ).toBe(false);
    expect(
      isPersistedHermesPortableSharedLocalInferenceRoute(
        { ...recorded, hostLocalInferenceReceipt: null },
        recorded,
      ),
    ).toBe(false);
    expect(
      isPersistedHermesPortableSharedLocalInferenceRoute(
        {
          ...recorded,
          hostLocalInferenceReceipt: '{"schemaVersion":2,"providerId":"podman","service":"ollama"}',
        },
        recorded,
      ),
    ).toBe(false);
    expect(
      isPersistedHermesPortableSharedLocalInferenceRoute(
        {
          ...recorded,
          hostLocalInferenceReceipt: serializedHostLocalInferenceReceipt("ollama"),
        },
        recorded,
      ),
    ).toBe(false);
    expect(
      isPersistedHermesPortableSharedLocalInferenceRoute(
        {
          ...recorded,
          hostLocalInferenceReceipt: serializedOllamaHostLocalInferenceReceipt("other-model:8b"),
        },
        recorded,
      ),
    ).toBe(false);
    expect(
      isPersistedHermesPortableSharedLocalInferenceRoute({
        ...recorded,
        nativeLocalProviderAttachment: {},
      }),
    ).toBe(false);
  });
});

describe("normalizeInferenceSelection", () => {
  it("persists recognized endpoint provenance only with a recorded endpoint", () => {
    expect(
      normalizeInferenceSelection({
        endpointUrl: "https://inference.example/v1",
        endpointSource: "onboard",
      }).endpointSource,
    ).toBe("onboard");
    expect(
      normalizeInferenceSelection({
        endpointUrl: "https://inference.example/v1",
        endpointSource: "inference-set",
      }).endpointSource,
    ).toBe("inference-set");
    expect(
      normalizeInferenceSelection({
        endpointUrl: "https://inference.example/v1",
        endpointSource: "forged",
      } as never).endpointSource,
    ).toBeNull();
    expect(
      normalizeInferenceSelection({ endpointUrl: null, endpointSource: "onboard" }).endpointSource,
    ).toBeNull();
  });

  it("persists canonical compatible-endpoint reasoning values", () => {
    expect(
      normalizeInferenceSelection({
        provider: "compatible-endpoint",
        compatibleEndpointReasoning: " TRUE ",
      }).compatibleEndpointReasoning,
    ).toBe("true");
    expect(
      normalizeInferenceSelection({
        provider: "compatible-endpoint",
        compatibleEndpointReasoning: "false",
      }).compatibleEndpointReasoning,
    ).toBe("false");
  });

  it("rejects malformed reasoning values", () => {
    expect(
      normalizeInferenceSelection({
        provider: "compatible-endpoint",
        compatibleEndpointReasoning: "yes",
      }).compatibleEndpointReasoning,
    ).toBeNull();
  });

  it("clears reasoning state for non-compatible providers", () => {
    expect(
      normalizeInferenceSelection({
        provider: "nvidia-prod",
        compatibleEndpointReasoning: "true",
      }).compatibleEndpointReasoning,
    ).toBeNull();
  });

  it.each([
    ["high", "high"],
    [null, "endpoint-default"],
  ] as const)(
    "describes the effective OpenAI Completions effort (%s) (#7659)",
    (stored, expected) => {
      expect(
        getEffectiveReasoningEffort({
          provider: "compatible-endpoint",
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoningEffort: stored,
        }),
      ).toBe(expected);
    },
  );

  it("does not report reasoning effort for routes where it does not apply", () => {
    expect(
      getEffectiveReasoningEffort({
        provider: "compatible-endpoint",
        preferredInferenceApi: "openai-responses",
        compatibleEndpointReasoningEffort: "high",
      }),
    ).toBeNull();
  });
});
