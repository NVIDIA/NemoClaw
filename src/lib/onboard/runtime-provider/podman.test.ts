// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { startSandbox } from "../../actions/sandbox/start";
import { stopSandbox } from "../../actions/sandbox/stop";
import type { ContainerEngine } from "../../adapters/container-engine";
import type { SandboxEntry } from "../../state/registry/types";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "./current";
import { createPodmanRuntimeProviderBundle } from "./podman";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
} from "./podman-lifecycle";
import {
  createRuntimeProviderBundleRegistry,
  requireRuntimeProviderHostLocalInferenceOperation,
} from "./registry";

const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const CONTAINER_ID = "a".repeat(64);
const AUTHORITY_ID = "test:podman-socket";

function hostDoctorEngine(authorityId = AUTHORITY_ID): ContainerEngine {
  return {
    operation: "host-doctor",
    engineId: "podman",
    displayName: "Podman",
    authorityId,
    capture: vi.fn((args: readonly string[]) => {
      switch (args[0]) {
        case "version":
          return {
            status: 0,
            stdout: JSON.stringify({ Server: { Version: "5.6.2" } }),
            stderr: "",
          };
        case "info":
          return {
            status: 0,
            stdout: JSON.stringify({
              host: {
                arch: "amd64",
                os: "linux",
                cgroupVersion: "v2",
                networkBackend: "netavark",
                security: { rootless: true },
              },
            }),
            stderr: "",
          };
        default:
          return { status: 125, stdout: "", stderr: "unexpected command" };
      }
    }),
    captureHost: vi.fn((args: readonly string[]) => ({
      status: 0,
      stdout: args[0] === "--version" ? "podman version 5.6.2\n" : "0 1000 1\n1 100000 65536\n",
      stderr: "",
    })),
  };
}

function lifecycleEngine(sandboxName: string, authorityId = AUTHORITY_ID): ContainerEngine {
  let running = false;
  return {
    operation: "sandbox-lifecycle",
    engineId: "podman",
    displayName: "Podman",
    authorityId,
    capture: vi.fn((args: readonly string[]) => {
      const operation = String(args[0]);
      switch (operation) {
        case "ps":
          return {
            status: 0,
            stdout: `${CONTAINER_ID}\t${PODMAN_SANDBOX_CONTAINER_PREFIX}${sandboxName}\n`,
            stderr: "",
          };
        case "container":
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                Id: CONTAINER_ID,
                Name: `${PODMAN_SANDBOX_CONTAINER_PREFIX}${sandboxName}`,
                Config: {
                  Labels: {
                    [PODMAN_MANAGED_LABEL]: "true",
                    [PODMAN_SANDBOX_ID_LABEL]: `id-${sandboxName}`,
                    [PODMAN_SANDBOX_NAME_LABEL]: sandboxName,
                    [PODMAN_SANDBOX_NAMESPACE_LABEL]: "default",
                  },
                },
                State: {
                  Running: running,
                  Paused: false,
                  Status: running ? "running" : "exited",
                },
              },
            ]),
            stderr: "",
          };
        case "start":
          running = true;
          return { status: 0, stdout: CONTAINER_ID, stderr: "" };
        case "stop":
          running = false;
          return { status: 0, stdout: CONTAINER_ID, stderr: "" };
        default:
          return { status: 125, stdout: "", stderr: `unexpected operation ${operation}` };
      }
    }),
    captureHost: vi.fn(),
  };
}

function providerHarness(agent: (typeof AGENTS)[number]) {
  const sandboxName = `${agent}-podman`;
  const lifecycle = lifecycleEngine(sandboxName);
  const bundle = createPodmanRuntimeProviderBundle({
    engines: { hostDoctor: hostDoctorEngine(), sandboxLifecycle: lifecycle },
    preflight: { platform: "linux", architecture: "x64" },
  });
  const providers = createRuntimeProviderBundleRegistry([["podman", bundle]]);
  const entry: SandboxEntry = {
    agent,
    name: sandboxName,
    openshellDriver: "podman",
  };
  return { entry, lifecycle, providers, sandboxName };
}

