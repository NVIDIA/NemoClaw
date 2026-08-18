// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import systemReadinessSchema from "../../../schemas/system-readiness.schema.json" with { type: "json" };
import type { GpuDetection, NvidiaPlatform } from "../inference/nim";
import type { HostAssessment } from "../onboard/preflight";
import { collectHostObservations, createHostReadinessReport, projectHostReadiness } from "./host";

const { detectGpu, detectNvidiaDriverVersion, detectNvidiaPlatform } = vi.hoisted(() => ({
  detectGpu: vi.fn<(_deps?: unknown) => GpuDetection | null>(() => null),
  detectNvidiaDriverVersion: vi.fn<() => string | undefined>(() => undefined),
  detectNvidiaPlatform: vi.fn<() => NvidiaPlatform>(() => "linux"),
}));

vi.mock("../inference/nim", () => ({
  detectGpu,
  detectNvidiaDriverVersion,
  detectNvidiaPlatform,
}));

const NOW = new Date("2026-06-01T12:00:00Z");
const SOURCE_REVISION = "21e60ae287e8c2a184f71406ac8b418f046330d1";
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", { type: "string", validate: () => true });
const validateReport = ajv.compile(systemReadinessSchema as AnySchema);

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
    dockerNvidiaRuntimeAvailable: true,
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
    detectHostGpuPlatform?: () => NvidiaPlatform;
    platformIdentity?: ReturnType<typeof emptyPlatformIdentity>;
    wslDockerDesktopGpuProofPassed?: boolean;
  } = {},
) {
  return projectHostReadiness(
    collectHostObservations({
      assess: () => host(overrides),
      architecture: "x64",
      now: () => NOW,
      collectPlatformIdentity: () => collectionOptions.platformIdentity ?? emptyPlatformIdentity(),
      detectHostGpuPlatform: collectionOptions.detectHostGpuPlatform,
      wslDockerDesktopGpuProofPassed: collectionOptions.wslDockerDesktopGpuProofPassed,
    }),
    { nemoclawVersion: "0.1.0", sourceRevision: SOURCE_REVISION, now: () => NOW },
  );
}

function state(result: ReturnType<typeof report>, id: string) {
  return result.capabilities.find((entry) => entry.id === id)?.state;
}

function findingIds(result: ReturnType<typeof report>) {
  return result.findings.map(({ id }) => id);
}

