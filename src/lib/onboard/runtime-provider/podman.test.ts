// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createPodmanHostLocalInferenceTestHarness } from "../../../../test/helpers/podman-host-local-inference-test-harness";
import { startSandbox } from "../../actions/sandbox/start";
import { stopSandbox } from "../../actions/sandbox/stop";
import {
  createPodmanContainerEngine,
  type PodmanBoundContainerEngine,
  type PodmanContainerEngine,
  type PodmanExecutableAuthorityDeps,
  type PodmanExecutableStat,
  type PodmanSocketAuthority,
} from "../../adapters/podman";
import type { SandboxEntry } from "../../state/registry/types";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "./current";
import { createPodmanRuntimeProviderBundle } from "./podman";
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "./podman-lifecycle";
import {
  createRuntimeProviderBundleRegistry,
  requireRuntimeProviderHostLocalInferenceOperation,
} from "./registry";

const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const CONTAINER_ID = "a".repeat(64);
const AUTHORITY_ID = "test:podman-socket";
const REAL_SOCKET_AUTHORITY = {
  directoryChain: [],
  device: "8",
  inode: "9001",
  mode: "384",
  ownerUid: "1000",
  socketPath: "/run/user/1000/podman/podman.sock",
} as const satisfies PodmanSocketAuthority;
const PODMAN_EXECUTABLE_BYTES = Buffer.from("qualified-podman-binary", "utf8");
const SUCCESSFUL_RECOVERY = {
  checked: true,
  wasRunning: true,
  recovered: false,
  forwardRecovered: false,
} as const;

