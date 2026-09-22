// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  passesNetworkPolicyConfigExportLiveEvidence,
  requireEffectivePolicyDocument,
} from "./config-export-policy-evidence.ts";

function passingNetworkPolicyEvidence() {
  return {
    sandboxName: "e2e-net-policy",
    managedImagePlaceholderIsNull: true,
    effectivePolicyMatches: true,
    identityDriftPreventedPublication: true,
    producer: { sourceRevision: "a".repeat(40) },
    yaml: { artifact: "config-export-live.yaml", sha256: "b".repeat(64) },
  };
}

describe("config export effective policy evidence", () => {
  it("returns a successful effective policy observation", () => {
    expect(
      requireEffectivePolicyDocument({
        ok: true,
        value: { appliedRevision: 1, document: "version: 1" },
      }),
    ).toBe("version: 1");
  });

  it("rejects a failed effective policy observation", () => {
    expect(() =>
      requireEffectivePolicyDocument({
        ok: false,
        error: { kind: "command", reason: "failed", message: "policy unavailable" },
      }),
    ).toThrow("the effective sandbox policy could not be read: policy unavailable");
  });
});

describe("network-policy config export live evidence", () => {
  it("accepts YAML evidence bound to an exact producer revision", () => {
    expect(passesNetworkPolicyConfigExportLiveEvidence(passingNetworkPolicyEvidence())).toBe(true);
  });

  it("rejects YAML evidence without an exact producer revision", () => {
    const evidence = passingNetworkPolicyEvidence();
    expect(
      passesNetworkPolicyConfigExportLiveEvidence({
        ...evidence,
        producer: { sourceRevision: "main" },
      }),
    ).toBe(false);
  });
});
