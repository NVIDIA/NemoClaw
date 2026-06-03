// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../agent/defs";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");

/**
 * Overrides process.platform for runtime-driver metadata tests.
 */
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/**
 * Restores the original process.platform descriptor after each platform-specific assertion.
 */
function restorePlatform(): void {
  if (ORIGINAL_PLATFORM) {
    Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
  }
}

/**
 * Loads the compiled metadata helpers after each test has configured process state.
 */
async function makeHelpers(opts: { dockerDriverEnabled: boolean }) {
  // Import the compiled module: sandbox-registry-metadata.ts pulls in state/registry,
  // which transitively requires the JS-only `./platform` helper that vitest cannot
  // resolve from TS source. Same pattern as `vm-dns-monkeypatch.test.ts`.
  const metadata = await import("../../../dist/lib/onboard/sandbox-registry-metadata");
  return metadata.createSandboxRegistryMetadataHelpers({
    isLinuxDockerDriverGatewayEnabled: () => opts.dockerDriverEnabled,
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

    const metadata = await import("../../../dist/lib/onboard/sandbox-registry-metadata");

    const configDir = join(tmpDir, ".nemoclaw");
    const registryFile = join(configDir, "sandboxes.json");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(registryFile, JSON.stringify({
      sandboxes: {
        alpha: {
          name: "alpha",
          model: "old-model",
          provider: "old-provider",
          agentVersion: "2026.5.18",
        },
      },
      defaultSandbox: "alpha",
    }));

    const readSandbox = () => JSON.parse(readFileSync(registryFile, "utf8")).sandboxes.alpha;

    expect(readSandbox()).toEqual({
      name: "alpha",
      model: "old-model",
      provider: "old-provider",
      agentVersion: "2026.5.18",
    });

    const helpers = metadata.createSandboxRegistryMetadataHelpers({
      isLinuxDockerDriverGatewayEnabled: () => true,
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
});

describe("getSandboxRuntimeRegistryFields openshellDriver", () => {
  afterEach(restorePlatform);

  it("records Docker for macOS sandboxes on the Docker-driver gateway path", async () => {
    setPlatform("darwin");
    const helpers = await makeHelpers({ dockerDriverEnabled: true });

    const fields = helpers.getSandboxRuntimeRegistryFields(GPU_OFF);

    expect(fields.openshellDriver).toBe("docker");
  });

  it("records Docker for Linux sandboxes on the Docker-driver gateway path", async () => {
    setPlatform("linux");
    const helpers = await makeHelpers({ dockerDriverEnabled: true });

    const fields = helpers.getSandboxRuntimeRegistryFields(GPU_OFF);

    expect(fields.openshellDriver).toBe("docker");
  });

  it("records Kubernetes for legacy Linux sandboxes when the Docker-driver gateway is disabled", async () => {
    setPlatform("linux");
    const helpers = await makeHelpers({ dockerDriverEnabled: false });

    const fields = helpers.getSandboxRuntimeRegistryFields(GPU_OFF);

    expect(fields.openshellDriver).toBe("kubernetes");
  });
});
