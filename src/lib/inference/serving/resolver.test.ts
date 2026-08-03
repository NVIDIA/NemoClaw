// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SystemReadinessReport } from "../../readiness/types.js";
import {
  DUAL_SPARK_PRESET_ID,
  type ManagedInferenceReadinessSource,
  type ManagedInferenceResolverInput,
  type ManagedInferenceTopologyQualification,
} from "./catalog-types.js";
import { fixtureDualSparkSelection } from "./dual-spark-fixture.test-support.js";
import {
  type DualSparkTopologyOutput,
  dualSparkTopologyOutputDigest,
} from "./dual-spark-topology.js";
import { resolveManagedInferenceServing } from "./resolver.js";

const NOW = new Date("2026-08-02T18:00:00.000Z");
const SOURCE_REVISION = "a".repeat(40);

function readinessReport(overrides: Partial<SystemReadinessReport> = {}): SystemReadinessReport {
  return {
    schemaVersion: "1.1.0",
    mutated: false,
    provenance: {
      nemoclawVersion: "0.1.0",
      sourceRevision: SOURCE_REVISION,
      observedAt: "2026-08-02T17:59:50.000Z",
    },
    observations: [],
    capabilities: [{ id: "host.platform.dgx_spark", state: "present" }],
    qualifications: [
      {
        id: "host.platform.dgx_spark",
        status: "qualified",
        capabilityIds: ["host.platform.dgx_spark"],
      },
    ],
    findings: [],
    evidence: [],
    status: "supported",
    exitCode: 0,
    ...overrides,
  } as SystemReadinessReport;
}

function readinessSources(): ManagedInferenceReadinessSource[] {
  return [
    { nodeId: "spark-head", report: readinessReport() },
    { nodeId: "spark-worker", report: readinessReport() },
  ];
}

function topology(
  overrides: Partial<ManagedInferenceTopologyQualification<DualSparkTopologyOutput>> = {},
): ManagedInferenceTopologyQualification<DualSparkTopologyOutput> {
  const artifact = structuredClone(fixtureDualSparkSelection().topologyQualification);
  return {
    ...artifact,
    ...overrides,
  };
}

function resolverInput(
  overrides: Partial<ManagedInferenceResolverInput<DualSparkTopologyOutput>> = {},
): ManagedInferenceResolverInput<DualSparkTopologyOutput> {
  return {
    readinessReports: readinessSources(),
    topologyQualifications: [topology()],
    now: NOW,
    ...overrides,
  };
}

