// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use a temp HOME so tests do not touch the real ~/.nemoclaw registry.
// HOME must be set before loading the registry module (it reads HOME at
// require time), so we use createRequire instead of a static import.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-meta-"));
const originalHome = process.env.HOME;
process.env.HOME = tmpHome;

// Import the compiled module: sandbox-registry-metadata.ts pulls in state/registry,
// which transitively requires the JS-only `./platform` helper that vitest cannot
// resolve from TS source. Same pattern as `vm-dns-monkeypatch.test.ts`.
import { createSandboxRegistryMetadataHelpers } from "../../../dist/lib/onboard/sandbox-registry-metadata";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

const require = createRequire(import.meta.url);
const registry = require("../../../dist/lib/state/registry");
const regFile = path.join(tmpHome, ".nemoclaw", "sandboxes.json");

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

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

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

describe("getSandboxRuntimeRegistryFields gatewayName", () => {
  it("omits gatewayName when no name is supplied so the reused path can preserve existing bindings", () => {
    const helpers = makeHelpers({ dockerDriverEnabled: true });
    const fields = helpers.getSandboxRuntimeRegistryFields(GPU_OFF);
    expect(fields.gatewayName).toBeUndefined();
  });

  it("emits gatewayName when supplied so fresh onboard registrations record the binding", () => {
    const helpers = makeHelpers({ dockerDriverEnabled: true });
    const fields = helpers.getSandboxRuntimeRegistryFields(GPU_OFF, "nemoclaw");
    expect(fields.gatewayName).toBe("nemoclaw");
  });
});

describe("updateReusedSandboxMetadata gatewayName migration", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    if (fs.existsSync(regFile)) fs.unlinkSync(regFile);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("backfills gatewayName via the port-resolved name on first reuse of a legacy entry", () => {
    // Legacy entry written before per-sandbox gateway tracking lacks the
    // field; reuse must record the active singleton name so future lifecycle
    // callers can resolve a stable binding.
    registry.registerSandbox({ name: "legacy", model: "m", provider: "p" });
    expect(registry.getSandbox("legacy").gatewayName).toBeUndefined();

    const helpers = makeHelpers({ dockerDriverEnabled: true });
    helpers.updateReusedSandboxMetadata("legacy", null, "m2", "p2", 8081);

    expect(registry.getSandbox("legacy").gatewayName).toBe("nemoclaw");
  });

  it("preserves an existing gatewayName binding on reuse", () => {
    // Once a sandbox carries an explicit binding, reuse must not overwrite it
    // — that protects per-sandbox bindings from being clobbered by the active
    // singleton when follow-up PRs flip the resolver to per-port names.
    registry.registerSandbox({ name: "alpha", gatewayName: "nemoclaw-8081" });

    const helpers = makeHelpers({ dockerDriverEnabled: true });
    helpers.updateReusedSandboxMetadata("alpha", null, "m", "p", 8090);

    expect(registry.getSandbox("alpha").gatewayName).toBe("nemoclaw-8081");
  });
});
