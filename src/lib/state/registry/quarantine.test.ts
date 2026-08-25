// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxQuarantineFence } from "./types";
import { normalizeSandboxQuarantineFence } from "./quarantine";

function validFence(): SandboxQuarantineFence {
  return {
    schemaVersion: 1,
    fenceId: "00000000-0000-4000-8000-000000000001",
    requestIdentity: "a".repeat(64),
    reasonDigest: "e".repeat(64),
    createdAt: "2026-08-25T04:00:00.000Z",
    updatedAt: "2026-08-25T04:00:01.000Z",
    phase: "partial",
    target: {
      sandboxName: "alpha",
      providerId: "docker",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "registry-generation-1",
      liveIdentityFingerprint: "b".repeat(64),
      providerHandle: "c".repeat(64),
      providerLifecycleGeneration: "provider-generation-1",
      runtime: { kind: "docker-container", handle: "d".repeat(64) },
    },
    attempts: [
      {
        operation: "workload-stop",
        attemptedAt: "2026-08-25T04:00:01.000Z",
        outcome: "failed",
        detail: "provider stop timed out",
      },
    ],
  };
}

describe("sandbox quarantine registry normalization", () => {
  it("round-trips complete exact authority and journal evidence (#10140)", () => {
    expect(normalizeSandboxQuarantineFence(validFence())).toEqual(validFence());
  });

  it.each([
    { requestIdentity: "raw-idempotency-key" },
    { reasonDigest: "not-a-digest" },
    { target: { ...validFence().target, liveIdentityFingerprint: "missing" } },
    { attempts: [{ ...validFence().attempts[0], detail: "unsafe\u001bdetail" }] },
  ])("rejects malformed or unsafe persisted authority %# (#10140)", (override) => {
    expect(() => normalizeSandboxQuarantineFence({ ...validFence(), ...override })).toThrow(
      /malformed quarantine fence/u,
    );
  });
});