describe("dormant Podman runtime provider", () => {
  it.each(
    AGENTS,
  )("runs basic CPU start and stop for %s through an injected bundle", async (agent) => {
    const runtime = providerHarness(agent);
    const verifyGateway = vi.fn(async () => undefined);
    const restoreStartupState = vi.fn();
    const stopSandboxChannels = vi.fn();

    await expect(
      startSandbox(runtime.sandboxName, {
        getSandbox: () => runtime.entry,
        runtimeProviders: runtime.providers,
        restoreStartupState,
        verifyGateway,
        log: vi.fn(),
      }),
    ).resolves.toEqual({ exitCode: 0 });
    expect(
      stopSandbox(runtime.sandboxName, {
        getSandbox: () => runtime.entry,
        runtimeProviders: runtime.providers,
        stopSandboxChannels,
        teardownSandboxDashboardForward: vi.fn(),
        log: vi.fn(),
      }),
    ).toEqual({ exitCode: 0 });

    expect(restoreStartupState).toHaveBeenCalledExactlyOnceWith(runtime.sandboxName);
    expect(verifyGateway).toHaveBeenCalledExactlyOnceWith(runtime.sandboxName);
    expect(stopSandboxChannels).toHaveBeenCalledWith(
      runtime.sandboxName,
      expect.objectContaining({ channelStopTransport: "openshell" }),
    );
    expect(
      JSON.stringify((runtime.lifecycle.capture as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain("docker");
  });

  it("reports a failed gateway probe after the exact Podman container starts", async () => {
    const runtime = providerHarness("openclaw");
    const gatewayFailure = new Error("independent gateway probe failed");
    const verifyGateway = vi.fn(async () => Promise.reject(gatewayFailure));

    await expect(
      startSandbox(runtime.sandboxName, {
        getSandbox: () => runtime.entry,
        runtimeProviders: runtime.providers,
        restoreStartupState: vi.fn(),
        verifyGateway,
        log: vi.fn(),
      }),
    ).rejects.toBe(gatewayFailure);
    expect(verifyGateway).toHaveBeenCalledExactlyOnceWith(runtime.sandboxName);
    expect(
      (runtime.lifecycle.capture as ReturnType<typeof vi.fn>).mock.calls.some(
        ([args]) => (args as readonly string[])[0] === "start",
      ),
    ).toBe(true);
  });

  it("stays outside the production-selectable registry", () => {
    expect(Object.keys(CURRENT_RUNTIME_PROVIDER_BUNDLES)).toEqual(["docker", "kubernetes"]);
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES).not.toHaveProperty("podman");
  });

  it("fails host-local inference before probing either Podman operation scope", () => {
    const hostDoctor = hostDoctorEngine();
    const sandboxLifecycle = lifecycleEngine("unsupported");
    const bundle = createPodmanRuntimeProviderBundle({
      engines: { hostDoctor, sandboxLifecycle },
    });

    expect(bundle.capabilities.hostLocalInference).toBe(false);
    expect(bundle.hostLocalInference).toMatchObject({
      providerId: "podman",
      supported: false,
      reason: "Podman does not provide the managed llama.cpp host-local-inference lifecycle.",
    });
    expect(() =>
      requireRuntimeProviderHostLocalInferenceOperation(bundle, "llama-cpp", { env: {} }),
    ).toThrow(
      "Runtime provider 'podman' does not provide the host-local-inference capability required for llama-cpp: Podman does not provide the managed llama.cpp host-local-inference lifecycle.",
    );
    expect(hostDoctor.capture).not.toHaveBeenCalled();
    expect(hostDoctor.captureHost).not.toHaveBeenCalled();
    expect(sandboxLifecycle.capture).not.toHaveBeenCalled();
  });

  it("rejects a mismatched engine scope before bundle registration", () => {
    const doctor = hostDoctorEngine();
    expect(() =>
      createPodmanRuntimeProviderBundle({
        engines: { hostDoctor: doctor, sandboxLifecycle: doctor },
      }),
    ).toThrow("'sandbox-lifecycle' Podman engine");
  });

  it("rejects engines bound to different endpoint authorities", () => {
    expect(() =>
      createPodmanRuntimeProviderBundle({
        engines: {
          hostDoctor: hostDoctorEngine("test:doctor-socket"),
          sandboxLifecycle: lifecycleEngine("mismatched", "test:lifecycle-socket"),
        },
      }),
    ).toThrow("same endpoint authority");
  });
});