function podmanExecutableAuthorityDeps(): PodmanExecutableAuthorityDeps {
  const stat: PodmanExecutableStat = {
    dev: 8n,
    ino: 42n,
    mode: 0o100755n,
    uid: 0n,
    size: BigInt(PODMAN_EXECUTABLE_BYTES.byteLength),
    mtimeNs: 1000n,
    ctimeNs: 2000n,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const directoryStat: PodmanExecutableStat = {
    ...stat,
    ino: 43n,
    mode: 0o40755n,
    size: 0n,
    isDirectory: () => true,
    isFile: () => false,
  };
  return {
    uid: 1000,
    lstat: (filePath) => (filePath === "/usr/bin/podman" ? stat : directoryStat),
    readFile: () => PODMAN_EXECUTABLE_BYTES,
    realpath: (filePath) => filePath,
  };
}

function realOperationEngines(socketAuthority: PodmanSocketAuthority = REAL_SOCKET_AUTHORITY) {
  const common = {
    socketAuthority,
    executable: "/usr/bin/podman",
    assertAuthority: vi.fn(),
    capture: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
  } as const;
  return {
    hostDoctor: createPodmanContainerEngine({ ...common, operation: "host-doctor" }),
    hostLocalInference: createPodmanContainerEngine({
      ...common,
      operation: "host-local-inference",
      executableAuthorityDeps: podmanExecutableAuthorityDeps(),
    }),
    sandboxLifecycle: createPodmanContainerEngine({
      ...common,
      operation: "sandbox-lifecycle",
    }),
    stateMutation: createPodmanContainerEngine({
      ...common,
      operation: "state-mutation",
      executableAuthorityDeps: podmanExecutableAuthorityDeps(),
    }),
  };
}

function hostDoctorEngine(authorityId = AUTHORITY_ID): PodmanContainerEngine {
  return {
    operation: "host-doctor",
    engineId: "podman",
    displayName: "Podman",
    authorityId,
    endpointAuthorityId: authorityId,
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

function lifecycleEngine(sandboxName: string, authorityId = AUTHORITY_ID): PodmanContainerEngine {
  let running = false;
  const sandboxId = `id-${sandboxName}`;
  const containerName = `${PODMAN_SANDBOX_CONTAINER_PREFIX}${sandboxName}-${sandboxId}`;
  return {
    operation: "sandbox-lifecycle",
    engineId: "podman",
    displayName: "Podman",
    authorityId,
    endpointAuthorityId: authorityId,
    capture: vi.fn((args: readonly string[]) => {
      const operation = String(args[0]);
      switch (operation) {
        case "ps":
          return {
            status: 0,
            stdout: `${CONTAINER_ID}\n`,
            stderr: "",
          };
        case "container":
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                Id: CONTAINER_ID,
                Name: containerName,
                Config: {
                  Labels: {
                    [PODMAN_MANAGED_LABEL]: "true",
                    [PODMAN_SANDBOX_ID_LABEL]: sandboxId,
                    [PODMAN_SANDBOX_NAME_LABEL]: sandboxName,
                    [PODMAN_SANDBOX_NAMESPACE_LABEL]: PODMAN_SANDBOX_NAMESPACE,
                    [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
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
  const sandboxName = agent === "langchain-deepagents-code" ? "dcode-podman" : `${agent}-podman`;
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
  it.each(AGENTS)(
    "runs basic CPU start and stop for %s through an injected bundle",
    async (agent) => {
      const runtime = providerHarness(agent);
      const verifyGateway = vi.fn(async () => undefined);
      const restoreStartupState = vi.fn(() => SUCCESSFUL_RECOVERY);
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
    },
  );

  it("reports a failed gateway probe after the exact Podman container starts", async () => {
    const runtime = providerHarness("openclaw");
    const gatewayFailure = new Error("independent gateway probe failed");
    const verifyGateway = vi.fn(async () => Promise.reject(gatewayFailure));

    await expect(
      startSandbox(runtime.sandboxName, {
        getSandbox: () => runtime.entry,
        runtimeProviders: runtime.providers,
        restoreStartupState: vi.fn(() => SUCCESSFUL_RECOVERY),
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

  it("declares read-only host mounts unsupported until Podman qualification lands", () => {
    const runtime = providerHarness("openclaw");

    expect(runtime.providers.podman?.capabilities.readOnlyHostMounts).toEqual({
      supported: false,
      reason: "Read-only host mounts are not qualified for the Podman runtime provider.",
    });
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
      reason: "Podman host-local inference remains disabled without injected candidate authority.",
    });
    expect(() =>
      requireRuntimeProviderHostLocalInferenceOperation(bundle, "llama-cpp", { env: {} }),
    ).toThrow(
      "Runtime provider 'podman' does not provide the host-local-inference capability required for llama-cpp: Podman host-local inference remains disabled without injected candidate authority.",
    );
    expect(hostDoctor.capture).not.toHaveBeenCalled();
    expect(hostDoctor.captureHost).not.toHaveBeenCalled();
    expect(sandboxLifecycle.capture).not.toHaveBeenCalled();
  });

  it("exposes only the injected Ollama, NIM, and vLLM candidate operation", () => {
    const inference = createPodmanHostLocalInferenceTestHarness({ authorityId: AUTHORITY_ID });
    const bundle = createPodmanRuntimeProviderBundle({
      engines: {
        hostDoctor: hostDoctorEngine(),
        hostLocalInference: inference.engine,
        sandboxLifecycle: lifecycleEngine("candidate"),
      },
      hostLocalInference: {
        authorityStore: inference.authorityStore,
        routeAuthorityStore: inference.routeAuthorityStore,
        onFailureEvidence: inference.onFailureEvidence,
        redactSensitive: inference.redactSensitive,
      },
    });

    expect(bundle.capabilities.hostLocalInference).toBe(true);
    expect(bundle.hostLocalInference).toMatchObject({
      providerId: "podman",
      supported: true,
      services: ["ollama", "nim", "vllm"],
    });
    const operation = requireRuntimeProviderHostLocalInferenceOperation(bundle, "nim", {
      env: inference.env,
    });
    expect(operation).toMatchObject({
      providerId: "podman",
      bindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      engine: {
        authorityId: inference.engine.authorityId,
        endpointAuthorityId: inference.engine.endpointAuthorityId,
      },
    });
    expect(operation.managedRuntime?.services).toEqual(["ollama", "nim", "vllm"]);
    expect(() =>
      requireRuntimeProviderHostLocalInferenceOperation(bundle, "llama-cpp", {
        env: inference.env,
      }),
    ).toThrow("service 'llama-cpp' is not enabled");
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES).not.toHaveProperty("podman");
  });

  it("composes real operation engines on one socket without dropping executable authority", () => {
    const inference = createPodmanHostLocalInferenceTestHarness();
    const engines = realOperationEngines();
    const bundle = createPodmanRuntimeProviderBundle({
      engines,
      hostLocalInference: {
        authorityStore: inference.authorityStore,
        routeAuthorityStore: inference.routeAuthorityStore,
        onFailureEvidence: inference.onFailureEvidence,
        redactSensitive: inference.redactSensitive,
      },
    });

    expect(engines.hostDoctor.endpointAuthorityId).toBe(
      engines.hostLocalInference.endpointAuthorityId,
    );
    expect(engines.sandboxLifecycle.endpointAuthorityId).toBe(
      engines.hostLocalInference.endpointAuthorityId,
    );
    expect(engines.stateMutation.endpointAuthorityId).toBe(
      engines.hostLocalInference.endpointAuthorityId,
    );
    expect(engines.hostLocalInference.authorityId).not.toBe(engines.hostDoctor.authorityId);
    expect(engines.stateMutation.authorityId).not.toBe(engines.hostDoctor.authorityId);
    expect(bundle).toMatchObject({
      capabilities: { hostLocalInference: true },
      hostLocalInference: {
        providerId: "podman",
        supported: true,
      },
      stateMutation: {
        providerId: "podman",
        supported: true,
      },
      containerEngine: {
        providerId: "podman",
        supported: true,
        identities: expect.arrayContaining([
          {
            operation: "state-mutation",
            engineId: "podman",
            displayName: "Podman",
          },
        ]),
      },
    });
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES).not.toHaveProperty("podman");
  });

  it("rejects real operation engines when one socket endpoint drifts", () => {
    const engines = realOperationEngines();
    const inference = createPodmanHostLocalInferenceTestHarness();
    const driftedLifecycle = realOperationEngines({
      ...REAL_SOCKET_AUTHORITY,
      inode: "9002",
    }).sandboxLifecycle;

    expect(() =>
      createPodmanRuntimeProviderBundle({
        engines: { ...engines, sandboxLifecycle: driftedLifecycle },
        hostLocalInference: {
          authorityStore: inference.authorityStore,
          routeAuthorityStore: inference.routeAuthorityStore,
          onFailureEvidence: inference.onFailureEvidence,
          redactSensitive: inference.redactSensitive,
        },
      }),
    ).toThrow("same endpoint authority");
  });

  it("rejects a state-mutation engine with another operation scope", () => {
    const { hostLocalInference: _hostLocalInference, ...engines } = realOperationEngines();

    expect(() =>
      createPodmanRuntimeProviderBundle({
        engines: {
          ...engines,
          stateMutation: engines.sandboxLifecycle as PodmanBoundContainerEngine,
        },
      }),
    ).toThrow("'state-mutation' Podman engine");
  });

  it("rejects a state-mutation engine bound to another endpoint authority", () => {
    const { hostLocalInference: _hostLocalInference, ...engines } = realOperationEngines();
    const driftedStateMutation = realOperationEngines({
      ...REAL_SOCKET_AUTHORITY,
      inode: "9002",
    }).stateMutation;

    expect(() =>
      createPodmanRuntimeProviderBundle({
        engines: { ...engines, stateMutation: driftedStateMutation },
      }),
    ).toThrow("same endpoint authority");
  });

  it("rejects state-mutation options without a state-mutation engine", () => {
    const {
      hostLocalInference: _hostLocalInference,
      stateMutation: _stateMutation,
      ...engines
    } = realOperationEngines();

    expect(() =>
      createPodmanRuntimeProviderBundle({
        engines,
        stateMutation: {},
      }),
    ).toThrow("state-mutation engine with its options");
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
