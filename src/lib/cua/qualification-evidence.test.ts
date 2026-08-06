// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  assertCuaQualificationBinding,
  parseCuaQualificationEnvironment,
  parseCuaQualificationReceipt,
} from "./qualification-evidence";
import { type CuaRuntimeTestFixture, createCuaRuntimeTestFixture } from "./runtime-test-fixture";

const fixtures: CuaRuntimeTestFixture[] = [];

function evidence() {
  const runtime = createCuaRuntimeTestFixture({ qualified: true });
  fixtures.push(runtime);
  return structuredClone(runtime.manifest.qualificationEvidence!);
}

afterEach(() => {
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

describe("immutable CUA qualification evidence", () => {
  it("binds the immutable GPU probe to the manifest-approved target image", () => {
    const value = evidence();
    const environment = parseCuaQualificationEnvironment(value.environment);
    const receipt = parseCuaQualificationReceipt(value.receipt);
    expect(() => assertCuaQualificationBinding(environment, receipt)).not.toThrow();

    receipt.components.targetImage = `sha256:${"f".repeat(64)}`;
    expect(() => assertCuaQualificationBinding(environment, receipt)).toThrow(
      /probe image does not match the targetImage/,
    );

    const toolDrift = evidence();
    const toolEnvironment = parseCuaQualificationEnvironment(toolDrift.environment);
    const toolReceipt = parseCuaQualificationReceipt(toolDrift.receipt);
    toolReceipt.hostTools.docker = `sha256:${"f".repeat(64)}`;
    expect(() => assertCuaQualificationBinding(toolEnvironment, toolReceipt)).toThrow(
      /identities do not match/,
    );
  });

  it("strictly parses the immutable fixed target-channel identity", () => {
    const missingEnvironment = evidence();
    delete (missingEnvironment.environment as unknown as Record<string, unknown>).targetChannel;
    expect(() => parseCuaQualificationEnvironment(missingEnvironment.environment)).toThrow(
      /contain exactly/,
    );

    const missingReceipt = evidence();
    delete (missingReceipt.receipt as unknown as Record<string, unknown>).targetChannel;
    expect(() => parseCuaQualificationReceipt(missingReceipt.receipt)).toThrow(/contain exactly/);

    const extra = evidence();
    Object.assign(extra.receipt.targetChannel, { endpoint: "private.invalid" });
    expect(() => parseCuaQualificationReceipt(extra.receipt)).toThrow(/contain exactly/);

    const wrongProtocol = evidence();
    (wrongProtocol.environment.targetChannel as { protocol: string }).protocol =
      "cua.qualification.target-channel/v2";
    expect(() => parseCuaQualificationEnvironment(wrongProtocol.environment)).toThrow(
      /targetChannel protocol/,
    );

    const mutableDigest = evidence();
    (mutableDigest.receipt.targetChannel as { targetImageDigest: string }).targetImageDigest =
      "latest";
    expect(() => parseCuaQualificationReceipt(mutableDigest.receipt)).toThrow(/sha256 digest/);
  });

  it("binds the environment, receipt, and component target-channel tuple", () => {
    const mismatchedIdentity = evidence();
    const identityEnvironment = parseCuaQualificationEnvironment(mismatchedIdentity.environment);
    const identityReceipt = parseCuaQualificationReceipt(mismatchedIdentity.receipt);
    identityReceipt.targetChannel.serviceBundleDigest = `sha256:${"f".repeat(64)}`;
    expect(() => assertCuaQualificationBinding(identityEnvironment, identityReceipt)).toThrow(
      /identities do not match/,
    );

    const serviceMismatch = evidence();
    const serviceEnvironment = parseCuaQualificationEnvironment(serviceMismatch.environment);
    const serviceReceipt = parseCuaQualificationReceipt(serviceMismatch.receipt);
    const changedService = `sha256:${"f".repeat(64)}`;
    serviceEnvironment.targetChannel.serviceBundleDigest = changedService;
    serviceReceipt.targetChannel.serviceBundleDigest = changedService;
    expect(() => assertCuaQualificationBinding(serviceEnvironment, serviceReceipt)).toThrow(
      /serviceBundleDigest does not match/,
    );

    const imageMismatch = evidence();
    const imageEnvironment = parseCuaQualificationEnvironment(imageMismatch.environment);
    const imageReceipt = parseCuaQualificationReceipt(imageMismatch.receipt);
    const changedImage = `sha256:${"f".repeat(64)}`;
    imageEnvironment.targetChannel.targetImageDigest = changedImage;
    imageReceipt.targetChannel.targetImageDigest = changedImage;
    expect(() => assertCuaQualificationBinding(imageEnvironment, imageReceipt)).toThrow(
      /targetImageDigest does not match/,
    );
  });

  it.each([
    [
      "environment repository coordinate",
      (value: ReturnType<typeof evidence>) => {
        Object.assign(value.environment, { repository: "private.invalid/release" });
      },
    ],
    [
      "GPU endpoint coordinate",
      (value: ReturnType<typeof evidence>) => {
        Object.assign(value.environment.gpu, { endpoint: "https://private.invalid" });
      },
    ],
    [
      "receipt credential",
      (value: ReturnType<typeof evidence>) => {
        Object.assign(value.receipt, { token: "ghp_example" });
      },
    ],
    [
      "component source coordinate",
      (value: ReturnType<typeof evidence>) => {
        Object.assign(value.receipt.components, { source: "user@host" });
      },
    ],
    [
      "scenario endpoint coordinate",
      (value: ReturnType<typeof evidence>) => {
        Object.assign(value.receipt.scenarios[0], { endpoint: "https://private.invalid" });
      },
    ],
  ])("rejects an undeclared %s", (_label, mutate) => {
    const value = evidence();
    mutate(value);

    expect(() => {
      parseCuaQualificationEnvironment(value.environment);
      parseCuaQualificationReceipt(value.receipt);
    }).toThrow();
  });

  it.each([
    ["GPU model URL", "gpu", "model", "https://gpu.invalid"],
    ["GPU driver credential", "gpu", "driverVersion", "sk-private"],
    ["inference provider credential", "inference", "provider", "ghp_example"],
    ["inference model userinfo", "inference", "model", "user@host/model"],
    ["inference model IPv4 coordinate", "inference", "model", "127.0.0.1/model"],
    ["inference model IPv6 coordinate", "inference", "model", "[::1]/model"],
    ["inference model localhost coordinate", "inference", "model", "localhost/model"],
    ["scenario task URL", "scenario", "taskId", "https://tasks.invalid/id"],
  ])("rejects a coordinate-bearing %s", (_label, area, key, replacement) => {
    const value = evidence();
    if (area === "gpu") {
      Object.assign(value.receipt.gpu, { [key]: replacement });
    } else if (area === "inference") {
      Object.assign(value.receipt.inference, { [key]: replacement });
    } else {
      Object.assign(value.receipt.scenarios[0], { [key]: replacement });
    }

    expect(() => parseCuaQualificationReceipt(value.receipt)).toThrow(
      /coordinate- and credential-free/,
    );
  });

  it("requires one browser scenario with content-bound evidence", () => {
    const duplicateEvidence = evidence().receipt;
    duplicateEvidence.scenarios[0]!.evidenceDigests.push(
      duplicateEvidence.scenarios[0]!.evidenceDigests[0]!,
    );
    expect(() => parseCuaQualificationReceipt(duplicateEvidence)).toThrow(
      /duplicate evidence digests/,
    );

    const missingState = evidence().receipt;
    missingState.scenarios[0]!.evidenceDigests = [`sha256:${"f".repeat(64)}`];
    expect(() => parseCuaQualificationReceipt(missingState)).toThrow(
      /state digest must be included/,
    );

    const replayedLifecycleObservation = evidence().receipt;
    replayedLifecycleObservation.cleanup.targetDestroyObservationDigest =
      replayedLifecycleObservation.cleanup.nemoclawDestroyObservationDigest;
    expect(() => parseCuaQualificationReceipt(replayedLifecycleObservation)).toThrow(
      /lifecycle observations must be domain-distinct/,
    );
  });
});