describe("host readiness projection (#7408)", () => {
  beforeEach(() => {
    detectGpu.mockReset();
    detectGpu.mockReturnValue(null);
    detectNvidiaDriverVersion.mockReset();
    detectNvidiaDriverVersion.mockReturnValue(undefined);
    detectNvidiaPlatform.mockReset();
    detectNvidiaPlatform.mockReturnValue("linux");
  });

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
      projectHostReadiness(snapshot, {
        nemoclawVersion: "0.1.0",
        sourceRevision: SOURCE_REVISION,
        now: () => NOW,
      }).mutated,
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
  ] as const)(
    "returns stable results for %s",
    (overrides, capabilityId, expectedState, findingId) => {
      const result = report(overrides);

      expect(state(result, capabilityId)).toBe(expectedState);
      expect(findingIds(result)).toContain(findingId);
    },
  );

  it("blocks a reachable but unsupported DOCKER_HOST before using daemon evidence (#7411)", () => {
    const result = report({ dockerHostInvalid: true, dockerReachable: true });

    expect(result.status).toBe("incompatible");
    expect(state(result, "host.docker.endpoint_supported")).toBe("absent");
    expect(state(result, "host.docker.daemon_reachable")).toBe("unknown");
    expect(findingIds(result)).toContain("host.docker.host_invalid");
    expect(result.observations.find(({ id }) => id === "host.docker.runtime")?.state).toBe(
      "unknown",
    );
  });

  it("blocks an unsupported DOCKER_HOST in WSL (#7411)", () => {
    const result = report({
      dockerHostInvalid: true,
      dockerReachable: true,
      isWsl: true,
      runtime: "docker-desktop",
    });

    expect(state(result, "host.docker.endpoint_supported")).toBe("absent");
    expect(findingIds(result)).toContain("host.docker.host_invalid");
  });

  it("classifies an unsupported runtime as a blocking public finding (#7411)", () => {
    const result = report({ isUnsupportedRuntime: true, runtime: "podman" });

    expect(result.status).toBe("incompatible");
    expect(result.exitCode).toBe(2);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: "host.docker.runtime_unsupported",
        severity: "blocking",
      }),
    );
  });

  it("classifies an unsupported platform as incompatible instead of supported (#7411)", () => {
    const result = report({ platform: "darwin", runtime: "docker-desktop" });

    expect(result.status).toBe("incompatible");
    expect(result.exitCode).toBe(2);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ id: "host.platform.unsupported", severity: "blocking" }),
    );
  });

  it.each([
    [
      { cdiNvidiaGpuSpecMissing: true, nvidiaContainerToolkitInstalled: false },
      { detectHostGpuPlatform: () => "jetson" as const },
    ],
    [
      {
        isWsl: true,
        runtime: "docker-desktop",
        cdiNvidiaGpuSpecStale: true,
        nvidiaContainerToolkitInstalled: false,
      },
      { wslDockerDesktopGpuProofPassed: true },
    ],
  ] as const)("preserves CDI enforcement exclusions for %s", (overrides, collectionOptions) => {
    const result = report(overrides, collectionOptions);

    expect(state(result, "host.gpu.cdi_healthy")).toBe("present");
    expect(state(result, "host.gpu.container_toolkit_available")).toBe("present");
    expect(findingIds(result)).not.toContain("host.gpu.container_toolkit_missing");
    expect(findingIds(result)).not.toContain("host.gpu.cdi_missing");
    expect(findingIds(result)).not.toContain("host.gpu.cdi_stale");
    expect(result.status).toBe("supported");
  });

  it("uses canonical platform detection in the default report creator", () => {
    detectNvidiaPlatform.mockReturnValue("jetson");

    const result = createHostReadinessReport(
      { nemoclawVersion: "0.1.0", sourceRevision: SOURCE_REVISION, now: () => NOW },
      {
        assess: () => host({ cdiNvidiaGpuSpecMissing: true }),
        architecture: "arm64",
        collectPlatformIdentity: emptyPlatformIdentity,
      },
    );

    expect(detectNvidiaPlatform).toHaveBeenCalledOnce();
    expect(state(result, "host.gpu.cdi_healthy")).toBe("present");
    expect(findingIds(result)).not.toContain("host.gpu.cdi_missing");
    expect(result.status).toBe("supported");
  });

  it("recognizes a Jetson GPU through the canonical detector without nvidia-smi", () => {
    const result = createHostReadinessReport(
      { nemoclawVersion: "0.1.0", sourceRevision: SOURCE_REVISION, now: () => NOW },
      {
        assess: () =>
          host({
            hasNvidiaGpu: false,
            nvidiaContainerToolkitInstalled: false,
            cdiNvidiaGpuSpecMissing: true,
          }),
        architecture: "arm64",
        collectPlatformIdentity: emptyPlatformIdentity,
        detectGpu: () => ({ count: 1, platform: "jetson", type: "nvidia" }),
      },
    );

    expect(state(result, "host.gpu.nvidia_available")).toBe("present");
    expect(state(result, "host.gpu.container_toolkit_available")).toBe("present");
    expect(state(result, "host.gpu.cdi_healthy")).toBe("present");
    expect(findingIds(result)).not.toContain("host.gpu.container_toolkit_missing");
    expect(findingIds(result)).not.toContain("host.gpu.cdi_missing");
  });

  it("blocks Jetson GPU admission when Docker lacks the NVIDIA runtime", () => {
    const result = report(
      { dockerNvidiaRuntimeAvailable: false },
      { detectHostGpuPlatform: () => "jetson" },
    );

    expect(state(result, "host.gpu.container_toolkit_available")).toBe("absent");
    expect(result.observations).toContainEqual({
      id: "host.gpu.nvidia_runtime",
      state: "absent",
      value: false,
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        id: "host.gpu.nvidia_runtime_missing",
        severity: "blocking",
      }),
    );
  });

  it("projects bounded GPU count and driver observations for managed serving", () => {
    const result = createHostReadinessReport(
      { nemoclawVersion: "0.1.0", sourceRevision: SOURCE_REVISION, now: () => NOW },
      {
        assess: () => host(),
        architecture: "arm64",
        collectPlatformIdentity: () => ({
          nvidiaPlatform: "spark",
          productName: "NVIDIA DGX Spark",
        }),
        detectGpu: () => ({ count: 1 }),
        detectHostGpuPlatform: () => "spark",
        detectNvidiaDriverVersion: () => "580.65.06",
      },
    );

    expect(result.observations).toEqual(
      expect.arrayContaining([
        { id: "host.gpu.count", state: "present", value: 1 },
        { id: "host.gpu.driver_version", state: "present", value: "580.65.06" },
      ]),
    );
  });

  it("keeps the default WSL Docker Desktop GPU observation container-free", () => {
    const result = createHostReadinessReport(
      { nemoclawVersion: "0.1.0", sourceRevision: SOURCE_REVISION, now: () => NOW },
      {
        assess: () => host({ isWsl: true, runtime: "docker-desktop" }),
        architecture: "arm64",
        collectPlatformIdentity: emptyPlatformIdentity,
      },
    );

    expect(detectGpu).toHaveBeenCalledWith(
      expect.objectContaining({
        proveArm64WslDockerDesktopGpu: null,
        runCaptureImpl: expect.any(Function),
      }),
    );
    expect(state(result, "host.platform.wsl_gpu_passthrough")).toBe("unknown");
  });

  it("skips the WSL Docker Desktop GPU proof when Docker is unreachable", () => {
    const detectGpuProbe = vi.fn(() => ({
      count: 1,
      wslDockerDesktopGpuProofPassed: true,
    }));

    createHostReadinessReport(
      { nemoclawVersion: "0.1.0", sourceRevision: SOURCE_REVISION, now: () => NOW },
      {
        assess: () =>
          host({
            isWsl: true,
            runtime: "docker-desktop",
            dockerReachable: false,
            hasNvidiaGpu: true,
          }),
        architecture: "arm64",
        collectPlatformIdentity: emptyPlatformIdentity,
        detectGpu: detectGpuProbe,
      },
    );

    expect(detectGpuProbe).not.toHaveBeenCalled();
  });

  it("supports CPU-only hosts without requiring GPU tooling", () => {
    const result = report({
      hasNvidiaGpu: false,
      nvidiaContainerToolkitInstalled: false,
      dockerCdiSpecDirs: [],
      cdiNvidiaGpuSpecMissing: true,
      cdiNvidiaGpuSpecNeedsRepair: true,
    });

    expect(detectNvidiaPlatform).not.toHaveBeenCalled();
    expect(state(result, "host.gpu.nvidia_available")).toBe("absent");
    expect(state(result, "host.gpu.container_toolkit_available")).toBe("present");
    expect(state(result, "host.gpu.cdi_healthy")).toBe("present");
    expect(findingIds(result)).not.toContain("host.gpu.container_toolkit_missing");
    expect(findingIds(result)).not.toContain("host.gpu.cdi_missing");
    expect(result.status).toBe("supported");
  });

  it("reports supported remediation for the containerd overlay conflict (#7770)", () => {
    const result = report({
      dockerStorageDriver: "overlayfs",
      dockerUsesContainerdSnapshotter: true,
      hasNestedOverlayConflict: true,
    });

    expect(state(result, "host.docker.storage_compatible")).toBe("absent");
    expect(state(result, "host.docker.storage_remediation_available")).toBe("present");
    expect(findingIds(result)).toContain("host.docker.storage_incompatible");
    expect(result).toMatchObject({ status: "incompatible", exitCode: 2 });
  });

  it("reports no remediation when the containerd snapshotter is absent (#7770)", () => {
    const result = report({
      dockerStorageDriver: "overlayfs",
      dockerUsesContainerdSnapshotter: false,
      hasNestedOverlayConflict: true,
    });

    expect(state(result, "host.docker.storage_compatible")).toBe("absent");
    expect(state(result, "host.docker.storage_remediation_available")).toBe("absent");
    expect(findingIds(result)).toContain("host.docker.storage_incompatible");
    expect(result).toMatchObject({ status: "incompatible", exitCode: 2 });
  });

  it("derives stale CDI health when the optional repair state is absent", () => {
    const result = report({
      cdiNvidiaGpuSpecStale: true,
      cdiNvidiaGpuSpecNeedsRepair: undefined,
    });

    expect(state(result, "host.gpu.cdi_healthy")).toBe("absent");
    expect(findingIds(result)).toContain("host.gpu.cdi_stale");
  });

  // source-shape-contract: compatibility -- Generated readiness reports must conform to the published schema after redaction and truncation
  it("bounds and redacts successful probe text before schema validation", () => {
    const result = report({
      dockerStorageDriver: `token=driver-secret ${"x".repeat(1500)}`,
    });
    const storageDriver = result.observations.find(
      ({ id }) => id === "host.docker.storage_driver",
    )?.value;

    expect(storageDriver).not.toContain("driver-secret");
    expect(String(storageDriver).length).toBeLessThanOrEqual(1024);
    expect(validateReport(result), JSON.stringify(validateReport.errors)).toBe(true);
  });

  it("uses unknown for dependent facts when Docker is unreachable", () => {
    const result = report({ dockerReachable: false });

    expect(state(result, "host.docker.runtime_supported")).toBe("unknown");
    expect(state(result, "host.docker.resources_sufficient")).toBe("unknown");
    expect(state(result, "host.docker.storage_remediation_available")).toBe("unknown");
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
    const result = projectHostReadiness(snapshot, {
      nemoclawVersion: "0.1.0",
      sourceRevision: SOURCE_REVISION,
      now: () => NOW,
    });

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
    const snapshot = { ...current, completedAt: "2026-06-01T11:00:00Z" };
    const result = projectHostReadiness(snapshot, {
      nemoclawVersion: "0.1.0",
      sourceRevision: SOURCE_REVISION,
      now: () => NOW,
    });

    expect(result.status).toBe("inconclusive");
    expect(result.evidence.map(({ id }) => id)).toContain("host.probe.stale");
    expect(
      result.capabilities.every(({ state: capabilityState }) => capabilityState === "unknown"),
    ).toBe(true);
  });

  it.each(["2026-06-01T11:59:30Z", "2026-06-01T12:00:00Z"] as const)(
    "projects safe snapshot reuse at %s",
    (completedAt) => {
      const current = collectHostObservations({
        assess: () => host(),
        collectPlatformIdentity: emptyPlatformIdentity,
        now: () => NOW,
      });
      const result = projectHostReadiness(
        { ...current, completedAt },
        { nemoclawVersion: "0.1.0", sourceRevision: SOURCE_REVISION, now: () => NOW },
      );

      expect(result.status).toBe("supported");
      expect(result.evidence.map(({ id }) => id)).not.toContain("host.probe.stale");
    },
  );

  it("admits a collection that was itself slower than the reuse window (#9310)", () => {
    const clock = [new Date(NOW.getTime() - 45_000), NOW];
    let index = 0;

    const snapshot = collectHostObservations({
      assess: () => host(),
      collectPlatformIdentity: emptyPlatformIdentity,
      now: () => clock[Math.min(index++, clock.length - 1)] ?? NOW,
    });
    const result = projectHostReadiness(snapshot, {
      nemoclawVersion: "0.1.0",
      sourceRevision: SOURCE_REVISION,
      now: () => NOW,
    });

    expect(result.status).toBe("supported");
    expect(result.evidence.map(({ id }) => id)).not.toContain("host.probe.stale");
  });
});
