// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { parseTelemetryConfiguration, UNKNOWN_TELEMETRY_CONFIGURATION } from "./dimensions";
import { classifyManagedModelSelection } from "../../inference/vllm-models";
import {
  classifyDefaultModelSelection,
  modelSelectionSourceForServingProfile,
  retainModelSelectionSource,
} from "../../onboard/provider-selection";
import { parseAppliedPolicySelection, parseModelSelectionProvenance } from "./provenance";

describe("durable telemetry provenance", () => {
  it.each(["product_catalog", "provider_catalog", "custom", "local", "unknown"] as const)(
    "preserves source %s unless a managed serving profile was selected",
    (source) => {
      expect(modelSelectionSourceForServingProfile(source, false)).toBe(source);
      expect(modelSelectionSourceForServingProfile(source, true)).toBe("product_catalog");
    },
  );
  it.each(["product_catalog", "provider_catalog", "custom", "local", "unknown"] as const)(
    "retains model source %s only while the selected model is unchanged",
    (source) => {
      expect(retainModelSelectionSource(source, true)).toBe(source);
      expect(retainModelSelectionSource(source, false)).toBe("unknown");
    },
  );
  it.each([
    [false, false, false, false, "product_catalog"],
    [false, false, false, true, "unknown"],
    [false, false, true, false, "custom"],
    [false, false, true, true, "custom"],
    [false, true, false, false, "unknown"],
    [false, true, false, true, "unknown"],
    [false, true, true, false, "unknown"],
    [false, true, true, true, "unknown"],
    [true, false, false, false, "custom"],
    [true, false, false, true, "custom"],
    [true, false, true, false, "custom"],
    [true, false, true, true, "custom"],
    [true, true, false, false, "custom"],
    [true, true, false, true, "custom"],
    [true, true, true, false, "custom"],
    [true, true, true, true, "custom"],
  ] as const)(
    "preserves default-model source precedence for %s/%s/%s/%s",
    (requested, constrained, environmentOverride, recovered, expected) => {
      expect(
        classifyDefaultModelSelection({ requested, constrained, environmentOverride, recovered }),
      ).toBe(expected);
    },
  );

  it.each([
    ["custom", false, "unknown"],
    ["custom", true, "custom"],
    ["product_catalog", false, "product_catalog"],
    ["product_catalog", true, "product_catalog"],
    ["unknown", false, "unknown"],
    ["unknown", true, "unknown"],
  ] as const)(
    "preserves managed-model source without claiming recovered input was explicit %s/%s",
    (source, explicit, expected) => {
      expect(classifyManagedModelSelection(source, explicit)).toBe(expected);
    },
  );
  it.each(["restricted", "balanced", "open", "personal"] as const)(
    "accepts the verified applied policy selection %s (#10448)",
    (tier) => {
      const record = { schemaVersion: 1, source: "verified_selection", tier };
      expect(parseAppliedPolicySelection(record)).toEqual(record);
      expect(Object.isFrozen(parseAppliedPolicySelection(record))).toBe(true);
      expect(
        parseTelemetryConfiguration({
          ...UNKNOWN_TELEMETRY_CONFIGURATION,
          policyTier: tier,
          policyTierStatus: "reported",
        }),
      ).not.toBeNull();
    },
  );

  it.each([
    {},
    { schemaVersion: 2, source: "verified_selection", tier: "balanced" },
    { schemaVersion: 1, source: "authored_yaml", tier: "balanced" },
    { schemaVersion: 1, source: "verified_selection", tier: "private-tier" },
    {
      schemaVersion: 1,
      source: "verified_selection",
      tier: "balanced",
      policyPath: "/private/policy",
    },
  ])("rejects invalid or uncommitted policy provenance (#10448)", (record) => {
    expect(parseAppliedPolicySelection(record)).toBeNull();
  });

  it.each(["not_observed", "not_persisted", "invalid"] as const)(
    "requires a null policy tier when its status is %s (#10448)",
    (policyTierStatus) => {
      expect(
        parseTelemetryConfiguration({
          ...UNKNOWN_TELEMETRY_CONFIGURATION,
          policyTier: null,
          policyTierStatus,
        }),
      ).not.toBeNull();
      expect(
        parseTelemetryConfiguration({
          ...UNKNOWN_TELEMETRY_CONFIGURATION,
          policyTier: "balanced",
          policyTierStatus,
        }),
      ).toBeNull();
    },
  );

  it("rejects a reported policy tier when no value was recorded (#10448)", () => {
    expect(
      parseTelemetryConfiguration({
        ...UNKNOWN_TELEMETRY_CONFIGURATION,
        policyTierStatus: "reported",
      }),
    ).toBeNull();
  });

  it.each(["product_catalog", "provider_catalog", "custom", "local", "unknown"] as const)(
    "preserves explicit model selection source %s (#10445)",
    (modelSource) => {
      const record = { schemaVersion: 1, modelSource, apiFamily: "openai-responses" };
      expect(parseModelSelectionProvenance(record)).toEqual(record);
      expect(Object.isFrozen(parseModelSelectionProvenance(record))).toBe(true);
    },
  );

  it.each([
    { schemaVersion: 1, modelSource: "custom", apiFamily: "private-api" },
    { schemaVersion: 1, modelSource: "inference-set", apiFamily: "unknown" },
    { schemaVersion: 2, modelSource: "local", apiFamily: "unknown" },
    { schemaVersion: 1, modelSource: "custom", apiFamily: "unknown", modelId: "private-model" },
    {
      schemaVersion: 1,
      modelSource: "custom",
      apiFamily: "unknown",
      endpointUrl: "https://private.invalid",
    },
    { schemaVersion: 1, modelSource: "custom" },
  ])("rejects malformed or private model provenance (#10445)", (record) => {
    expect(parseModelSelectionProvenance(record)).toBeNull();
  });

  it("rejects provenance accessors without reading their values (#10435)", () => {
    const read = vi.fn(() => "custom");
    const record = { schemaVersion: 1, apiFamily: "unknown" };
    Object.defineProperty(record, "modelSource", { enumerable: true, get: read });
    expect(parseModelSelectionProvenance(record)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects inherited policy authority (#10448)", () => {
    const record = Object.create({
      schemaVersion: 1,
      source: "verified_selection",
      tier: "balanced",
    });
    expect(parseAppliedPolicySelection(record)).toBeNull();
  });
});
