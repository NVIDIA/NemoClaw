// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
// Import the compiled module: sandbox-registry-metadata.ts pulls in state/registry,
// which transitively requires the JS-only `./platform` helper that vitest cannot
// resolve from TS source. Same pattern as `vm-dns-monkeypatch.test.ts`.
import { createSandboxRegistryMetadataHelpers } from "../../../dist/lib/onboard/sandbox-registry-metadata";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function restorePlatform(): void {
  if (ORIGINAL_PLATFORM) {
    Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
  }
}

function makeHelpers(opts: { dockerDriverEnabled: boolean }) {
  return createSandboxRegistryMetadataHelpers({
    isLinuxDockerDriverGatewayEnabled: () => opts.dockerDriverEnabled,
    getInstalledOpenshellVersion: () => "0.0.42",
    runCaptureOpenshell: () => null,
  });
}

const GPU_OFF: SandboxGpuConfig = {
  hostGpuDetected: false,
  hostGpuPlatform: null,
  sandboxGpuEnabled: false,
  mode: "auto",
  sandboxGpuDevice: null,
  errors: [],
};

describe("getSandboxRuntimeRegistryFields openshellDriver", () => {
  afterEach(restorePlatform);

  it("records Docker for macOS sandboxes on the Docker-driver gateway path", () => {
    setPlatform("darwin");
    const helpers = makeHelpers({ dockerDriverEnabled: true });

    const fields = helpers.getSandboxRuntimeRegistryFields(GPU_OFF);

    expect(fields.openshellDriver).toBe("docker");
  });

  it("records Docker for Linux sandboxes on the Docker-driver gateway path", () => {
    setPlatform("linux");
    const helpers = makeHelpers({ dockerDriverEnabled: true });

    const fields = helpers.getSandboxRuntimeRegistryFields(GPU_OFF);

    expect(fields.openshellDriver).toBe("docker");
  });

  it("records Kubernetes for legacy Linux sandboxes when the Docker-driver gateway is disabled", () => {
    setPlatform("linux");
    const helpers = makeHelpers({ dockerDriverEnabled: false });

    const fields = helpers.getSandboxRuntimeRegistryFields(GPU_OFF);

    expect(fields.openshellDriver).toBe("kubernetes");
  });
});
