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
import {
  type CuaRuntimeTestFixture,
  canonicalJsonSha256,
  createCuaRuntimeTestFixture,
} from "./runtime-test-fixture";

const fixtures: CuaRuntimeTestFixture[] = [];
const inference = {
  provider: "nvidia",
  model: "nvidia/nemotron-3-super-120b-a12b",
};
const providerAuthorityDigest = `sha256:${"8".repeat(64)}`;

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
        acceptance: "candidate-qualification",
        env: { ...runtime.env, NEMOCLAW_CUA_QUALIFICATION: "1" },
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: runtime.finalCommit,
          sourceClean: true,
        },
      }),
    ).toThrow(/qualification environment/);
  });

  it("rejects a candidate whose fixed target channel does not match the runtime manifest (#7755)", () => {
    const runtime = fixture();
    const environment = JSON.parse(fs.readFileSync(runtime.environmentPath, "utf8")) as {
      targetChannel: { serviceBundleDigest: string };
    };
    environment.targetChannel.serviceBundleDigest = `sha256:${"f".repeat(64)}`;
    fs.chmodSync(runtime.environmentPath, 0o644);
    fs.writeFileSync(runtime.environmentPath, JSON.stringify(environment));
    fs.chmodSync(runtime.environmentPath, 0o444);

    expect(() =>
      buildCurrentCuaRuntimeReadiness({
        agentName: "nemocua",
        recordedInference: inference,
        liveInference: inference,
        liveProviderAuthorityDigest: providerAuthorityDigest,
        acceptance: "candidate-qualification",
        env: { ...runtime.env, NEMOCLAW_CUA_QUALIFICATION: "1" },
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: runtime.candidateCommit,
          sourceClean: true,
        },
      }),
    ).toThrow(/target channel does not match the runtime manifest/);
  });

  it("rejects an unclean candidate even when every artifact digest matches (#7755)", () => {
    const runtime = fixture();

    expect(() =>
      buildCurrentCuaRuntimeReadiness({
        agentName: "nemocua",
        recordedInference: inference,
        liveInference: inference,
        liveProviderAuthorityDigest: providerAuthorityDigest,
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
    fs.truncateSync(runtime.environmentPath, 64 * 1024 + 1);
    fs.chmodSync(runtime.environmentPath, 0o444);

    expect(() =>
      buildCurrentCuaRuntimeReadiness({
        agentName: "nemocua",
        recordedInference: inference,
        liveInference: inference,
        liveProviderAuthorityDigest: providerAuthorityDigest,
        acceptance: "candidate-qualification",
        env: { ...runtime.env, NEMOCLAW_CUA_QUALIFICATION: "1" },
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: runtime.candidateCommit,
          sourceClean: true,
        },
      }),
    ).toThrow(/through 65536 bytes/);
  });

  it("rejects live inference drift and credential-shaped public selectors (#7755)", () => {
    const runtime = fixture();
    const env = { ...runtime.env, NEMOCLAW_CUA_QUALIFICATION: "1" };
    const readiness = buildCurrentCuaRuntimeReadiness({
      agentName: "nemocua",
      recordedInference: inference,
      liveInference: inference,
      liveProviderAuthorityDigest: providerAuthorityDigest,
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

  it("uses embedded immutable evidence on a fresh final host (#7755)", () => {
    const route = getCuaInferenceRouteIdentity(inference);
    const runtime = fixture({ qualified: true, routeDigest: route.routeDigest });
    fs.rmSync(runtime.environmentPath);
    const context = {
      agentName: "nemocua",
      recordedInference: inference,
      liveInference: inference,
      liveProviderAuthorityDigest: providerAuthorityDigest,
      acceptance: "final" as const,
      env: runtime.env,
      buildIdentity: {
        schemaVersion: 1 as const,
        sourceRevision: runtime.finalCommit,
        sourceClean: true,
      },
    };

    const readiness = buildCurrentCuaRuntimeReadiness(context);

    expect(readiness.status).toBe("available");
    expect(readiness.sourceRevision).toBe(runtime.finalCommit);
    expect(readiness.qualification).toMatchObject({
      state: "qualified",
      candidateSourceRevision: runtime.candidateCommit,
    });
    expect(validateCurrentCuaRuntimeReadiness(readiness, context)).toEqual(readiness);
  });

  it("accepts semantically identical final authority with reordered object keys (#7755)", () => {
    const route = getCuaInferenceRouteIdentity(inference);
    const runtime = fixture({ qualified: true, routeDigest: route.routeDigest });
    const context = {
      agentName: "nemocua",
      recordedInference: inference,
      liveInference: inference,
      liveProviderAuthorityDigest: providerAuthorityDigest,
      acceptance: "final" as const,
      env: runtime.env,
      buildIdentity: {
        schemaVersion: 1 as const,
        sourceRevision: runtime.finalCommit,
        sourceClean: true,
      },
    };
    const readiness = buildCurrentCuaRuntimeReadiness(context);
    const reordered = {
      ...readiness,
      inference: {
        routeDigest: readiness.inference.routeDigest,
        model: readiness.inference.model,
        provider: readiness.inference.provider,
      },
      components: Object.fromEntries(Object.entries(readiness.components).reverse()),
    };

    expect(validateCurrentCuaRuntimeReadiness(reordered, context)).toEqual(reordered);
  });

  it("rejects syntax-valid final evidence whose component tuple was promoted by hand (#7755)", () => {
    const route = getCuaInferenceRouteIdentity(inference);
    const runtime = fixture({ qualified: true, routeDigest: route.routeDigest });
    runtime.rewriteManifest((record) => {
      const qualification = record.qualificationEvidence as Record<string, unknown>;
      const receipt = qualification.receipt as Record<string, unknown>;
      const components = receipt.components as Record<string, unknown>;
      components.targetImage = `sha256:${"f".repeat(64)}`;
      const compatibility = record.compatibility as Record<string, unknown>;
      compatibility.receiptSha256 = canonicalJsonSha256(receipt);
    });

    expect(() =>
      buildCurrentCuaRuntimeReadiness({
        agentName: "nemocua",
        recordedInference: inference,
        liveInference: inference,
        liveProviderAuthorityDigest: providerAuthorityDigest,
        acceptance: "final",
        env: runtime.env,
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: runtime.finalCommit,
          sourceClean: true,
        },
      }),
    ).toThrow(/targetImage/);
  });

  it("rejects internally consistent final evidence for a different fixed target channel (#7755)", () => {
    const route = getCuaInferenceRouteIdentity(inference);
    const runtime = fixture({ qualified: true, routeDigest: route.routeDigest });
    runtime.rewriteManifest((record) => {
      const qualification = record.qualificationEvidence as Record<string, unknown>;
      const environment = qualification.environment as Record<string, unknown>;
      const receipt = qualification.receipt as Record<string, unknown>;
      const changedService = `sha256:${"f".repeat(64)}`;
      (environment.targetChannel as Record<string, unknown>).serviceBundleDigest = changedService;
      (receipt.targetChannel as Record<string, unknown>).serviceBundleDigest = changedService;
      (receipt.components as Record<string, unknown>).serviceBundle = changedService;
      const compatibility = record.compatibility as Record<string, unknown>;
      compatibility.environmentSha256 = canonicalJsonSha256(environment);
      compatibility.receiptSha256 = canonicalJsonSha256(receipt);
    });

    expect(() =>
      buildCurrentCuaRuntimeReadiness({
        agentName: "nemocua",
        recordedInference: inference,
        liveInference: inference,
        liveProviderAuthorityDigest: providerAuthorityDigest,
        acceptance: "final",
        env: runtime.env,
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: runtime.finalCommit,
          sourceClean: true,
        },
      }),
    ).toThrow(/target channel does not match the runtime manifest/);
  });

  it("rejects a final host whose selected OpenShell executable is not the qualified one (#7755)", () => {
    const route = getCuaInferenceRouteIdentity(inference);
    const runtime = fixture({ qualified: true, routeDigest: route.routeDigest });
    fs.writeFileSync(runtime.openshellPath, "#!/bin/sh\nexit 9\n");

    expect(() =>
      buildCurrentCuaRuntimeReadiness({
        agentName: "nemocua",
        recordedInference: inference,
        liveInference: inference,
        liveProviderAuthorityDigest: providerAuthorityDigest,
        acceptance: "final",
        env: runtime.env,
        buildIdentity: {
          schemaVersion: 1,
          sourceRevision: runtime.finalCommit,
          sourceClean: true,
        },
      }),
    ).toThrow(/components\.openshell/);
  });
});
