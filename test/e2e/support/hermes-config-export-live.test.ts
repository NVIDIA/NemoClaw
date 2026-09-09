// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type HermesConfigExportLiveEvidence,
  passesHermesConfigExportLiveEvidence,
} from "../fixtures/hermes-config-export-live.ts";

function passingEvidence(): HermesConfigExportLiveEvidence {
  return {
    agent: "hermes",
    aliasesEquivalent: true,
    checked: true,
    credentialReferenceMatches: true,
    credentialValuesOmitted: true,
    identityDriftPreventedPublication: true,
    identityDriftReported: true,
    immutableManagedImageMatches: true,
    inferenceEndpointMatches: true,
    launchersSucceeded: true,
    policyMatches: true,
    sandboxNameMatches: true,
  };
}

describe("Hermes config export live evidence", () => {
  it("accepts the complete redacted export contract", () => {
    expect(passesHermesConfigExportLiveEvidence(passingEvidence())).toBe(true);
  });

  it.each([
    "aliasesEquivalent",
    "credentialReferenceMatches",
    "credentialValuesOmitted",
    "identityDriftPreventedPublication",
    "identityDriftReported",
    "immutableManagedImageMatches",
    "inferenceEndpointMatches",
    "launchersSucceeded",
    "policyMatches",
    "sandboxNameMatches",
  ] as const)("rejects evidence when %s is false", (field) => {
    expect(passesHermesConfigExportLiveEvidence({ ...passingEvidence(), [field]: false })).toBe(
      false,
    );
  });

  it("rejects evidence for a different agent", () => {
    expect(passesHermesConfigExportLiveEvidence({ ...passingEvidence(), agent: "openclaw" })).toBe(
      false,
    );
  });
});
