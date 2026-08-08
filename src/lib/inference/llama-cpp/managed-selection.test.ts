// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createHostReadinessReport } from "../../readiness/host";
import type { SystemReadinessReport } from "../../readiness/types";
import { loadManagedInferenceCatalog } from "../serving/catalog-loader";
import type { ManagedInferenceServingPreset } from "../serving/types";
import { LLAMA_CPP_RECIPE_ENV } from "./contract";
import { resolveManagedLlamaCppSelection } from "./managed-selection";

const RECIPE_ID = "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1";
const GENERIC_PRESET_ID = "llama-cpp.linux-amd64-nvidia.single.nemotron-3-nano-30b-a3b";
const SPARK_PRESET_ID = "llama-cpp.dgx-spark-gb10.single.nemotron-3-nano-30b-a3b";

function readinessReport(
  preset: ManagedInferenceServingPreset,
  overrides: Partial<SystemReadinessReport> = {},
): SystemReadinessReport {
  const requirements = preset.spec.requirements.all.flatMap((requirement) =>
    "readiness" in requirement ? [requirement.readiness] : [],
  );
  return {
    schemaVersion: "1.1.0",
    mutated: false,
    provenance: {
      nemoclawVersion: "0.1.0",
      sourceRevision: "a".repeat(40),
      observedAt: new Date().toISOString(),
    },
    observations: requirements.flatMap((requirement) =>
      requirement.kind !== "observation"
        ? []
        : "state" in requirement
          ? [{ id: requirement.id, state: requirement.state }]
          : [
              {
                id: requirement.id,
                state: "present" as const,
                value:
                  requirement.comparison.operator === "one-of"
                    ? requirement.comparison.values[0]
                    : requirement.comparison.value,
              },
            ],
    ),
    capabilities: requirements.flatMap((requirement) =>
      requirement.kind === "capability" ? [{ id: requirement.id, state: requirement.state }] : [],
    ),
    qualifications: requirements.flatMap((requirement) =>
      requirement.kind === "qualification"
        ? [{ id: requirement.id, status: requirement.status }]
        : [],
    ),
    findings: [],
    evidence: [],
    status: "supported",
    exitCode: 0,
    ...overrides,
  } as SystemReadinessReport;
}

function fixture(presetId = SPARK_PRESET_ID) {
  const catalog = loadManagedInferenceCatalog();
  const preset = catalog.presets.find(({ metadata }) => metadata.id === presetId);
  expect(preset, "Shipped managed llama.cpp preset is missing.").toBeDefined();
  return { catalog, preset: preset!, report: readinessReport(preset!) };
}

