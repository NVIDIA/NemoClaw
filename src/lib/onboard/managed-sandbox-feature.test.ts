// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type ManagedSandboxFeature,
  managedSandboxFeatureHasDrift,
  managedSandboxFeatureIssue,
  managedSandboxFeatureNeedsSessionUpdate,
  resolveManagedSandboxFeature,
} from "./managed-sandbox-feature";

const feature: ManagedSandboxFeature<boolean> = {
  id: "test-feature",
  defaultValue: false,
  isValue: (value): value is boolean => typeof value === "boolean",
  isEnabled: (value) => value,
  supportsAgent: (agent) => agent === "supported",
};

describe("managed sandbox feature", () => {
  it("resolves explicit, resumable, registry, session, and default intent in order", () => {
    expect(
      resolveManagedSandboxFeature(feature, {
        agent: "supported",
        requested: false,
        resume: true,
        sessionValue: true,
        sessionRequestedExplicitly: true,
        registryValue: true,
      }),
    ).toMatchObject({ value: false, source: "explicit", requestedExplicitly: true });
    expect(
      resolveManagedSandboxFeature(feature, {
        agent: "supported",
        resume: true,
        sessionValue: true,
        sessionRequestedExplicitly: true,
        registryValue: false,
      }),
    ).toMatchObject({ value: true, source: "session-explicit" });
    expect(
      resolveManagedSandboxFeature(feature, {
        agent: "supported",
        sessionValue: false,
        registryValue: true,
      }),
    ).toMatchObject({ value: true, source: "registry" });
    expect(
      resolveManagedSandboxFeature(feature, { agent: "supported", sessionValue: true }),
    ).toMatchObject({ value: true, source: "session" });
    expect(resolveManagedSandboxFeature(feature, { agent: "supported" })).toMatchObject({
      value: false,
      source: "default",
    });
  });

  it("classifies unsupported enablement and permits an explicit disable", () => {
    expect(managedSandboxFeatureIssue(feature, { agent: "unsupported", requested: true })).toBe(
      "unsupported-request",
    );
    expect(
      managedSandboxFeatureIssue(feature, {
        agent: "unsupported",
        sessionValue: true,
      }),
    ).toBe("recorded-state-on-unsupported-agent");
    expect(
      managedSandboxFeatureIssue(feature, {
        agent: "unsupported",
        requested: false,
        sessionValue: true,
      }),
    ).toBeNull();
  });

  it("updates session provenance only for an explicit request", () => {
    const inherited = resolveManagedSandboxFeature(feature, {
      agent: "supported",
      registryValue: true,
    });
    const explicit = resolveManagedSandboxFeature(feature, {
      agent: "supported",
      requested: true,
    });
    expect(managedSandboxFeatureNeedsSessionUpdate(feature, true, false, inherited)).toBe(false);
    expect(managedSandboxFeatureNeedsSessionUpdate(feature, true, false, explicit)).toBe(true);
  });

  it("treats missing authoritative registry state as drift only for a live supported sandbox", () => {
    const base = {
      liveExists: true,
      hasRegistryEntry: true,
      agent: "supported",
      desiredValue: true,
    };
    expect(managedSandboxFeatureHasDrift(feature, { ...base, recordedValue: undefined })).toBe(
      true,
    );
    expect(managedSandboxFeatureHasDrift(feature, { ...base, recordedValue: false })).toBe(true);
    expect(managedSandboxFeatureHasDrift(feature, { ...base, recordedValue: true })).toBe(false);
    expect(
      managedSandboxFeatureHasDrift(feature, { ...base, liveExists: false, recordedValue: false }),
    ).toBe(false);
  });
});
