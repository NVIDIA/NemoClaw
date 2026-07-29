// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  CUA_QUALIFICATION_SCENARIOS,
  parseCuaQualificationReceipt,
} from "../../../tools/e2e/cua-qualification-receipt.mts";

const DIGEST = `sha256:${"a".repeat(64)}`;

function receipt(): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-receipt",
    status: "passed",
    launchable: { version: "1.0.0", digest: DIGEST },
    gpu: {
      count: 1,
      model: "GPU",
      driverVersion: "1",
      cudaVersion: "1",
      containerToolkitVersion: "1",
      probeImageDigest: DIGEST,
    },
    nemoclawCommit: "b".repeat(40),
    inference: {
      provider: "managed",
      model: "model",
    },
    components: {
      openshell: DIGEST,
      runtime: DIGEST,
      sandboxImage: DIGEST,
      targetImage: DIGEST,
      serviceBundle: DIGEST,
      policy: DIGEST,
      taskProtocol: DIGEST,
      fixture: DIGEST,
      oracle: DIGEST,
      verifier: DIGEST,
    },
    scenarios: CUA_QUALIFICATION_SCENARIOS.map((id, index) => ({
      id,
      taskId: `task-${String(index)}`,
      status: "passed",
      stateDigest: DIGEST,
      evidenceDigests: [DIGEST],
    })),
    recreated: true,
    negativeTests: "passed",
    cleanup: "passed",
  };
}

describe("CUA GPU qualification receipt (#7753)", () => {
  it("accepts exact content-free identities and independently verified scenarios", () => {
    expect(parseCuaQualificationReceipt(receipt())).toEqual(receipt());
  });

  it("rejects missing modality, failed cleanup, mutable identity, and extra data", () => {
    const missing = receipt();
    (missing.scenarios as unknown[]).pop();
    expect(() => parseCuaQualificationReceipt(missing)).toThrow(/exactly four/);

    const failedCleanup = receipt();
    failedCleanup.cleanup = "failed";
    expect(() => parseCuaQualificationReceipt(failedCleanup)).toThrow(/cleanup did not pass/);

    const mutableIdentity = receipt();
    (mutableIdentity.components as Record<string, unknown>).runtime = "latest";
    expect(() => parseCuaQualificationReceipt(mutableIdentity)).toThrow(/sha256 digest/);

    const missingGpu = receipt();
    (missingGpu.gpu as Record<string, unknown>).count = 0;
    expect(() => parseCuaQualificationReceipt(missingGpu)).toThrow(/positive integer/);

    const missingInference = receipt();
    delete missingInference.inference;
    expect(() => parseCuaQualificationReceipt(missingInference)).toThrow(/contain exactly/);

    const missingVerifier = receipt();
    delete (missingVerifier.components as Record<string, unknown>).verifier;
    expect(() => parseCuaQualificationReceipt(missingVerifier)).toThrow(/contain exactly/);

    const authorityBearing = receipt();
    authorityBearing.endpoint = "private.example";
    expect(() => parseCuaQualificationReceipt(authorityBearing)).toThrow(/contain exactly/);
  });
});
