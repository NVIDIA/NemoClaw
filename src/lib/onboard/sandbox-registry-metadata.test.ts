// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../agent/defs";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";

// Use a temp HOME so tests do not touch the real ~/.nemoclaw registry. Both
// the helper and the registry modules read HOME at require time, so HOME must
// be set before they load. Static ESM imports are hoisted ahead of any module
// body statement, so both modules must be loaded via `createRequire` after
// the HOME mutation runs. Same pattern as `vm-dns-monkeypatch.test.ts`.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-meta-"));
const originalHome = process.env.HOME;
process.env.HOME = tmpHome;

const require = createRequire(import.meta.url);
const registry: typeof import("../state/registry") = require(
  "../../../dist/lib/state/registry",
);
const { createSandboxRegistryMetadataHelpers }: typeof import("./sandbox-registry-metadata") =
  require("../../../dist/lib/onboard/sandbox-registry-metadata");
const regFile = path.join(tmpHome, ".nemoclaw", "sandboxes.json");

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

function makeHelpers(opts: { dockerDriverEnabled: boolean; activeGatewayName?: string }) {
  return createSandboxRegistryMetadataHelpers({
    isLinuxDockerDriverGatewayEnabled: () => opts.dockerDriverEnabled,
    getInstalledOpenshellVersion: () => "0.0.42",
    runCaptureOpenshell: () => null,
    getActiveGatewayName: () => opts.activeGatewayName ?? "nemoclaw",
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

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("sandbox registry metadata", () => {
  beforeEach(() => {
    if (fs.existsSync(regFile)) fs.unlinkSync(regFile);
  });

  it("preserves the recorded agent version when reusing an existing sandbox", () => {
    // The reused-sandbox path must not clobber an existing recorded agent
    // version. Seed a legacy entry that already carries an agentVersion, run
    // updateReusedSandboxMetadata with a different expected version, and
    // assert the persisted record keeps the original.
    const configDir = path.join(tmpHome, ".nemoclaw");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      regFile,
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

    const readSandbox = () => JSON.parse(fs.readFileSync(regFile, "utf8")).sandboxes.alpha;

    expect(readSandbox()).toEqual({
      name: "alpha",
      model: "old-model",
      provider: "old-provider",
      agentVersion: "2026.5.18",
    });

    const helpers = makeHelpers({ dockerDriverEnabled: true });
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
    expect(registry.getSandbox("legacy")?.gatewayName).toBeUndefined();

    const helpers = makeHelpers({ dockerDriverEnabled: true });
    helpers.updateReusedSandboxMetadata("legacy", null, "m2", "p2", 8081);

    expect(registry.getSandbox("legacy")?.gatewayName).toBe("nemoclaw");
  });

  it("preserves an existing gatewayName binding on reuse", () => {
    // Once a sandbox carries an explicit binding, reuse must not overwrite it
    // — that protects per-sandbox bindings from being clobbered by the active
    // singleton when follow-up PRs flip the resolver to per-port names.
    registry.registerSandbox({ name: "alpha", gatewayName: "nemoclaw-8081" });

    const helpers = makeHelpers({ dockerDriverEnabled: true });
    helpers.updateReusedSandboxMetadata("alpha", null, "m", "p", 8090);

    expect(registry.getSandbox("alpha")?.gatewayName).toBe("nemoclaw-8081");
  });

  it("backfills using the active gateway name even when dashboardPort and gateway port differ", () => {
    // Regression guard: the helper used to call `getGatewayName(dashboardPort)`
    // which would derive a wrong binding once the resolver flips to per-port
    // names — `dashboardPort` is the chat-UI forward, not the gateway port.
    // The deps-injected `getActiveGatewayName()` must win.
    registry.registerSandbox({ name: "legacy", model: "m", provider: "p" });

    const helpers = makeHelpers({
      dockerDriverEnabled: true,
      activeGatewayName: "nemoclaw-8081",
    });
    // Pass a dashboardPort that is obviously not the gateway port (e.g. a UI
    // forward port like 9081). The migration must record the injected
    // gateway name, not anything derived from this port.
    helpers.updateReusedSandboxMetadata("legacy", null, "m", "p", 9081);

    expect(registry.getSandbox("legacy")?.gatewayName).toBe("nemoclaw-8081");
  });
});
