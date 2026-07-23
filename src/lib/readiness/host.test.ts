// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { HostAssessment } from "../onboard/preflight";
import { collectHostObservations, projectHostReadiness } from "./host";

const NOW = new Date("2026-06-01T12:00:00Z");

function emptyPlatformIdentity() {
  return {
    productName: null,
    nvidiaPlatform: null,
    stationProfile: null,
    stationGb300PciGpu: null,
  };
}

function host(overrides: Partial<HostAssessment> = {}): HostAssessment {
  return {
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
    dockerCpus: 8,
    dockerMemTotalBytes: 16 * 1024 ** 3,
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
    ...overrides,
  };
}

function report(
  overrides: Partial<HostAssessment> = {},
  collectionOptions: {
    hostGpuPlatform?: string;
    platformIdentity?: ReturnType<typeof emptyPlatformIdentity>;
  } = {},
) {
  return projectHostReadiness(
    collectHostObservations({
      assess: () => host(overrides),
      architecture: "x64",
      now: () => NOW,
      collectPlatformIdentity: () => collectionOptions.platformIdentity ?? emptyPlatformIdentity(),
      hostGpuPlatform: collectionOptions.hostGpuPlatform,
    }),
    { nemoclawVersion: "0.1.0", now: () => NOW },
  );
}

function state(result: ReturnType<typeof report>, id: string) {
  return result.capabilities.find((entry) => entry.id === id)?.state;
}

function findingIds(result: ReturnType<typeof report>) {
  return result.findings.map(({ id }) => id);
}

describe("host readiness projection (#7408)", () => {
  it("keeps collection dependency-injected and separate from pure evaluation", () => {
    const assess = vi.fn(() => host());
    const snapshot = collectHostObservations({
      assess,
      collectPlatformIdentity: emptyPlatformIdentity,
      now: () => NOW,
    });

    expect(assess).toHaveBeenCalledOnce();
    expect(snapshot.observations).toMatchObject({ platform: "linux", architecture: process.arch });
    expect(
      projectHostReadiness(snapshot, { nemoclawVersion: "0.1.0", now: () => NOW }).mutated,
    ).toBe(false);
  });

  it.each([
    [
      { dockerInstalled: false, dockerReachable: false },
      "host.docker.available",
      "absent",
      "host.docker.unavailable",
    ],
    [
      { dockerReachable: false },
      "host.docker.daemon_reachable",
      "absent",
      "host.docker.daemon_unreachable",
    ],
    [
      { isContainerRuntimeUnderProvisioned: true },
      "host.docker.resources_sufficient",
      "absent",
      "host.docker.resources_insufficient",
    ],
    [
      { isUnsupportedRuntime: true, runtime: "podman" },
      "host.docker.runtime_supported",
      "absent",
      "host.docker.runtime_unsupported",
    ],
    [
      { nvidiaContainerToolkitInstalled: false },
      "host.gpu.container_toolkit_available",
      "absent",
      "host.gpu.container_toolkit_missing",
    ],
    [
      { cdiNvidiaGpuSpecMissing: true, cdiNvidiaGpuSpecNeedsRepair: true },
      "host.gpu.cdi_healthy",
      "absent",
      "host.gpu.cdi_missing",
    ],
    [
      { cdiNvidiaGpuSpecStale: true, cdiNvidiaGpuSpecNeedsRepair: true },
      "host.gpu.cdi_healthy",
      "absent",
      "host.gpu.cdi_stale",
    ],
  ] as const)("returns stable results for %s", (overrides, capabilityId, expectedState, findingId) => {
    const result = report(overrides);

    expect(state(result, capabilityId)).toBe(expectedState);
    expect(findingIds(result)).toContain(findingId);
  });

  it.each([
    [{ cdiNvidiaGpuSpecMissing: true }, { hostGpuPlatform: "jetson" }],
    [
      { isWsl: true, runtime: "docker-desktop", cdiNvidiaGpuSpecStale: true },
      { hostGpuPlatform: undefined },
    ],
  ] as const)("preserves CDI enforcement exclusions for %s", (overrides, collectionOptions) => {
    const result = report(overrides, collectionOptions);

    expect(state(result, "host.gpu.cdi_healthy")).toBe("unknown");
    expect(findingIds(result)).not.toContain("host.gpu.cdi_missing");
    expect(findingIds(result)).not.toContain("host.gpu.cdi_stale");
    expect(result.status).not.toBe("incompatible");
  });

  it("uses unknown for dependent facts when Docker is unreachable", () => {
    const result = report({ dockerReachable: false });

    expect(state(result, "host.docker.runtime_supported")).toBe("unknown");
    expect(state(result, "host.docker.resources_sufficient")).toBe("unknown");
    expect(result.observations.find(({ id }) => id === "host.docker.runtime")?.state).toBe(
      "unknown",
    );
  });

  it("bounds and redacts failed probe evidence and projects unknown", () => {
    const failure = `Authorization: Bearer top-secret token=other-secret ${"x".repeat(1500)}`;
    const snapshot = collectHostObservations({
      assess: () => {
        throw new Error(failure);
      },
      now: () => NOW,
    });
    const result = projectHostReadiness(snapshot, { nemoclawVersion: "0.1.0", now: () => NOW });

    expect(result.status).toBe("inconclusive");
    expect(
      result.capabilities.every(({ state: capabilityState }) => capabilityState === "unknown"),
    ).toBe(true);
    expect(result.evidence[0]?.summary).not.toContain("top-secret");
    expect(result.evidence[0]?.summary).not.toContain("other-secret");
    expect(result.evidence[0]?.summary.length).toBeLessThanOrEqual(1024);
  });

  it("rejects stale observations unless reuse is explicitly safe", () => {
    const current = collectHostObservations({
      assess: () => host(),
      collectPlatformIdentity: emptyPlatformIdentity,
      now: () => NOW,
    });
    const snapshot = { ...current, observedAt: "2026-06-01T11:00:00Z", reusable: false };
    const result = projectHostReadiness(snapshot, { nemoclawVersion: "0.1.0", now: () => NOW });

    expect(result.status).toBe("inconclusive");
    expect(result.evidence.map(({ id }) => id)).toContain("host.probe.stale");
    expect(
      result.capabilities.every(({ state: capabilityState }) => capabilityState === "unknown"),
    ).toBe(true);
  });

  it.each([
    ["2026-06-01T11:00:00Z", true],
    ["2026-06-01T11:59:30Z", false],
  ] as const)("projects safe snapshot reuse at %s", (observedAt, reusable) => {
    const current = collectHostObservations({
      assess: () => host(),
      collectPlatformIdentity: emptyPlatformIdentity,
      now: () => NOW,
    });
    const result = projectHostReadiness(
      { ...current, observedAt, reusable },
      { nemoclawVersion: "0.1.0", now: () => NOW },
    );

    expect(result.status).toBe("supported");
    expect(result.evidence.map(({ id }) => id)).not.toContain("host.probe.stale");
  });
});
