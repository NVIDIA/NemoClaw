// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { VllmProfile } from "../inference/vllm";
import { resolveHostLocalVllmSelection } from "../inference/serving/host-local-vllm-selection";
import { projectHostReadiness, type HostObservations } from "../readiness/host";
import type { SystemReadinessReport } from "../readiness/types";
import { makeDeps, makeHostState } from "./__test-helpers__/setup-nim-flow";
import {
  bindSetupNimForRun,
  createSetupNim,
  type SetupNim,
  type SetupNimFlowDeps,
} from "./setup-nim-flow";

function wslReport(
  proof: HostObservations["containerGpuProof"] | null = { providerId: "docker", passed: true },
  ageMs = 1000,
): SystemReadinessReport {
  const completedAt = new Date(Date.now() - ageMs).toISOString();
  return projectHostReadiness(
    {
      observedAt: completedAt,
      completedAt,
      observations: {
        platform: "linux",
        architecture: "arm64",
        isWsl: true,
        isHeadlessLikely: false,
        dockerInstalled: true,
        dockerReachable: true,
        dockerHostInvalid: false,
        runtime: "docker-desktop",
        dockerCgroupVersion: "v2",
        dockerDefaultCgroupnsMode: "private",
        dockerStorageDriver: "overlay2",
        dockerUsesContainerdSnapshotter: false,
        dockerNvidiaRuntimeAvailable: true,
        dockerCpus: 8,
        dockerMemTotalBytes: 32 * 1024 ** 3,
        isContainerRuntimeUnderProvisioned: false,
        hasNestedOverlayConflict: false,
        isUnsupportedRuntime: false,
        nodeInstalled: true,
        openshellInstalled: true,
        hasNvidiaGpu: true,
        nvidiaGpuCount: 1,
        nvidiaDriverVersion: "580.65.06",
        nvidiaGpuMemoryTotalBytes: 31232 * 1024 ** 2,
        nvidiaGpuMemoryAvailableBytes: 30613 * 1024 ** 2,
        nvidiaGpuMemoryPerDeviceBytes: 31232 * 1024 ** 2,
        hostGpuPlatform: "n1x",
        nvidiaContainerToolkitInstalled: false,
        dockerCdiSpecDirs: [],
        cdiNvidiaGpuSpecMissing: true,
        runtimeProviderId: "docker",
        runtimeProviderOwnsHostReadiness: false,
        containerGpuProof: proof ?? undefined,
        platformIdentity: {
          nvidiaPlatform: "linux",
          n1xWslGpu: true,
          n1xWslProduct: true,
          osId: "ubuntu",
          osVersionId: "24.04",
        },
      },
    },
    {
      nemoclawVersion: "0.1.0",
      sourceRevision: "a".repeat(40),
      now: () => new Date(completedAt),
    },
  );
}

const profile = { name: "N1x", platform: "n1x" } as VllmProfile;

function resolveSelection(options: Parameters<SetupNimFlowDeps["installVllm"]>[1]) {
  return resolveHostLocalVllmSelection(
    profile,
    {},
    {
      automatic: true,
      readinessReports: options.readinessReports,
    },
  );
}

async function runSelection(
  report?: SystemReadinessReport,
  evaluate: (
    options: Parameters<SetupNimFlowDeps["installVllm"]>[1],
  ) => ReturnType<typeof resolveHostLocalVllmSelection> | undefined = () => undefined,
) {
  const stopped = new Error("stop after selection");
  let result: ReturnType<typeof resolveHostLocalVllmSelection> | undefined;
  const installVllm = vi.fn<SetupNimFlowDeps["installVllm"]>(async (_profile, options) => {
    result = evaluate(options);
    return { ok: false };
  });
  const error = vi.fn();
  const setupNim = createSetupNim(
    makeDeps({
      getNonInteractiveProvider: () => "install-vllm",
      detectInferenceProviderHostState: () =>
        makeHostState({
          vllmProfile: profile,
          vllmEntries: [{ key: "install-vllm", label: "Install vLLM" }],
        }),
      installVllm,
      error,
      exitProcess: () => {
        throw stopped;
      },
    }),
  );
  await expect(
    setupNim(
      { platform: "n1x", containerGpuProof: { providerId: "docker", passed: true } } as never,
      null,
      null,
      true,
      null,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      report,
    ),
  ).rejects.toBe(stopped);
  return { installVllm, error, result };
}