describe("managed llama.cpp selection", () => {
  it("selects from the production host-readiness projection for a qualified DGX Spark", () => {
    const { catalog } = fixture();
    const now = new Date();
    const report = createHostReadinessReport(
      {
        nemoclawVersion: "0.1.0",
        sourceRevision: "a".repeat(40),
        now: () => now,
      },
      {
        now: () => now,
        architecture: "arm64",
        assess: () => ({
          platform: "linux",
          isWsl: false,
          runtime: "docker",
          dockerInstalled: true,
          dockerRunning: true,
          dockerReachable: true,
          nodeInstalled: true,
          openshellInstalled: true,
          dockerCgroupVersion: "v2",
          dockerDefaultCgroupnsMode: "private",
          dockerStorageDriver: "overlay2",
          dockerUsesContainerdSnapshotter: false,
          dockerCpus: 20,
          dockerMemTotalBytes: 128 * 1024 ** 3,
          isContainerRuntimeUnderProvisioned: false,
          hasNestedOverlayConflict: false,
          requiresHostCgroupnsFix: false,
          isUnsupportedRuntime: false,
          isHeadlessLikely: false,
          hasNvidiaGpu: true,
          dockerCdiSpecDirs: ["/etc/cdi"],
          cdiNvidiaGpuSpecMissing: false,
          cdiNvidiaGpuSpecStale: false,
          cdiNvidiaGpuSpecNeedsRepair: false,
          nvidiaContainerToolkitInstalled: true,
          notes: [],
        }),
        collectPlatformIdentity: () => ({
          nvidiaPlatform: "spark",
          productName: "NVIDIA DGX Spark",
        }),
        detectGpu: () => ({ count: 1 }),
        detectHostGpuPlatform: () => "spark",
        detectNvidiaDriverVersion: () => "580.65.06",
      },
    );

    expect(resolveManagedLlamaCppSelection({}, catalog, report).kind).toBe("selected");
  });

  it("selects the one shipped declarative recipe by default", () => {
    const { catalog, report } = fixture();

    const resolved = resolveManagedLlamaCppSelection({}, catalog, report);

    expect(resolved).toMatchObject({
      kind: "selected",
      selection: {
        recipe: { metadata: { id: RECIPE_ID } },
        preset: { spec: { plan: { backend: "install-llama-cpp" } } },
      },
    });
  });

  it("selects the generic Linux amd64 NVIDIA GPU preset from the same declarative recipe", () => {
    const { catalog } = fixture(GENERIC_PRESET_ID);
    const now = new Date();
    const report = createHostReadinessReport(
      {
        nemoclawVersion: "0.1.0",
        sourceRevision: "a".repeat(40),
        now: () => now,
      },
      {
        now: () => now,
        architecture: "x64",
        assess: () => ({
          platform: "linux",
          isWsl: false,
          runtime: "docker",
          dockerInstalled: true,
          dockerRunning: true,
          dockerReachable: true,
          nodeInstalled: true,
          openshellInstalled: true,
          dockerCgroupVersion: "v2",
          dockerDefaultCgroupnsMode: "private",
          dockerStorageDriver: "overlay2",
          dockerUsesContainerdSnapshotter: false,
          dockerCpus: 16,
          dockerMemTotalBytes: 64 * 1024 ** 3,
          isContainerRuntimeUnderProvisioned: false,
          hasNestedOverlayConflict: false,
          requiresHostCgroupnsFix: false,
          isUnsupportedRuntime: false,
          isHeadlessLikely: true,
          hasNvidiaGpu: true,
          dockerCdiSpecDirs: ["/etc/cdi"],
          cdiNvidiaGpuSpecMissing: false,
          cdiNvidiaGpuSpecStale: false,
          cdiNvidiaGpuSpecNeedsRepair: false,
          nvidiaContainerToolkitInstalled: true,
          notes: [],
        }),
        collectPlatformIdentity: () => ({
          nvidiaPlatform: "linux",
          productName: "NVIDIA RTX PRO 6000 Blackwell Server Edition",
        }),
        detectGpu: () => ({ count: 1 }),
        detectHostGpuPlatform: () => "linux",
        detectNvidiaDriverVersion: () => "580.65.06",
      },
    );

    const resolved = resolveManagedLlamaCppSelection(
      { [LLAMA_CPP_RECIPE_ENV]: RECIPE_ID },
      catalog,
      report,
    );

    expect(resolved).toMatchObject({
      kind: "selected",
      selection: {
        recipe: { metadata: { id: RECIPE_ID } },
        preset: { metadata: { id: GENERIC_PRESET_ID } },
      },
    });
  });

  it("rejects a host that matches more than one hardware preset for one recipe", () => {
    const { catalog, preset, report } = fixture(GENERIC_PRESET_ID);
    const duplicate = {
      ...preset,
      metadata: { ...preset.metadata, id: `${GENERIC_PRESET_ID}.duplicate` },
    };

    const resolved = resolveManagedLlamaCppSelection(
      { [LLAMA_CPP_RECIPE_ENV]: RECIPE_ID },
      { ...catalog, presets: [...catalog.presets, duplicate] },
      report,
    );

    expect(resolved).toEqual({
      kind: "rejected",
      reason: `Managed llama.cpp recipe ${RECIPE_ID} matches more than one explicit serving preset: ${GENERIC_PRESET_ID}, ${GENERIC_PRESET_ID}.duplicate.`,
    });
  });

  it("selects an explicitly named shipped recipe", () => {
    const { catalog, report } = fixture();

    const resolved = resolveManagedLlamaCppSelection(
      { [LLAMA_CPP_RECIPE_ENV]: RECIPE_ID },
      catalog,
      report,
    );

    expect(resolved.kind).toBe("selected");
  });

  it("rejects a model override outside the declarative recipe", () => {
    const { catalog, report } = fixture();

    const resolved = resolveManagedLlamaCppSelection(
      { [LLAMA_CPP_RECIPE_ENV]: RECIPE_ID, NEMOCLAW_MODEL: "another/model" },
      catalog,
      report,
    );

    expect(resolved).toEqual({
      kind: "rejected",
      reason: `NEMOCLAW_MODEL cannot override the served model in ${LLAMA_CPP_RECIPE_ENV}.`,
    });
  });

  it("rejects stale host readiness before activation", () => {
    const { catalog, preset } = fixture();
    const stale = readinessReport(preset, {
      provenance: {
        nemoclawVersion: "0.1.0",
        sourceRevision: "a".repeat(40),
        observedAt: "2026-08-01T00:00:00.000Z",
      },
    });

    const resolved = resolveManagedLlamaCppSelection({}, catalog, stale);

    expect(resolved).toMatchObject({
      kind: "rejected",
      reason: expect.stringContaining("stale or has an invalid observation time"),
    });
  });
});