describe("managed inference resolver", () => {
  it("selects the automatic preset for two fresh qualified Sparks and their topology", () => {
    const result = resolveManagedInferenceServing(resolverInput());

    expect(result).toMatchObject({
      outcome: "selected",
      selection: "automatic",
      preset: { metadata: { id: DUAL_SPARK_PRESET_ID } },
      recipe: { spec: { execution: { nodeCount: 2, tensorParallelSize: 2 } } },
      topologyQualification: { output: { masterAddress: "192.168.100.10" } },
    });
  });

  it("selects the exact explicit preset only when compatible requirements still pass", () => {
    const result = resolveManagedInferenceServing(
      resolverInput({
        intent: {
          preset: DUAL_SPARK_PRESET_ID,
          provider: "vllm",
          vllmModel: "deepseek-ai/DeepSeek-V4-Flash-0731",
        },
      }),
    );

    expect(result).toMatchObject({ outcome: "selected", selection: "explicit" });
  });

  it("returns an immutable topology snapshot", () => {
    const artifact = topology();
    const result = resolveManagedInferenceServing(
      resolverInput({ topologyQualifications: [artifact] }),
    );

    expect(result.outcome).toBe("selected");
    if (result.outcome !== "selected") return;
    (artifact.output as { masterAddress: string }).masterAddress = "192.168.100.99";
    expect(result.topologyQualification.output.masterAddress).toBe("192.168.100.10");
    expect(Object.isFrozen(result.topologyQualification.output)).toBe(true);
  });

  it.each([
    { provider: "vllm" },
    { vllmModel: "another/model" },
    { vllmExtraArguments: ["--another-option"] },
  ])("leaves existing inference intent authoritative for automatic selection", (intent) => {
    expect(
      resolveManagedInferenceServing({
        readinessReports: [],
        topologyQualifications: [],
        intent,
        now: NOW,
      }),
    ).toMatchObject({ outcome: "no-match", code: "explicit-intent" });
  });

  it("rejects an unknown explicit preset", () => {
    expect(
      resolveManagedInferenceServing(resolverInput({ intent: { preset: "vllm.unknown" } })),
    ).toMatchObject({ outcome: "rejected", code: "unknown-preset" });
  });

  it("rejects explicit preset intent that conflicts with its immutable recipe", () => {
    expect(
      resolveManagedInferenceServing(
        resolverInput({
          intent: { preset: DUAL_SPARK_PRESET_ID, vllmExtraArguments: ["--max-model-len", "1"] },
        }),
      ),
    ).toMatchObject({ outcome: "rejected", code: "incompatible-intent" });
  });

  it.each([
    {
      name: "stale provenance",
      report: readinessReport({
        provenance: {
          nemoclawVersion: "0.1.0",
          sourceRevision: SOURCE_REVISION,
          observedAt: "2026-08-02T17:00:00.000Z",
        },
      }),
    },
    {
      name: "incompatible report",
      report: readinessReport({ status: "incompatible", exitCode: 2 }),
    },
    {
      name: "blocking finding",
      report: readinessReport({
        findings: [{ id: "host.blocked", severity: "blocking", summary: "Blocked." }],
      }),
    },
    {
      name: "unknown Spark qualification",
      report: readinessReport({
        qualifications: [
          {
            id: "host.platform.dgx_spark",
            status: "unknown",
            capabilityIds: ["host.platform.dgx_spark"],
          },
        ],
      }),
    },
  ])("rejects $name before selecting a recipe", ({ report }) => {
    const sources = readinessSources();
    sources[1] = { nodeId: "spark-worker", report };

    expect(
      resolveManagedInferenceServing(resolverInput({ readinessReports: sources })),
    ).toMatchObject({ outcome: "rejected", code: "invalid-readiness" });
  });

  it("rejects a non-finite resolution time", () => {
    expect(
      resolveManagedInferenceServing(resolverInput({ now: new Date(Number.NaN) })),
    ).toMatchObject({ outcome: "rejected", code: "invalid-readiness" });
  });

  it.each([1, 3])("does not activate automatically for %i readiness reports", (count) => {
    const reports = [
      ...readinessSources(),
      { nodeId: "spark-third", report: readinessReport() },
    ].slice(0, count);

    expect(
      resolveManagedInferenceServing(resolverInput({ readinessReports: reports })),
    ).toMatchObject({ outcome: "no-match", code: "requirements-not-met" });
  });

  it("does not activate automatically without the qualified topology artifact", () => {
    expect(
      resolveManagedInferenceServing(resolverInput({ topologyQualifications: [] })),
    ).toMatchObject({ outcome: "no-match", code: "requirements-not-met" });
  });

  it("rejects a topology artifact for different physical subjects", () => {
    expect(
      resolveManagedInferenceServing(
        resolverInput({
          topologyQualifications: [topology({ subjectNodeIds: ["spark-head", "spark-third"] })],
        }),
      ),
    ).toMatchObject({ outcome: "rejected", code: "invalid-topology" });
  });

  it("rejects topology output mutated without a new digest", () => {
    const artifact = topology();
    (artifact.output as { masterAddress: string }).masterAddress = "192.168.100.99";

    expect(
      resolveManagedInferenceServing(resolverInput({ topologyQualifications: [artifact] })),
    ).toMatchObject({ outcome: "rejected", code: "invalid-topology" });
  });

  it("rejects a stale topology subject digest", () => {
    expect(
      resolveManagedInferenceServing(
        resolverInput({
          topologyQualifications: [topology({ subjectDigest: `sha256:${"f".repeat(64)}` })],
        }),
      ),
    ).toMatchObject({ outcome: "rejected", code: "invalid-topology" });
  });

  it("rejects an internally inconsistent topology with a recomputed output digest", () => {
    const artifact = topology();
    (artifact.output as { masterAddress: string }).masterAddress = "192.168.100.99";
    (artifact as { outputDigest: string }).outputDigest = dualSparkTopologyOutputDigest(
      artifact.output,
    );

    expect(
      resolveManagedInferenceServing(resolverInput({ topologyQualifications: [artifact] })),
    ).toMatchObject({ outcome: "rejected", code: "invalid-topology" });
  });

  it("rejects ambiguous topology artifacts", () => {
    expect(
      resolveManagedInferenceServing(
        resolverInput({ topologyQualifications: [topology(), topology()] }),
      ),
    ).toMatchObject({ outcome: "rejected", code: "invalid-topology" });
  });

  it("rejects missing requirements for an explicit preset instead of falling back", () => {
    expect(
      resolveManagedInferenceServing(
        resolverInput({
          readinessReports: readinessSources().slice(0, 1),
          intent: { preset: DUAL_SPARK_PRESET_ID },
        }),
      ),
    ).toMatchObject({ outcome: "rejected", code: "requirements-not-met" });
  });
});
