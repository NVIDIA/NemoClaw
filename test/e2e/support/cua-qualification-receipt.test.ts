// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  assertCuaQualificationBinding,
  CUA_QUALIFICATION_SCENARIOS,
  parseCuaQualificationEnvironment,
  parseCuaQualificationReceipt,
} from "../../../tools/e2e/cua-qualification-receipt.mts";

const DIGEST = `sha256:${"a".repeat(64)}`;

function environment(): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-environment",
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
  };
}

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
  it("accepts only a bounded environment identity from the image producer", () => {
    expect(parseCuaQualificationEnvironment(environment())).toEqual(environment());

    const authorityBearing = environment();
    authorityBearing.workspaceId = "provider-authority";
    expect(() => parseCuaQualificationEnvironment(authorityBearing)).toThrow(/contain exactly/);

    const mutableProbe = environment();
    (mutableProbe.gpu as Record<string, unknown>).probeImageDigest = "latest";
    expect(() => parseCuaQualificationEnvironment(mutableProbe)).toThrow(/sha256 digest/);

    const missingGpu = environment();
    (missingGpu.gpu as Record<string, unknown>).count = 0;
    expect(() => parseCuaQualificationEnvironment(missingGpu)).toThrow(/positive integer/);
  });

  it("accepts exact content-free identities and complete scenario claims", () => {
    expect(parseCuaQualificationReceipt(receipt())).toEqual(receipt());
  });

  it("binds scenario claims to the environment producer identity", () => {
    const parsedEnvironment = parseCuaQualificationEnvironment(environment());
    const parsedReceipt = parseCuaQualificationReceipt(receipt());
    expect(() => assertCuaQualificationBinding(parsedEnvironment, parsedReceipt)).not.toThrow();

    parsedReceipt.gpu.driverVersion = "different";
    expect(() => assertCuaQualificationBinding(parsedEnvironment, parsedReceipt)).toThrow(
      /gpu.driverVersion/,
    );
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
