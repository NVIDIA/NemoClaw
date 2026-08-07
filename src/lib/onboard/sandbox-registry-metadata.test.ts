// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../agent/defs";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

/**
 * Loads the compiled metadata helpers with an explicit resolved compute driver.
 */
async function makeHelpers(driverName: string) {
  // Import the compiled module: sandbox-registry-metadata.ts pulls in state/registry,
  // which transitively requires the JS-only `./platform` helper that vitest cannot
  // resolve from TS source. Same pattern as `vm-dns-monkeypatch.test.ts`.
  const metadata = await import("./sandbox-registry-metadata");
  return metadata.createSandboxRegistryMetadataHelpers({
    getOpenShellComputeDriverName: () => driverName,
    getInstalledOpenshellVersion: () => "0.0.42",
    runCaptureOpenshell: () => null,
  });
}

/**
 * Creates a minimal OpenClaw agent definition for metadata preservation tests.
 */
function openclawAgent(expectedVersion: string): AgentDefinition {
  return {
    name: "openclaw",
    expectedVersion,
  } as AgentDefinition;
}

const GPU_OFF: SandboxGpuConfig = {
  hostGpuDetected: false,
  hostGpuPlatform: null,
  sandboxGpuEnabled: false,
  mode: "auto",
  sandboxGpuDevice: null,
  errors: [],
};

describe("sandbox registry metadata", () => {
  const originalHome = process.env.HOME;
  let tmpDir: string | null = null;

  afterEach(() => {
    process.env.HOME = originalHome;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    vi.resetModules();
  });

  it("preserves the recorded agent version when reusing an existing sandbox", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nemoclaw-reuse-metadata-"));
    process.env.HOME = tmpDir;
    vi.resetModules();

    const metadata = await import("./sandbox-registry-metadata");

    const configDir = join(tmpDir, ".nemoclaw");
    const registryFile = join(configDir, "sandboxes.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      registryFile,
      JSON.stringify({
        sandboxes: {
          alpha: {
            name: "alpha",
            model: "old-model",
            provider: "old-provider",
            agentVersion: "2026.5.18",
          },
        },
        defaultSandbox: "alpha",
      }),
    );

    const readSandbox = () => JSON.parse(readFileSync(registryFile, "utf8")).sandboxes.alpha;

    expect(readSandbox()).toEqual({
      name: "alpha",
      model: "old-model",
      provider: "old-provider",
      agentVersion: "2026.5.18",
    });

    const helpers = metadata.createSandboxRegistryMetadataHelpers({
      getOpenShellComputeDriverName: () => "docker",
      getInstalledOpenshellVersion: () => "0.0.44",
      runCaptureOpenshell: () => "openshell 0.0.44",
    });

    helpers.updateReusedSandboxMetadata(
      "alpha",
      openclawAgent("2026.5.22"),
      "new-model",
      "nvidia-prod",
      18789,
    );

    expect(readSandbox()).toEqual(
      expect.objectContaining({
        model: "new-model",
        provider: "nvidia-prod",
        agentVersion: "2026.5.18",
      }),
    );
  });

  it("persists a reused terminal sandbox without a dashboard port for host allocation (#7020)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nemoclaw-reuse-terminal-metadata-"));
    process.env.HOME = tmpDir;
    vi.resetModules();

    const configDir = join(tmpDir, ".nemoclaw");
    const registryFile = join(configDir, "sandboxes.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      registryFile,
      JSON.stringify({
        sandboxes: {
          "terminal-box": {
            name: "terminal-box",
            model: "old-model",
            provider: "old-provider",
            dashboardPort: 18789,
          },
        },
        defaultSandbox: "terminal-box",
      }),
    );

    const metadata = await import("./sandbox-registry-metadata");
    const dashboardPorts = await import("./dashboard-port");
    const gatewayRegistry = await import("../state/gateway-registry");
    const helpers = metadata.createSandboxRegistryMetadataHelpers({
      getOpenShellComputeDriverName: () => "docker",
      getInstalledOpenshellVersion: () => "0.0.44",
      runCaptureOpenshell: () => "openshell 0.0.44",
    });

    helpers.updateReusedSandboxMetadata(
      "terminal-box",
      { name: "langchain-deepagents-code" } as AgentDefinition,
      "new-model",
      "nvidia-prod",
      0,
    );

    const persisted = JSON.parse(readFileSync(registryFile, "utf8"));
    expect(persisted.sandboxes["terminal-box"].dashboardPort).toBeNull();

    const hostEntries = gatewayRegistry.listHostGatewayRegistryEntries(tmpDir);
    expect(hostEntries).toHaveLength(1);
    expect(hostEntries[0].entry.dashboardPort).toBeNull();

    const occupied = dashboardPorts.getRegistryOccupiedDashboardPorts("other-sandbox");
    expect(occupied.size).toBe(0);
    expect(
      dashboardPorts.findAvailableDashboardPort(
        "other-sandbox",
        18789,
        null,
        () => false,
        occupied,
      ),
    ).toBe(18789);
  });
});

describe("getSandboxRuntimeRegistryFields openshellDriver", () => {
  it("records the resolved Docker compute driver (#7744)", async () => {
    const helpers = await makeHelpers("docker");

    const fields = helpers.getSandboxRuntimeRegistryFields(GPU_OFF);

    expect(fields.openshellDriver).toBe("docker");
  });

  it("records the resolved Kubernetes compute driver (#7744)", async () => {
    const helpers = await makeHelpers("kubernetes");

    const fields = helpers.getSandboxRuntimeRegistryFields(GPU_OFF);

    expect(fields.openshellDriver).toBe("kubernetes");
  });

  it.each([
    "podman",
    "mxc",
  ])("passes the resolved %s driver through to registry metadata (#7744)", async (driverName) => {
    const helpers = await makeHelpers(driverName);

    const fields = helpers.getSandboxRuntimeRegistryFields(GPU_OFF);

    expect(fields.openshellDriver).toBe(driverName);
  });

  it("resolves driver identity when metadata is recorded rather than at module load (#7744)", async () => {
    const metadata = await import("./sandbox-registry-metadata");
    let driverName = "docker";
    const helpers = metadata.createSandboxRegistryMetadataHelpers({
      getOpenShellComputeDriverName: () => driverName,
      getInstalledOpenshellVersion: () => "0.0.42",
      runCaptureOpenshell: () => null,
    });

    driverName = "kubernetes";

    expect(helpers.getSandboxRuntimeRegistryFields(GPU_OFF).openshellDriver).toBe("kubernetes");
  });
});
