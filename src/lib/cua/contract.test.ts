// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { type CuaRuntimeReadiness, getCuaRuntimeReadinessDigest } from "./contract";
import { parseCuaRuntimeReadiness } from "./schema";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

function readiness(): CuaRuntimeReadiness {
  const component = (name: string, character: string) => ({
    name,
    version: "1.0.0",
    digest: digest(character),
    owner: "NVIDIA",
  });
  return {
    schemaVersion: "1.0.0",
    kind: "runtime-readiness",
    agent: "nemocua",
    mode: "standalone",
    status: "candidate",
    sourceRevision: "a".repeat(40),
    sourceClean: true,
    runtimeManifestDigest: digest("b"),
    providerAuthorityDigest: digest("c"),
    qualification: {
      state: "candidate",
      environmentDigest: digest("d"),
      bundleReceiptDigest: digest("e"),
    },
    components: {
      openshell: component("openshell", "1"),
      runtime: component("nemocua-runtime", "2"),
      sandboxImage: component("nemocua-sandbox", "3"),
      targetAdapter: component("target-adapter", "4"),
      policy: component("nemocua-policy", "5"),
      taskProtocol: component("task-protocol", "6"),
      securityVerifier: component("security-verifier", "7"),
    },
    inference: {
      provider: "nvidia",
      model: "nvidia/nvidia/nemotron-3-super-120b-a12b",
      routeDigest: digest("8"),
    },
    appliedPolicy: { revision: 2, digest: digest("9") },
    commands: { interactive: true, headless: true, version: true, smoke: true },
    limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
    requiredCapabilities: ["browser", "computer", "terminal"],
    targetOperations: [],
    securityOperations: [],
    taskOperations: [],
  };
}

describe("CUA candidate runtime contract", () => {
  it("accepts candidate readiness through the serialized parser (#7755)", () => {
    expect(parseCuaRuntimeReadiness(readiness())).toEqual(readiness());
  });

  it.each([
    "targetOperations",
    "securityOperations",
    "taskOperations",
  ] as const)("rejects advertised %s before its cumulative slice exists (#7755)", (field) => {
    const value = readiness() as unknown as Record<string, unknown>;
    value[field] = [field.replace("Operations", ".status")];
    expect(() => parseCuaRuntimeReadiness(value)).toThrow(/schema/);
  });

  it("keeps candidate state machine-distinct from unavailable states (#7755)", () => {
    const missingEvidence = readiness();
    missingEvidence.qualification = null;
    expect(() => parseCuaRuntimeReadiness(missingEvidence)).toThrow(/schema/);

    const unavailable = readiness();
    unavailable.status = "unavailable";
    unavailable.qualification = null;
    expect(parseCuaRuntimeReadiness(unavailable).status).toBe("unavailable");
  });

  it.each([
    ["provider", "ghp_abcdefghijklmnopqrstuvwxyz"],
    ["provider", "https://provider.invalid"],
    ["model", "sk-model"],
    ["model", "nvidia/model?token=1"],
  ] as const)("rejects credential or coordinate shaped inference %s (#7755)", (field, value) => {
    const record = readiness();
    record.inference[field] = value;
    expect(() => parseCuaRuntimeReadiness(record)).toThrow(/contract|schema/);
  });

  it("binds the empty operation sets in the whole-readiness digest (#7755)", () => {
    const original = readiness();
    const changed = structuredClone(original) as unknown as Record<string, unknown>;
    changed.targetOperations = ["target.status"];
    expect(getCuaRuntimeReadinessDigest(original)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(() =>
      getCuaRuntimeReadinessDigest(changed as unknown as CuaRuntimeReadiness),
    ).not.toThrow();
    expect(getCuaRuntimeReadinessDigest(changed as unknown as CuaRuntimeReadiness)).not.toBe(
      getCuaRuntimeReadinessDigest(original),
    );
  });

  it("rejects unknown serialized fields (#7755)", () => {
    expect(() =>
      parseCuaRuntimeReadiness({ ...readiness(), endpoint: "https://private.invalid" }),
    ).toThrow(/schema/);
  });
});