describe("managed vLLM onboarding readiness", () => {
  it("reads the last preflight report when the current run selects a provider", async () => {
    let report = wslReport();
    const setup = vi.fn<SetupNim>();
    const bound = bindSetupNimForRun(setup, null, () => report);
    await bound(null, "sandbox", null, false, "gateway");
    expect(setup).toHaveBeenLastCalledWith(
      null,
      "sandbox",
      null,
      false,
      null,
      "gateway",
      undefined,
      undefined,
      undefined,
      undefined,
      report,
    );
    report = wslReport(null);
    await bound(null, "sandbox", null, false, "gateway");
    expect(setup.mock.calls[1]?.[10]).toBe(report);
    expect(setup.mock.calls[0]?.[10]).not.toBe(report);
  });

  it("passes the current run's Docker GPU proof without renewing its observation time (#12218)", async () => {
    const report = wslReport();
    const { installVllm } = await runSelection(report);
    expect(report.capabilities).toContainEqual(
      expect.objectContaining({
        id: "host.platform.wsl_gpu_passthrough",
        state: "present",
      }),
    );
    expect(installVllm).toHaveBeenCalledWith(
      profile,
      expect.objectContaining({
        readinessReports: [{ nodeId: expect.any(String), report }],
      }),
    );
    expect(installVllm.mock.calls[0]?.[1].readinessReports?.[0]?.report).toBe(report);
  });

  it.each(["host.runtime.provider", "host.gpu.container_proof_provider"])(
    "rejects a changed %s before calling the installer",
    async (id) => {
      const original = wslReport();
      const report = {
        ...original,
        observations: original.observations.map((entry) =>
          entry.id === id ? { ...entry, value: "podman" } : entry,
        ),
      };
      const { installVllm, error } = await runSelection(report);
      expect(installVllm).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining("different runtime provider"));
    },
  );

  it("keeps fresh collection when no preflight report is available", async () => {
    const { installVllm } = await runSelection();
    expect(installVllm.mock.calls[0]?.[1]).not.toHaveProperty("readinessReports");
  });

  it("keeps fresh collection for native hosts", async () => {
    const original = wslReport();
    const { installVllm } = await runSelection({
      ...original,
      observations: original.observations.map((entry) =>
        entry.id === "host.os.wsl" ? { ...entry, value: false } : entry,
      ),
    });
    expect(installVllm.mock.calls[0]?.[1]).not.toHaveProperty("readinessReports");
  });

  it.each([
    { name: "absent", proof: null, state: "unknown", reason: "host.platform.wsl_gpu_passthrough" },
    {
      name: "failed",
      proof: { providerId: "docker", passed: false },
      state: "absent",
      reason: "docker-desktop",
    },
  ])(
    "reports the remaining WSL restriction when proof is $name",
    async ({ proof, state, reason }) => {
      const report = wslReport(proof);
      const { result } = await runSelection(report, resolveSelection);
      expect(report.capabilities).toContainEqual(
        expect.objectContaining({ id: "host.platform.wsl_gpu_passthrough", state }),
      );
      expect(result).toMatchObject({
        kind: "rejected",
        reason: expect.stringContaining(reason),
      });
    },
  );

  it("rejects stale successful proof at the managed selection boundary", async () => {
    const { result } = await runSelection(wslReport(undefined, 60_000), resolveSelection);
    expect(result).toMatchObject({ kind: "rejected", reason: expect.stringContaining("stale") });
  });

  it("retains catalog restrictions after successful WSL GPU proof", async () => {
    const { result } = await runSelection(wslReport(), resolveSelection);
    expect(result).toMatchObject({
      kind: "rejected",
      reason: expect.stringContaining("docker-desktop"),
    });
    expect(result).not.toMatchObject({
      reason: expect.stringContaining("wsl_gpu_passthrough_inconclusive"),
    });
  });
});
