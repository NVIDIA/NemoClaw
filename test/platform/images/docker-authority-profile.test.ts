// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadManagedInferenceCatalog } from "../../../src/lib/inference/serving/catalog-loader";
import { resolveManagedInferenceServing } from "../../../src/lib/inference/serving/resolver";
import type { HostAssessment } from "../../../src/lib/onboard/preflight";
import { detectDockerHost } from "../../../src/lib/platform";
import { collectHostObservations, projectHostReadiness } from "../../../src/lib/readiness/host";

const NOW = new Date("2026-08-11T18:00:00.000Z");
const SOURCE_REVISION = "a".repeat(40);
const LIGHTNING_PROFILE_ID = "vllm.dgx-spark-gb10.single.nemotron-3.5-lightning-30b-a3b-nvfp4";

function host(runtime: "docker" | "podman"): HostAssessment {
  return {
    platform: "linux",
    isWsl: false,
    runtime,
    dockerInstalled: true,
    dockerRunning: true,
    dockerReachable: true,
    nodeInstalled: true,
    openshellInstalled: true,
    dockerCgroupVersion: "v2",
    dockerDefaultCgroupnsMode: "private",
    dockerStorageDriver: "overlay2",
    dockerUsesContainerdSnapshotter: false,
    dockerNvidiaRuntimeAvailable: true,
    dockerCpus: 20,
    dockerMemTotalBytes: 120 * 1024 ** 3,
    isContainerRuntimeUnderProvisioned: false,
    hasNestedOverlayConflict: false,
    requiresHostCgroupnsFix: false,
    isUnsupportedRuntime: runtime === "podman",
    isHeadlessLikely: false,
    hasNvidiaGpu: true,
    dockerCdiSpecDirs: ["/etc/cdi"],
    cdiNvidiaGpuSpecMissing: false,
    cdiNvidiaGpuSpecStale: false,
    cdiNvidiaGpuSpecNeedsRepair: false,
    nvidiaContainerToolkitInstalled: true,
    notes: [],
  };
}

describe("Docker authority readiness", () => {
  it("keeps a Docker-only Lightning profile compatible when Podman also has a socket (#8816)", () => {
    const sockets = new Set(["/run/user/1000/podman/podman.sock", "/var/run/docker.sock"]);
    const detection = detectDockerHost({
      env: {},
      platform: "linux",
      uid: 1000,
      existsSync: (candidate) => sockets.has(candidate),
      probeDockerHost: (dockerHost) =>
        dockerHost
          ? dockerHost.includes("podman")
            ? { reachable: true, identity: "podman" }
            : { reachable: true, identity: "docker" }
          : { reachable: true, identity: "docker" },
    });
    const runtime = detection?.dockerHost.includes("podman") ? "podman" : "docker";
    const report = projectHostReadiness(
      collectHostObservations({
        assess: () => host(runtime),
        architecture: "arm64",
        now: () => NOW,
        detectGpu: () => ({
          count: 1,
          platform: "spark",
          type: "nvidia",
          totalMemoryMB: 128 * 1024,
          availableMemoryMB: 128 * 1024,
          perGpuMB: 128 * 1024,
          unifiedMemory: true,
        }),
        detectNvidiaDriverVersion: () => "580.65.06",
        collectPlatformIdentity: () => ({
          nvidiaPlatform: "spark",
          productName: "NVIDIA DGX Spark",
          stationProfile: null,
          stationGb300PciGpu: null,
        }),
      }),
      { nemoclawVersion: "0.1.0", sourceRevision: SOURCE_REVISION, now: () => NOW },
    );
    const resolution = resolveManagedInferenceServing(
      {
        readinessReports: [{ nodeId: "spark", report }],
        topologyQualifications: [],
        intent: { preset: LIGHTNING_PROFILE_ID },
        now: NOW,
      },
      loadManagedInferenceCatalog(),
    );

    expect(detection).toBe(null);
    expect(report.observations.find(({ id }) => id === "host.docker.runtime")).toMatchObject({
      state: "present",
      value: "docker",
    });
    expect(resolution).toMatchObject({
      outcome: "selected",
      preset: { metadata: { id: LIGHTNING_PROFILE_ID } },
    });
  });
});
