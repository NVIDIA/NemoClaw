// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CUA_TASK_OPERATIONS } from "./contract";
import {
  buildCurrentCuaRuntimeReadiness,
  getCuaInferenceRouteIdentity,
  getPublicCuaRuntimeReadiness,
  validateCurrentCuaRuntimeReadiness,
} from "./runtime-readiness";
import { type CuaRuntimeTestFixture, createCuaRuntimeTestFixture } from "./runtime-test-fixture";

const fixtures: CuaRuntimeTestFixture[] = [];
const inference = {
  provider: "nvidia",
  model: "nvidia/nemotron-3-super-120b-a12b",
};
const providerAuthorityDigest = `sha256:${"8".repeat(64)}`;
const liveAppliedPolicy = { revision: 7, digest: `sha256:${"9".repeat(64)}` };

function fixture(input: Parameters<typeof createCuaRuntimeTestFixture>[0] = {}) {
  const value = createCuaRuntimeTestFixture(input);
  fixtures.push(value);
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (fixtures.length > 0) fixtures.pop()?.cleanup();
});

describe("current CUA runtime readiness", () => {
  it("publishes a distinct exact-build candidate only to the qualification lifecycle (#7755)", () => {
    const runtime = fixture();
    const env = { ...runtime.env, NEMOCLAW_CUA_QUALIFICATION: "1" };
    const context = {
      agentName: "nemocua",
      recordedInference: inference,
      liveInference: inference,
      liveProviderAuthorityDigest: providerAuthorityDigest,
      liveAppliedPolicy,
      acceptance: "candidate-qualification" as const,
      env,
      buildIdentity: {
        schemaVersion: 1 as const,
        sourceRevision: runtime.candidateCommit,
        sourceClean: true,
      },
    };

    const readiness = buildCurrentCuaRuntimeReadiness(context);

    expect(readiness.status).toBe("candidate");
    expect(readiness.sourceRevision).toBe(runtime.candidateCommit);
    expect(readiness.providerAuthorityDigest).toBe(providerAuthorityDigest);
    expect(readiness.components.openshell).toEqual({
      name: "openshell",
      version: "qualification-bound",
      digest: `sha256:${crypto
        .createHash("sha256")
        .update(fs.readFileSync(runtime.openshellPath))
        .digest("hex")}`,
      owner: "NVIDIA",
    });
    expect(readiness.qualification).toEqual({
      state: "candidate",
      environmentDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      bundleReceiptDigest: `sha256:${runtime.manifest.bundleReceipt.sha256}`,
    });
    expect(readiness.taskOperations).toEqual(CUA_TASK_OPERATIONS);
    expect(getPublicCuaRuntimeReadiness(readiness, context)).toEqual(readiness);
    expect(
      getPublicCuaRuntimeReadiness(readiness, {
        ...context,
        acceptance: "final",
      }),
    ).toBeNull();
  });

  it("rejects candidate activation when the executing revision does not match (#7755)", () => {
    const runtime = fixture();

    expect(() =>
      buildCurrentCuaRuntimeReadiness({
        agentName: "nemocua",
        recordedInference: inference,
        liveInference: inference,
        liveProviderAuthorityDigest: providerAuthorityDigest,
        liveAppliedPolicy,
        acceptance: "candidate-qualification",
        env: { ...runtime.env, NEMOCLAW_CUA_QUALIFICATION: "1" },
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: "b".repeat(40),
          sourceClean: true,
        },
      }),
    ).toThrow(/qualification environment/);
  });

  it("rejects a candidate environment bound to another runtime manifest (#7755)", () => {
    const runtime = fixture();
    const environment = JSON.parse(fs.readFileSync(runtime.environmentPath, "utf8")) as {
      runtimeManifestSha256: string;
    };
    environment.runtimeManifestSha256 = "f".repeat(64);
    fs.chmodSync(runtime.environmentPath, 0o644);
    fs.writeFileSync(runtime.environmentPath, JSON.stringify(environment));
    fs.chmodSync(runtime.environmentPath, 0o444);

    expect(() =>
      buildCurrentCuaRuntimeReadiness({
        agentName: "nemocua",
        recordedInference: inference,
        liveInference: inference,
        liveProviderAuthorityDigest: providerAuthorityDigest,
        liveAppliedPolicy,
        acceptance: "candidate-qualification",
        env: { ...runtime.env, NEMOCLAW_CUA_QUALIFICATION: "1" },
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: runtime.candidateCommit,
          sourceClean: true,
        },
      }),
    ).toThrow(/qualification environment/);
  });

  it("rejects an unclean candidate even when every artifact digest matches (#7755)", () => {
    const runtime = fixture();

    expect(() =>
      buildCurrentCuaRuntimeReadiness({
        agentName: "nemocua",
        recordedInference: inference,
        liveInference: inference,
        liveProviderAuthorityDigest: providerAuthorityDigest,
        liveAppliedPolicy,
        acceptance: "candidate-qualification",
        env: { ...runtime.env, NEMOCLAW_CUA_QUALIFICATION: "1" },
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: runtime.candidateCommit,
          sourceClean: false,
        },
      }),
    ).toThrow(/clean exact NemoClaw build/);
  });

  it("does not let test-mode environment variables bypass candidate evidence permissions (#7755)", () => {
    const runtime = fixture();
    fs.chmodSync(runtime.environmentPath, 0o666);
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    expect(() =>
      buildCurrentCuaRuntimeReadiness({
        agentName: "nemocua",
        recordedInference: inference,
        liveInference: inference,
        liveProviderAuthorityDigest: providerAuthorityDigest,
        liveAppliedPolicy,
        acceptance: "candidate-qualification",
        env: {
          ...runtime.env,
          NEMOCLAW_CUA_QUALIFICATION: "1",
          NODE_ENV: "test",
          VITEST: "true",
        },
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: runtime.candidateCommit,
          sourceClean: true,
        },
      }),
    ).toThrow(/qualification environment.*group\/world write access/i);
  });

  it("rejects an oversized candidate environment before parsing it (#7755)", () => {
    const runtime = fixture();
    fs.chmodSync(runtime.environmentPath, 0o644);
    fs.truncateSync(runtime.environmentPath, 4097);
    fs.chmodSync(runtime.environmentPath, 0o444);

    expect(() =>
      buildCurrentCuaRuntimeReadiness({
        agentName: "nemocua",
        recordedInference: inference,
        liveInference: inference,
        liveProviderAuthorityDigest: providerAuthorityDigest,
        liveAppliedPolicy,
        acceptance: "candidate-qualification",
        env: { ...runtime.env, NEMOCLAW_CUA_QUALIFICATION: "1" },
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: runtime.candidateCommit,
          sourceClean: true,
        },
      }),
    ).toThrow(/through 4096 bytes/);
  });

  it("rejects live inference drift and credential-shaped serialized selectors (#7755)", () => {
    const runtime = fixture();
    const env = { ...runtime.env, NEMOCLAW_CUA_QUALIFICATION: "1" };
    const readiness = buildCurrentCuaRuntimeReadiness({
      agentName: "nemocua",
      recordedInference: inference,
      liveInference: inference,
      liveProviderAuthorityDigest: providerAuthorityDigest,
      liveAppliedPolicy,
      acceptance: "candidate-qualification",
      env,
      buildIdentity: {
        schemaVersion: 1,
        sourceRevision: runtime.candidateCommit,
        sourceClean: true,
      },
    });

    expect(() =>
      validateCurrentCuaRuntimeReadiness(readiness, {
        agentName: "nemocua",
        recordedInference: inference,
        liveInference: { ...inference, model: "nvidia/a-different-model" },
        liveProviderAuthorityDigest: providerAuthorityDigest,
        liveAppliedPolicy,
        acceptance: "candidate-qualification",
        env,
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: runtime.candidateCommit,
          sourceClean: true,
        },
      }),
    ).toThrow(/live route/);

    expect(() =>
      validateCurrentCuaRuntimeReadiness(readiness, {
        agentName: "nemocua",
        recordedInference: inference,
        liveInference: inference,
        liveProviderAuthorityDigest: `sha256:${"9".repeat(64)}`,
        liveAppliedPolicy,
        acceptance: "candidate-qualification",
        env,
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: runtime.candidateCommit,
          sourceClean: true,
        },
      }),
    ).toThrow(/current runtime identity/);

    for (const provider of [
      "ghp_example",
      "sk-test",
      "https://provider.invalid",
      "provider.example.xyz",
      "2001:db8::1",
      "user@host",
      "localhost",
      "127.0.0.1",
    ]) {
      expect(() => getCuaInferenceRouteIdentity({ provider, model: "safe-model" })).toThrow(
        /coordinate- and credential-free/,
      );
    }
    for (const model of [
      "ghp_example",
      "sk-test",
      "https://models.invalid/value",
      "user@host/model",
      "model?query",
      "model#fragment",
      "model\nother",
      "localhost/model",
      "127.0.0.1/model",
    ]) {
      expect(() => getCuaInferenceRouteIdentity({ provider: "nvidia", model })).toThrow(
        /coordinate- and credential-free/,
      );
    }
    expect(
      getCuaInferenceRouteIdentity({
        provider: "nvidia",
        model: "nvidia/nvidia/nemotron-3-ultra",
      }).model,
    ).toBe("nvidia/nvidia/nemotron-3-ultra");
  });

  it("invalidates candidate readiness when the selected OpenShell executable changes (#7755)", () => {
    const runtime = fixture();
    const context = {
      agentName: "nemocua",
      recordedInference: inference,
      liveInference: inference,
      liveProviderAuthorityDigest: providerAuthorityDigest,
      liveAppliedPolicy,
      acceptance: "candidate-qualification" as const,
      env: { ...runtime.env, NEMOCLAW_CUA_QUALIFICATION: "1" },
      buildIdentity: {
        schemaVersion: 1 as const,
        sourceRevision: runtime.candidateCommit,
        sourceClean: true,
      },
    };
    const readiness = buildCurrentCuaRuntimeReadiness(context);
    fs.writeFileSync(runtime.openshellPath, "#!/bin/sh\nexit 9\n");

    expect(() => validateCurrentCuaRuntimeReadiness(readiness, context)).toThrow(
      /current runtime identity/,
    );
  });
});
