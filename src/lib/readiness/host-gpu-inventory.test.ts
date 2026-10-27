// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { HostAssessment } from "../onboard/preflight";
import {
  collectHostObservations,
  projectHostReadiness,
  type HostObservationSnapshot,
} from "./host";
import { createPublicHostProbeReadinessReport, renderReadinessReport } from "./presentation";
import { composeSystemReadinessReport } from "./system";

const NOW = new Date("2026-10-13T00:00:00.000Z");
const MIB = 1024 ** 2;
const GPUS = [
  { name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition", memoryMB: 97887 },
  { name: "NVIDIA GB300", memoryMB: 256703 },
];
const HOST: HostAssessment = {
  platform: "linux",
  isWsl: false,
  runtime: "docker",
  dockerInstalled: true,
  dockerRunning: true,
  dockerReachable: true,
  nodeInstalled: true,
  openshellInstalled: true,
  isContainerRuntimeUnderProvisioned: false,
  hasNestedOverlayConflict: false,
  requiresHostCgroupnsFix: false,
  isUnsupportedRuntime: false,
  isHeadlessLikely: false,
  hasNvidiaGpu: true,
  dockerCdiSpecDirs: [],
  cdiNvidiaGpuSpecMissing: false,
  nvidiaContainerToolkitInstalled: true,
  notes: [],
};

function collect(gpus: typeof GPUS | null = GPUS, hasNvidiaGpu = true) {
  return collectHostObservations({
    assess: () => ({ ...HOST, hasNvidiaGpu }),
    architecture: "arm64",
    detectGpu: () =>
      hasNvidiaGpu
        ? {
            count: gpus?.length ?? 2,
            gpus: gpus ?? undefined,
            totalMemoryMB: gpus?.reduce((total, gpu) => total + gpu.memoryMB, 0) ?? 354590,
            perGpuMB: 97887,
          }
        : null,
    detectNvidiaDriverVersion: () => "580.65.06",
    detectHostGpuPlatform: () => "linux",
    collectPlatformIdentity: () => ({
      productName: null,
      nvidiaPlatform: null,
      stationProfile: null,
      stationGb300PciGpu: null,
    }),
    now: () => NOW,
  });
}

function project(snapshot: HostObservationSnapshot) {
  return projectHostReadiness(snapshot, {
    nemoclawVersion: "0.1.0",
    sourceRevision: "697289aec2e0c5a1a2b8d2ed5a714b31bb5df4b4",
    now: () => NOW,
  });
}

function present(snapshot: HostObservationSnapshot) {
  return createPublicHostProbeReadinessReport(project(snapshot));
}

function devices(report: ReturnType<typeof present>) {
  return report.evidence.filter(({ id }) => id.startsWith("host.gpu.device."));
}

describe("host probe GPU inventory (#13019)", () => {
  it("reports both GPU names and memory sizes on an asymmetric host", () => {
    const report = present(collect());
    const json = JSON.parse(JSON.stringify(report)) as typeof report;

    expect(devices(json).map(({ details }) => details)).toEqual([
      { index: 0, name: GPUS[0]!.name, memoryBytes: 97887 * MIB },
      { index: 1, name: GPUS[1]!.name, memoryBytes: 256703 * MIB },
    ]);
    const total = devices(json).reduce((sum, gpu) => sum + Number(gpu.details?.memoryBytes), 0);
    expect(json.observations).toContainEqual({
      id: "host.gpu.memory_total_bytes",
      state: "present",
      value: total,
    });
    expect(json.observations).toContainEqual({
      id: "host.gpu.memory_per_device_bytes",
      state: "present",
      value: 97887 * MIB,
    });
    expect(json.mutated).toBe(false);
  });

  it("prints each GPU name and memory size in the text report", () => {
    const text = renderReadinessReport(present(collect()));

    expect(text).toContain(`GPU 0: ${GPUS[0]!.name} (97887 MiB)`);
    expect(text).toContain(`GPU 1: ${GPUS[1]!.name} (256703 MiB)`);
  });

  it("distinguishes GPUs that have the same model name", () => {
    const report = present(collect(GPUS.map((gpu) => ({ ...gpu, name: "NVIDIA GPU" }))));

    expect(devices(report).map(({ details }) => details?.index)).toEqual([0, 1]);
    expect(renderReadinessReport(report)).toContain("GPU 0: NVIDIA GPU (97887 MiB)");
    expect(renderReadinessReport(report)).toContain("GPU 1: NVIDIA GPU (256703 MiB)");
  });

  it("does not invent GPU devices when the detector only reports a count", () => {
    const report = present(collect(null));

    expect(devices(report)).toEqual([]);
    expect(report.observations).toContainEqual({
      id: "host.gpu.memory_per_device_bytes",
      state: "present",
      value: 97887 * MIB,
    });
    expect(renderReadinessReport(report)).not.toContain("GPU 0:");
  });

  it("omits GPU inventory on a CPU-only host", () => {
    const report = present(collect([], false));

    expect(devices(report)).toEqual([]);
    expect(renderReadinessReport(report)).not.toContain("GPUs:");
  });

  it.each([
    ["stale", { completedAt: new Date(NOW.getTime() - 30001).toISOString() }],
    ["failed", { failure: "GPU probe failed" }],
  ])("omits GPU inventory when collection is %s", (_state, overrides) => {
    const report = present({ ...collect(), ...overrides });

    expect(devices(report)).toEqual([]);
    expect(renderReadinessReport(report)).not.toContain(GPUS[1]!.name);
  });

  it("makes terminal controls in GPU names inert", () => {
    const report = present(collect([{ name: "NVIDIA\nGPU\u001b[31m", memoryMB: 97887 }]));

    expect(devices(report)[0]?.details?.name).toBe("NVIDIA\\u000aGPU\\u001b[31m");
    expect(renderReadinessReport(report)).toContain("NVIDIA\\u000aGPU\\u001b[31m");
    expect(renderReadinessReport(report)).not.toContain("\u001b");
  });

  it("keeps the memory size visible when a GPU name exceeds the report limit", () => {
    const report = present(collect([{ name: "NVIDIA ".repeat(200), memoryMB: 97887 }]));

    expect(String(devices(report)[0]?.details?.name).length).toBeLessThanOrEqual(512);
    expect(renderReadinessReport(report)).toContain("(97887 MiB)");
  });

  it("preserves the collected GPU inventory when detector objects change", () => {
    const gpus = GPUS.map((gpu) => ({ ...gpu }));
    const snapshot = collect(gpus);
    gpus[1]!.name = "changed";
    gpus[1]!.memoryMB = 1;

    expect(devices(present(snapshot))[1]?.details).toEqual({
      index: 1,
      name: GPUS[1]!.name,
      memoryBytes: 256703 * MIB,
    });
  });

  it.each([
    { count: 255, listed: 255, omitted: 0 },
    { count: 256, listed: 256, omitted: 0 },
    { count: 257, listed: 256, omitted: 1 },
  ])("reports inventory completeness for $count GPUs", ({ count, listed, omitted }) => {
    const projected = project(collect(Array.from({ length: count }, () => GPUS[0]!)));
    const original = structuredClone(projected);
    const report = createPublicHostProbeReadinessReport(projected);
    const json = JSON.parse(JSON.stringify(report)) as typeof report;

    expect(json.evidence).toHaveLength(listed);
    expect(devices(json)).toHaveLength(listed);
    expect(devices(json).at(-1)?.details?.index).toBe(listed - 1);
    expect(json.evidence[0]?.details).toEqual({
      index: 0,
      name: GPUS[0]!.name,
      memoryBytes: 97887 * MIB,
    });
    expect(json.gpuInventory).toEqual(omitted ? { collected: count, listed, omitted } : undefined);
    expect(json.evidence).toEqual(projected.evidence.slice(0, listed));
    expect(
      renderReadinessReport(json)
        .split("\n")
        .filter((line) => line.includes("inventory incomplete")),
    ).toEqual(
      omitted
        ? [`- GPU inventory incomplete: ${listed} of ${count} devices listed; ${omitted} omitted.`]
        : [],
    );
    expect(json.observations).toEqual(projected.observations);
    expect([json.status, json.exitCode, json.mutated]).toEqual([
      projected.status,
      projected.exitCode,
      false,
    ]);
    expect(createPublicHostProbeReadinessReport(report)).toEqual(report);
    expect(projected).toEqual(original);
  });

  it("retains platform and gateway evidence before unreferenced GPU rows", () => {
    const snapshot = collect(Array.from({ length: 256 }, () => GPUS[0]!));
    const host = project({
      ...snapshot,
      observations: {
        ...snapshot.observations!,
        platformIdentity: { ...snapshot.observations?.platformIdentity, productName: "GPU host" },
      },
    });
    const gatewayEvidence = { id: "gateway.diagnostic", summary: "Gateway diagnostic retained." };
    const composed = composeSystemReadinessReport(host, {
      observations: [],
      capabilities: [],
      findings: [],
      evidence: [gatewayEvidence],
    });
    const report = createPublicHostProbeReadinessReport(composed);

    expect(report.evidence).toHaveLength(256);
    expect(report.evidence).toContainEqual(
      expect.objectContaining({ id: "host.platform.identity" }),
    );
    expect(report.evidence).toContainEqual(gatewayEvidence);
    expect(devices(report)).toHaveLength(254);
    expect(report.gpuInventory).toEqual({
      collected: 256,
      listed: 254,
      omitted: 2,
    });
    expect(renderReadinessReport(report)).toContain(
      "GPU inventory incomplete: 254 of 256 devices listed; 2 omitted.",
    );
  });

  it.each(["device", "gateway"] as const)(
    "retains all required %s evidence when it fills the public evidence budget",
    (kind) => {
      const host = project(collect(Array.from({ length: 257 }, () => GPUS[0]!)));
      const required = Array.from({ length: 256 }, (_, index) =>
        kind === "device"
          ? host.evidence[index + 1]!
          : {
              id: `gateway.diagnostic.${index}`,
              summary: `Gateway diagnostic ${index}`,
              details: Object.fromEntries(
                Array.from({ length: 16 }, (_, key) => [`detail${key}`, key]),
              ),
            },
      );
      const report = createPublicHostProbeReadinessReport({
        ...host,
        observations: [
          ...host.observations,
          ...Array.from({ length: 8 }, (_, index) => ({
            id: `gateway.required.${index}`,
            state: "present" as const,
            evidenceIds: required.slice(index * 32, (index + 1) * 32).map(({ id }) => id),
          })),
        ],
        evidence: kind === "device" ? host.evidence : [...host.evidence, ...required],
      });
      const listed = kind === "device" ? 256 : 0;

      expect(report.evidence).toEqual(required);
      expect(report.gpuInventory).toEqual({
        collected: 257,
        listed,
        omitted: 257 - listed,
      });
      expect(Object.keys(report.evidence[0]?.details ?? {})).toHaveLength(
        kind === "device" ? 3 : 16,
      );
      expect(createPublicHostProbeReadinessReport(report)).toEqual(report);
      expect(renderReadinessReport(report)).toContain(
        `GPU inventory incomplete: ${listed} of 257 devices listed; ${257 - listed} omitted.`,
      );
    },
  );

  it("ignores GPU counts supplied by unrelated gateway evidence", () => {
    const host = present(collect([], false));
    const gateway = { id: "gateway.diagnostic", summary: "Gateway diagnostic." };
    const report = createPublicHostProbeReadinessReport({
      ...host,
      evidence: [
        ...host.evidence,
        {
          ...gateway,
          gpuInventoryCollected: 257,
          gpuInventoryListed: 0,
          gpuInventoryOmitted: 257,
        },
      ],
    });

    expect(report.gpuInventory).toBeUndefined();
    expect(report.evidence).toContainEqual(gateway);
    expect(renderReadinessReport(report)).not.toContain("GPUs:");
  });

  it.each([
    { summary: null },
    { summary: "unavailable" },
    { summary: [] },
    { summary: { collected: 3 } },
    { summary: { collected: "3", listed: 2, omitted: 1 } },
    { summary: { collected: 3, listed: Infinity, omitted: 1 } },
    { summary: { collected: 3, listed: 2, omitted: NaN } },
    { summary: { collected: 3, listed: -1, omitted: 4 } },
    { summary: { collected: 3, listed: 2, omitted: 2 } },
    { summary: { collected: 257, listed: 256, omitted: 1 } },
  ])("discards invalid inventory summary from public output: %j", ({ summary }) => {
    const report = present(collect());
    const invalidReport = { ...report, gpuInventory: summary } as unknown as typeof report;
    const sanitized = createPublicHostProbeReadinessReport(invalidReport);

    expect(renderReadinessReport(invalidReport)).not.toContain("inventory incomplete");
    expect(sanitized).not.toHaveProperty("gpuInventory");
    expect(sanitized.evidence).toEqual(report.evidence);
  });
});
