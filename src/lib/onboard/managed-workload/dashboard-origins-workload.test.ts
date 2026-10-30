// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const prepared = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("../workload/preparation", async (importOriginal) => {
  const original = await importOriginal<typeof import("../workload/preparation")>();
  return { ...original, prepareSandboxWorkloadSource: vi.fn(async () => prepared.value) };
});

vi.mock("../../core/version", () => ({
  getBuildIdentity: () => ({ nemoclawVersion: "0.0.0", sourceRevision: "d".repeat(40) }),
  getVersion: () => "v0.0.0",
}));

import { createManagedWorkloadOnboardRuntime } from "./onboard-orchestration";

function runtimeFor(source: Record<string, unknown>, dashboardOrigins: readonly string[]) {
  prepared.value = { source, release: "v0.0.0", fallbackDiagnostic: null };
  return createManagedWorkloadOnboardRuntime(
    {
      computePlan: { driverName: "docker" },
      managedWorkloadRebuild: null,
      tempManagedRuntime: false,
      stockManagedRuntime: false,
      tempManagedRuntimeCatalog: "/tmp/catalog.json",
      agentName: "openclaw",
      legacyDockerfilePath: "agents/openclaw/Dockerfile",
      customDockerfilePath: null,
      rootDir: "/tmp",
      model: "model",
      provider: "provider",
      preferredInferenceApi: null,
      endpointUrl: null,
      startupProfile: { environment: {}, dashboardOrigins },
      note: vi.fn(),
      fallbackBuildEstimate: () => null,
    } as unknown as Parameters<typeof createManagedWorkloadOnboardRuntime>[0],
    { resolveAgentInferenceApi: vi.fn(), getSandboxInferenceConfig: vi.fn() },
  );
}

const DOCKERFILE_SOURCE = {
  kind: "legacy-dockerfile",
  dockerfilePath: "agents/openclaw/Dockerfile",
  reason: "custom-dockerfile",
};

describe("dashboard origins on Dockerfile workloads (#13177)", () => {
  it("refuses extra dashboard origins for a Dockerfile build", async () => {
    await expect(
      runtimeFor(DOCKERFILE_SOURCE, [
        "https://launchpad.example.test:8443",
      ]).ensurePreparedWorkload(),
    ).rejects.toThrow(/--dashboard-origin.*managed OpenClaw image/);
  });

  it("keeps Dockerfile builds without extra origins unchanged", async () => {
    await expect(runtimeFor(DOCKERFILE_SOURCE, []).ensurePreparedWorkload()).resolves.toMatchObject(
      {
        source: { kind: "legacy-dockerfile" },
      },
    );
  });
});
