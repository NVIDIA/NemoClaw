// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { SandboxWorkloadReceipt } from "./types";
import { cloneSandboxWorkloadReceipt } from "./workload";

const ENCODED_PROFILE = Buffer.from('{"schemaVersion":1}', "utf8").toString("base64url");
const PROFILE_SHA256 = createHash("sha256").update(ENCODED_PROFILE, "utf8").digest("hex");

const MANAGED_RECEIPT = {
  schemaVersion: 1,
  kind: "managed-image",
  reference: `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`,
  release: "v0.0.97",
  sourceRevision: "b".repeat(40),
  sourceCohort: "ghrun-123456-1",
  capabilityContractVersion: 1,
  startupProfileContractVersion: 1,
  encodedProfile: ENCODED_PROFILE,
  startupProfileSha256: PROFILE_SHA256,
  credentialProxyReplayRequired: false,
  shared: true,
} as const satisfies SandboxWorkloadReceipt;

describe("sandbox workload receipt", () => {
  it("clones a complete shared managed-image identity", () => {
    const cloned = cloneSandboxWorkloadReceipt(MANAGED_RECEIPT);

    expect(cloned).toEqual(MANAGED_RECEIPT);
    expect(cloned).not.toBe(MANAGED_RECEIPT);
  });

  it("drops malformed ownership and profile identity instead of persisting it", () => {
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        sourceCohort: "run-123456",
      } as SandboxWorkloadReceipt),
    ).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        sourceCohort: `ghrun-${"1".repeat(21)}-1`,
      } as SandboxWorkloadReceipt),
    ).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        sourceCohort: `ghrun-1-${"1".repeat(11)}`,
      } as SandboxWorkloadReceipt),
    ).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        reference: `registry.example.test/openclaw@sha256:${"a".repeat(64)}`,
      } as SandboxWorkloadReceipt),
    ).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        reference: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox:latest",
      } as SandboxWorkloadReceipt),
    ).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        release: "latest",
      } as SandboxWorkloadReceipt),
    ).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        capabilityContractVersion: 2,
      } as SandboxWorkloadReceipt),
    ).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        startupProfileContractVersion: 2,
      } as SandboxWorkloadReceipt),
    ).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        startupProfileSha256: "not-a-digest",
      } as SandboxWorkloadReceipt),
    ).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        encodedProfile: `${ENCODED_PROFILE}=`,
      } as SandboxWorkloadReceipt),
    ).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        encodedProfile: Buffer.from("different", "utf8").toString("base64url"),
      } as SandboxWorkloadReceipt),
    ).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        corporateCaB64: "not canonical base64",
      } as SandboxWorkloadReceipt),
    ).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        shared: false,
      } as unknown as SandboxWorkloadReceipt),
    ).toBeUndefined();
  });

  it("retains an owned legacy image receipt independently from managed cohorts", () => {
    expect(
      cloneSandboxWorkloadReceipt({
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "nemoclaw-sandbox-local:build-123",
        shared: false,
      }),
    ).toEqual({
      schemaVersion: 1,
      kind: "legacy-dockerfile",
      reference: "nemoclaw-sandbox-local:build-123",
      shared: false,
    });
  });
});
